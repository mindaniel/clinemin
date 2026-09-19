/**
 * The manager's system prompt.
 *
 * A manager session is not an agent that happens to delegate — it is an agent
 * with no hands. It cannot read a file or edit anything; the only thing it can
 * do is write messages to its workers and run a command to check their claims.
 * So it gets its own system prompt rather than the coding-agent one plus an
 * instruction to please delegate: a prompt that advertises `read_files` makes
 * the model reach for it, and on a web provider the turn then dies on a tool
 * call the session has no executor for.
 *
 * The framing is deliberately human: the manager is told a person relays its
 * messages to other assistants and pastes the answers back. That is true from
 * the model's point of view, keeps it in prose (which web chat models are good
 * at) and away from their own native tool UI (which fails here), and costs
 * nothing in fidelity — `tool-pipeline/manager-block.ts` turns each block into
 * the delegation the runtime would have made anyway.
 *
 * ## Workers are addressed by model name
 *
 * A manager picks the model it wants for a job, so the roster is short model
 * names — `qwen`, `deepseek`, `gemini` — not invented worker names and not the
 * `-web` provider ids. One less mapping for the manager to hold, and the name
 * says what the worker actually is.
 */

export interface ManagerWorkerSummary {
	agentId: string;
	/**
	 * Named connection profile this worker runs on.
	 *
	 * The manager never sees credentials, but it does need to know that two
	 * workers on one provider are two accounts and not a duplicate — otherwise
	 * it reads `deepseek-work` and `deepseek-personal` as one worker listed
	 * twice and stops using the second.
	 */
	profile?: string;
	providerId?: string;
	modelId?: string;
	/** First line of the worker's role prompt, as a hint about what it is for. */
	description?: string;
	/**
	 * A one-line hint the user wrote about this worker — "fast, good at code",
	 * "web search only, not coding". Printed next to the name in the roster so
	 * the manager picks on something better than a bare name.
	 */
	notes?: string;
	/** Tool names this worker may use, or undefined when it is unrestricted. */
	tools?: string[];
}

export interface ManagerSystemPromptOptions {
	workers?: ManagerWorkerSummary[];
	workspaceRoot?: string;
	platform?: string;
	/** Extra instructions from the user, appended verbatim. */
	rules?: string;
}

/**
 * Short name for a provider: `qwen-web` -> `qwen`, `deepseek-web-v2` ->
 * `deepseek`.
 *
 * A manager is choosing a model, not a transport. The `-web` suffix says how
 * the CLI drives it, which is nothing the manager can act on, and the version
 * suffix is worse — it invites `TO: deepseek-web` for a worker registered as
 * `deepseek-web-v2`.
 */
export function shortProviderName(providerId: string): string {
	return providerId.trim().replace(/-web(-v\d+)?$/i, "") || providerId.trim();
}

/**
 * How a worker is addressed on a `TO:` line.
 *
 * This has to be the id the runtime dispatches on, so it is `agentId` and not a
 * prettier version of it: a roster showing a name that does not dispatch is the
 * one failure the manager cannot diagnose from its side.
 */
function workerName(worker: ManagerWorkerSummary): string {
	return worker.agentId;
}

function formatWorkerLine(worker: ManagerWorkerSummary): string {
	// No tool scope here on purpose. What a worker may do is the manager's call,
	// made per job on a TOOLS: line — printing a fixed set from the roster reads
	// as a permanent fact and stops it from asking for more.
	//
	// The note is the one exception, because it is the opposite kind of fact:
	// the user wrote it precisely so the manager would route jobs by it, and it
	// is collapsed to a single line so a long note cannot turn the roster into
	// the bulk of the prompt.
	const note = worker.notes?.replace(/\s+/g, " ").trim();
	return note ? `- ${workerName(worker)} — ${note}` : `- ${workerName(worker)}`;
}

/**
 * Do two workers run on the same model behind different accounts?
 *
 * Worth telling the manager, because the roster then contains names that look
 * like near-duplicates — `deepseek-work`, `deepseek-personal` — and a model
 * that reads them as one worker listed twice will only ever use the first,
 * which throws away exactly the concurrency the second profile was created for.
 */
function hasSharedProviders(workers: ManagerWorkerSummary[]): boolean {
	const seen = new Set<string>();
	for (const worker of workers) {
		const provider = worker.providerId;
		if (!provider) continue;
		if (seen.has(provider)) return true;
		seen.add(provider);
	}
	return false;
}

export const MANAGER_DONE_TOKEN = "TEAM DONE";

