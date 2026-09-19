import { getWebProviderPrompts } from "@cline/llms";
import { buildClineSystemPrompt, isWebChatProvider } from "@cline/shared";
import type { DelegatedAgentRuntimeConfig } from "./delegated-agent";

/**
 * The contract that makes "done" observable to the lead.
 *
 * A teammate finishes by writing its report as ordinary text. That is a change:
 * this used to demand an explicit completion tool call, on the theory that a run
 * ending in prose is indistinguishable from one that finished. The theory was
 * right and the rule was still wrong, because none of the three tools it named
 * were reachable from a scoped worker — `attempt_completion` is not defined
 * anywhere in this codebase, `submit_and_exit` is off in every preset, and
 * `team_task` action=complete requires a `taskId` that `team_run_task` does not
 * have to supply. So every worker obeyed, emitted a call for a tool it did not
 * hold, had it rejected, and was reported to its manager as having stopped
 * early. A contract no worker can satisfy is not a guard; it is a permanent
 * false alarm that teaches the manager to ignore the field.
 *
 * The ambiguity it was guarding against is handled where the evidence actually
 * is — see `diagnoseRun` in `team-tools.ts`, which now distinguishes a run that
 * reported something from one that ended empty, and separately flags a reply
 * still carrying an unparsed tool call.
 *
 * This is appended for every provider, not just Cline. Teammates on providers
 * without native tool calling are the ones that most often stop on a sentence
 * like "Let me continue", so they need the rule more, not less.
 */
const TEAMMATE_COMPLETION_CONTRACT_HEADING = "# Finishing a delegated task";

const TEAMMATE_COMPLETION_CONTRACT = `${TEAMMATE_COMPLETION_CONTRACT_HEADING}

You finish by writing your report as plain text. There is no "I am done" tool to
call: when you stop calling tools, your last message IS the answer your manager
reads, so it has to stand on its own.

- Done? End with the report itself: what you found or changed, with file:line
  for every claim, and anything you could not do. Do not end with a bare
  acknowledgement like "Done" or "Task complete" — that tells your manager
  nothing and it will send the work straight back.
- More work to do? Call the next tool. Never stop on a sentence like "Let me
  continue" or "I'll check that next" — nothing runs after your turn ends, so
  that ends your run with the job half done and your manager has to restart you.
- Need a decision only your manager can make? Call \`ask_question\` with 2-5
  options. That ends your turn and hands the question up; the answer comes
  back as your next instruction. Do not guess, and do not ask for anything
  you could find out yourself.
- Blocked? Say so in your report, in the first line, with the reason. Do not
  stop silently and do not pad a blocked run out into something that reads like
  a result.
- Tool call rejected as malformed? Re-send it in the exact format the error
  describes. Do not describe the call in prose and do not write a tool call out
  as text in your report — text is a report, not a call, and nothing will run it.`;

/**
 * The heading this function stamps around a worker's role prompt.
 *
 * Doubles as the idempotency marker, because it is the one thing present in
 * every prompt this function builds — see `isBuiltTeammatePrompt`.
 */
const TEAMMATE_ROLE_HEADING = "# Team Teammate Role";

/**
 * A marker that appears in every prompt built from the tool-calling contract.
 *
 * Kept because worker prompts persisted before the web providers moved off that
 * contract still carry it, and a restored worker must still be recognised as
 * already built.
 */
const BUILT_PROMPT_MARKER = "# CRITICAL TOOL CALLING PROTOCOL";

/**
 * Has this prompt already been through here?
 *
 * A spawned teammate's built system prompt is what gets persisted as its
 * `rolePrompt`, and restoring replays that back through this function. Without
 * a check, a restored worker gets the whole provider prompt wrapped around
 * itself once per restart — and it compounds, because each restart persists the
 * larger prompt for the next one to grow again.
 *
 * Testing only for the tool-calling contract was enough while every built
 * prompt contained it. It stopped being enough when the web providers moved
 * their `worker` slot to `SIMPLE_WEB_SYSTEM_PROMPT`, which has no such heading:
 * a DeepSeek worker's prompt went 3.2k → 5.1k characters on its first restart,
 * carrying two copies of the patch grammar and two copies of its own role. The
 * role heading is the reliable marker because this function stamps it on every
 * branch that builds anything.
 */
