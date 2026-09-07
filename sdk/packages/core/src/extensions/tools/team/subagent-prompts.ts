import { buildClineSystemPrompt, isWebChatProvider } from "@cline/shared";
import type { DelegatedAgentRuntimeConfig } from "./delegated-agent";

/**
 * The contract that makes "done" observable to the lead.
 *
 * A teammate that ends its turn with prose looks identical, from the outside,
 * to one that finished the job: both surface as `finishReason: "completed"`.
 * Requiring an explicit completion tool call turns that ambiguity into a fact
 * the lead can check — see `diagnoseRun` in `team-tools.ts`, which reports any
 * run lacking one as `stoppedWithoutCompletion`.
 *
 * This is appended for every provider, not just Cline. Teammates on providers
 * without native tool calling are the ones that most often stop on a sentence
 * like "Let me continue" — or on a tool call their provider's parser dropped —
 * so they need the rule more, not less.
 */
const TEAMMATE_COMPLETION_CONTRACT_HEADING = "# Finishing a delegated task";

const TEAMMATE_COMPLETION_CONTRACT = `${TEAMMATE_COMPLETION_CONTRACT_HEADING}

Plain text does NOT end your task. Your reply is only treated as finished when
you call a completion tool: \`team_task\` with action=complete (preferred, when
you were given a taskId), \`attempt_completion\`, or \`submit_and_exit\`.

- More work to do? Call a tool. Never stop on a sentence like "Let me continue"
  — that ends your run with the job half done, and the lead has to restart you.
- Done? Call the completion tool with a summary of what you produced.
- Need a decision only your manager can make? Call \`ask_question\` with 2-5
  options. That ends your turn and hands the question up; the answer comes
  back as your next instruction. Do not guess, and do not ask for anything
  you could find out yourself.
- Blocked? Use \`team_task\` action=block with a reason, or message the lead
  with \`team_send_message\`. Do not stop silently.
- Tool call rejected as malformed? Re-send it in the exact format the error
  describes. Do not fall back to describing the call in prose.`;

/**
 * A marker that appears in every prompt this function builds.
 *
 * A spawned teammate's built system prompt is what gets persisted as its
 * `rolePrompt`, and restoring replays that back through here. Without a check,
 * a restored worker gets the whole tool protocol wrapped around itself once per
 * restart.
 */
const BUILT_PROMPT_MARKER = "# CRITICAL TOOL CALLING PROTOCOL";

export function buildTeammateSystemPrompt(
	prompt: string,
	config: DelegatedAgentRuntimeConfig,
): string {
	const basePrompt = prompt.trim();
	if (basePrompt.includes(BUILT_PROMPT_MARKER)) {
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
			}),
			`# Team Teammate Role\n${trimmedPrompt}`,
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
		rules: `# Team Teammate Role\n${trimmedPrompt}`,
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