/**
 * The placeholder bodies used by the worked examples below.
 *
 * These are exported because the parser has to recognise them. A web provider
 * is handed this whole prompt as chat text, and some models answer by repeating
 * their instructions back — Kimi did, in full. The examples are then
 * indistinguishable from a real delegation, so `parseManagerBlocks` dispatched
 * "Your message here." to a worker twice and ran `Get-Content src/foo.ts` as a
 * real command. Nothing in the reply said "this is a copy of your own prompt".
 *
 * Recognising them by shared constant rather than by a literal in the parser is
 * the point: an example edited here and not there would silently re-open the
 * hole. See `isManagerPromptExample` in
 * `llms/providers/vendors/tool-pipeline/manager-block.ts`.
 */
export const MANAGER_EXAMPLE_BODY = "Your message here.";
export const MANAGER_EXAMPLE_COMMAND = "Get-Content src/foo.ts -TotalCount 20";

export function buildManagerSystemPrompt(
	options: ManagerSystemPromptOptions = {},
): string {
	const workers = options.workers ?? [];
	const roster = workers.length
		? workers.map(formatWorkerLine).join("\n")
		: "- (none yet — the roster in .cline/team.json is empty)";
	const example = workers[0] ? workerName(workers[0]) : "qwen";

	const sections = [
		`I have a few AI assistants working for me. You are the manager. Everything goes through me: I relay your messages to them and paste their replies back.

My assistants, addressed by the name shown here:
${roster}

They can't see this conversation and they can't see each other. Spell each job
out in full: the goal, what they're working from, and what the answer should
look like.${
			hasSharedProviders(workers)
				? `

Some of them run the same model on separate accounts. Those are different
assistants with their own conversations, not one listed twice — give them
different jobs and they work at the same time.`
				: ""
		}`,
		`Send a message like this. I copy what's inside straight to the assistant,
so anything outside the block is for me:

<manager>
TO: ${example}
${MANAGER_EXAMPLE_BODY}
</manager>

\`</manager>\` goes alone on its own line. One assistant per block; several
blocks in one reply is fine, and they run in order.`,
		`Each assistant can only use the tools you give it, granted on a TOOLS: line:

<manager>
TO: ${example}
TOOLS: run_commands
${MANAGER_EXAMPLE_BODY}
</manager>

Grant these two:
- \`run_commands\` — PowerShell commands. Reading files, searching the code
  (\`Select-String\`, \`Get-ChildItem\`), running builds and tests all go here.
- \`apply_patch\` — editing files.

Your assistants already know how to use both. \`TOOLS: run_commands\` is for
looking; add \`apply_patch\` only when you want them to change files. Other tools
(\`read_files\`, \`search_codebase\`, \`editor\`) exist but are a last resort: don't
grant them unless PowerShell can't do the job. You can also tell an assistant to
search the web. A grant lasts until you change it, so send a TOOLS: line only
when the answer changes. An assistant asked to look something up and handed
\`apply_patch\` may decide to fix what it finds, and you will not know until it
has. \`TOOLS: none\` leaves an assistant able to talk to you and nothing else.`,
		`To check something yourself, send me PowerShell commands to do that, and I
will paste you the results:

\`\`\`powershell
${MANAGER_EXAMPLE_COMMAND}
\`\`\`

A command is stopped after 120 seconds; write \`\`\`powershell -timeout 600 for
longer (max 3600), or \`\`\`powershell -echo to run it in the background and get
the output pasted back when it finishes.

Keep those read-only. Looking is yours; changing is theirs. An assistant
reporting on its own work is not evidence.`,
	];

	const workspaceRoot = options.workspaceRoot?.trim();
	if (workspaceRoot) {
		sections.push(
			`Your assistants work in this folder${
				options.platform ? ` on ${options.platform}` : ""
			}, and you do not — write paths the way they would find them from there:

${workspaceRoot}`,
		);
	}

	sections.push(
		`Every reply you send me is either one or more <manager> blocks, or your
final answer ending with ${MANAGER_DONE_TOKEN}. A reply that is only a status
line — "Starting with ${example}" and nothing under it — leaves me nothing to
pass on and the job stops dead.

If an assistant says what it is *going* to do instead of showing it done, write
again and say what is still missing. If it claims something you cannot check,
ask for the proof: the line it read, the command it ran, the output it got.
Their replies also say how much of their context they have used; past about 80%,
start someone fresh and hand over what they produced.`,
	);

	const rules = options.rules?.trim();
	if (rules) {
		sections.push(rules);
	}

	return sections.join("\n\n");
}