function isBuiltTeammatePrompt(prompt: string): boolean {
	return (
		prompt.includes(BUILT_PROMPT_MARKER) ||
		prompt.includes(TEAMMATE_ROLE_HEADING)
	);
}

export function buildTeammateSystemPrompt(
	prompt: string,
	config: DelegatedAgentRuntimeConfig,
): string {
	const basePrompt = prompt.trim();
	if (isBuiltTeammatePrompt(basePrompt)) {
		return basePrompt;
	}
	// Appending unconditionally would stack another copy of the contract on
	// every restart of a teammate whose prompt is not a built one.
	const trimmedPrompt = basePrompt.includes(
		TEAMMATE_COMPLETION_CONTRACT_HEADING,
	)
		? basePrompt
		: `${basePrompt}\n\n${TEAMMATE_COMPLETION_CONTRACT}`;

	// A worker on a web chat provider needs the same prompt an ordinary session
	// on that provider gets. Its tool definitions live in that prompt text and
	// nowhere else — there is no function-calling API behind a scraped chat — so
	// a worker handed only its role prompt knows the job but has no way to do
	// any of it.
	//
	// The role prompt cannot ride in the `rules` slot here: that slot is dropped
	// for web providers on purpose, because a lead does not need project rules.
	//
	// Project rules are NOT appended here either. A teammate inherits the
	// session's extensions, and the user-instruction extension already appends
	// them when the runtime composes the prompt — adding them here put the whole
	// of AGENTS.md and .clinerules into every worker's prompt twice.
	if (isWebChatProvider(config.providerId)) {
		return [
			buildClineSystemPrompt({
				ide: config.clineIdeName?.trim() || "Terminal",
				workspaceRoot: config.cwd?.trim() || "/",
				providerId: config.providerId,
				platform: config.clinePlatform,
				metadata: config.workspaceMetadata,
				// Only the tools this worker was granted. A scraped chat has no
				// function-calling API, so this text IS its tool list: documenting
				// one it cannot call guarantees it calls it and burns the turn on
				// a rejection it cannot diagnose.
				tools: config.tools,
				// This is the one call site that knows a session is a worker, so it
				// is the only one that has to say so. A provider with no `worker`
				// override is unaffected.
				role: "worker",
				prompts: getWebProviderPrompts(config.providerId),
			}),
			`${TEAMMATE_ROLE_HEADING}\n${trimmedPrompt}`,
		]
			.filter(Boolean)
			.join("\n\n");
	}

	if (config.providerId.toLowerCase() !== "cline") {
		return trimmedPrompt;
	}

	return buildClineSystemPrompt({
		ide: config.clineIdeName?.trim() || "Terminal",
		workspaceRoot: config.cwd?.trim() || "/",
		providerId: config.providerId,
		rules: `${TEAMMATE_ROLE_HEADING}\n${trimmedPrompt}`,
		tools: config.tools,
		platform: config.clinePlatform,
		metadata: config.workspaceMetadata,
	});
}

export function buildSubAgentSystemPrompt(
	// The prompt provided when spawning the subagent
	prompt: string,
	config: DelegatedAgentRuntimeConfig,
): string {
	const trimmedPrompt = prompt.trim();
	if (config.providerId.toLowerCase() !== "cline") {
		return trimmedPrompt;
	}

	return buildClineSystemPrompt({
		ide: config.clineIdeName || "Terminal",
		workspaceRoot: config.cwd?.trim() || "/",
		providerId: config.providerId,
		overridePrompt: trimmedPrompt,
		metadata: config.workspaceMetadata,
		platform: config.clinePlatform,
	});
}
