/**
 * `<manager>` blocks: delegation written as prose.
 *
 * A lead agent on a web provider cannot be given the team tools the same way an
 * API model can. Its system prompt is the stripped-down web-provider one, and
 * pushing it toward the `<tool>` contract makes it reach for capabilities it
 * does not have — it tries to read files itself, and the turn dies. What works
 * instead is to tell it that a human is relaying messages to other assistants
 * by hand, and have it write those messages as plain text:
 *
 *     <manager>
 *     TO: extractor
 *     Find every line containing "kanban" and report file:line for each.
 *     </manager>
 *
 * The model stays in prose mode, which is what it is good at, and this module
 * turns each block into the `team_run_task` call the runtime would have made
 * anyway. The "human relay" is real from the model's point of view and
 * automatic in fact.
 *
 * ## Why the closing tag must own its line
 *
 * The body is free text written by a model, and a manager describing this very
 * format will write `</manager>` inside a message. A scanner that stops at the
 * first `</manager>` anywhere would truncate that block and leak the rest as
 * prose — the same defect that made `<tool>` blocks fail whenever a payload
 * contained the closing tag (see `tool-block-scanner.ts`).
 *
 * A JSON envelope cannot help here, because the body is not JSON. So the
 * terminator is positional instead: the first line that consists only of
 * `</manager>`. Prose almost never puts it there alone, and when a manager
 * needs to talk about the tag it writes it inline, where it is ignored.
 */

import {
	MANAGER_DONE_TOKEN,
	MANAGER_EXAMPLE_BODY,
	MANAGER_EXAMPLE_COMMAND,
} from "@cline/shared";
import { parseShellFenceFlags } from "./shell-fence";

const OPEN_TAG_RE = /^[ \t]*<\s*manager\s*>[ \t]*\r?$/im;
const CLOSE_LINE_RE = /^[ \t]*<\s*\/\s*manager\s*>[ \t]*$/;
// A manager's own hands: PowerShell it runs to check a worker's claim rather
// than taking the worker's word for it.
//
// This used to be a `<verify>` tag. It is a fenced code block now because that
// is what a chat model writes when you ask it for a command — the smart web
// providers are already told "send me PowerShell commands to do that, and I
// will paste you the results" (see `simple-system-prompt.ts`), and a model
// following that instruction reaches for a fence, not for a tag it has to
// remember. One less piece of syntax to get wrong.
//
// The language tag is required. A bare ``` fence is how a manager quotes a
// worker's output or shows an example, and running those would be a disaster.
//
// The accepted tags mirror `CLAUDE_SHELL_FENCE_LANGS` in `claude-web.ts`: a
// manager told to send PowerShell still writes ```bash sometimes, and bouncing
// that back over the tag teaches nothing. The output comes back to it through
// the same tool-result path either way ("Here is the output of the command I
// just ran:").
const SHELL_FENCE_OPEN_RE =
	/^[ \t]*(?:`{3,}|~{3,})[ \t]*(?:powershell|pwsh|ps1|bash|shell|sh|zsh|cmd|bat|console|terminal)((?:[ \t]+[^\r\n]*)?)[ \t]*\r?$/im;
const SHELL_FENCE_CLOSE_LINE_RE = /^[ \t]*(?:`{3,}|~{3,})[ \t]*$/;
const HEADER_LINE_RE = /^[ \t]*(TO|TOOLS)[ \t]*:[ \t]*(.+?)[ \t]*$/i;

export interface ManagerBlock {
	/** Index of the `<` that opens the block. */
	start: number;
	/** Index just past the block, past the closing line when there is one. */
	end: number;
	/** Worker named on the `TO:` line, or undefined when it is missing. */
	agentId?: string;
	/**
	 * Tool names from a `TOOLS:` line — what this worker is allowed to do.
	 *
	 * A manager grants capability explicitly and visibly, rather than a worker
	 * having every tool by default and a role prompt asking it nicely not to
	 * edit. The grant persists until the manager sends another TOOLS: line.
	 */
	tools?: string[];
	/** Message for the worker: the body with the header lines removed. */
	task: string;
	/** True when no closing line was found and the block ran to end of text. */
	unterminated: boolean;
}

/**
 * Find the `<manager>` blocks in `text`, in order.
 *
 * Blocks cannot nest: a `<manager>` written inside a body is part of that
 * message, so scanning resumes past the end of each block rather than at the
 * next opening tag.
 */
export function scanManagerBlocks(text: string): ManagerBlock[] {
	const blocks: ManagerBlock[] = [];
	let cursor = 0;

	while (cursor < text.length) {
		const openMatch = OPEN_TAG_RE.exec(text.slice(cursor));
		if (!openMatch || openMatch.index === undefined) {
			break;
		}
		const openStart = cursor + openMatch.index;
		const bodyStart = openStart + openMatch[0].length;

		// Walk the body line by line looking for a line that is nothing but the
		// closing tag. Line offsets are tracked as we go so the block's extent is
		// exact, rather than re-derived by searching the text again.
		let lineStart = bodyStart;
		let bodyEnd = text.length;
		let blockEnd = text.length;
		let unterminated = true;

		while (lineStart <= text.length) {
			const newlineIndex = text.indexOf("\n", lineStart);
			const lineEnd = newlineIndex === -1 ? text.length : newlineIndex;
			const line = text.slice(lineStart, lineEnd).replace(/\r$/, "");
			if (CLOSE_LINE_RE.test(line)) {
				bodyEnd = lineStart;
				blockEnd = newlineIndex === -1 ? text.length : newlineIndex + 1;
				unterminated = false;
				break;
			}
			if (newlineIndex === -1) {
				break;
			}
			lineStart = newlineIndex + 1;
		}

		const body = text.slice(bodyStart, bodyEnd);
		blocks.push({
			start: openStart,
			end: blockEnd,
			...parseBlockHeaders(body),
			unterminated,
		});
		cursor = blockEnd;
	}

	return blocks;
}

/**
 * Split a `TOOLS:` line into tool names.
 *
 * Commas or spaces, and surrounding punctuation is tolerated — a model writing
 * `TOOLS: read_files, search_codebase` and one writing
 * `TOOLS: [read_files search_codebase]` mean the same thing, and bouncing the
 * second one back teaches nothing.
 */
function parseToolList(value: string | undefined): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	const names = value
		.split(/[,\s]+/)
		.map((name) => name.replace(/^[[("'`]+|[\])"'`.]+$/g, "").trim())
		.filter((name) => name.length > 0);
	// An explicit `TOOLS: none` is a real instruction: this worker gets nothing
	// but the team tools it needs to report back.
	if (names.length === 1 && names[0]?.toLowerCase() === "none") {
		return [];
	}
	return names.length > 0 ? names : undefined;
}

type BlockHeaders = Pick<ManagerBlock, "agentId" | "tools" | "task">;

/**
 * Pull the `TO:` and `TOOLS:` headers off the front of a body.
 *
 * Only a leading run of headers counts, and only these two keys. A `TO:`
 * further down is part of the message — treating it as the addressee would
 * silently redirect a block whose body happens to quote one — and a line like
 * `Note: ...` ends the header run rather than being swallowed as an unknown
 * header, so the first line of a message is never lost.
 */
function parseBlockHeaders(body: string): BlockHeaders {
	const lines = body.split("\n");
	const headers: Record<string, string> = {};
	let index = 0;
	let sawHeader = false;

	for (; index < lines.length; index++) {
		const line = (lines[index] ?? "").replace(/\r$/, "");
		if (!line.trim()) {
			// Blank lines before the first header are just spacing; a blank line
			// after one ends the header run.
			if (sawHeader) {
				index++;
				break;
			}
			continue;
		}
		const match = HEADER_LINE_RE.exec(line);
		if (!match) {
			break;
		}
		const key = (match[1] ?? "").toLowerCase();
		if (headers[key] === undefined) {
			headers[key] = (match[2] ?? "").trim();
		}
		sawHeader = true;
	}

	if (!sawHeader) {
		return { task: body.trim() };
	}

	// `TO:` names one worker, so anything after whitespace on that line is a
	// mistake rather than part of the id.
	const agentId = headers.to?.split(/\s+/)[0];
	return {
		agentId: agentId || undefined,
		tools: parseToolList(headers.tools),
		task: lines.slice(index).join("\n").trim(),
	};
}

export interface ManagerRunTask {
	name: "team_run_task";
	arguments: {
		agentId: string;
		task: string;
		runMode: "sync";
		continueConversation: boolean;
		tools?: string[];
	};
}

export interface ManagerVerify {
	name: "run_commands";
	arguments: { commands: string[]; timeout_seconds?: number; echo?: true };
}

export type ManagerDelegation = ManagerRunTask | ManagerVerify;

export interface ParsedManagerBlocks {
	/** The reply with every `<manager>` block removed. */
	cleanedContent: string;
	/** One delegation per well-formed block. */
	delegations: ManagerDelegation[];
	/**
	 * Human-readable problems with blocks that could not be dispatched, to be
	 * shown back to the manager so it can rewrite them.
	 */
	problems: string[];
}

/**
 * Turn a reply's `<manager>` blocks into delegations.
 *
 * Runs in `sync` mode: the manager wrote one instruction and expects the reply,
 * exactly as it would if a human were pasting it back. Dispatching async would
 * hand it a run id it has no idea what to do with.
 */
export interface ShellFenceBlock {
	start: number;
	end: number;
	/** The PowerShell inside the fence, verbatim. */
	command: string;
	/** `-timeout` / `-echo` written after the fence language. */
	flags: ReturnType<typeof parseShellFenceFlags>;
	unterminated: boolean;
}

/**
 * Find the PowerShell fences in `text`.
 *
 * Deliberately dumber than the manager scanner: no headers, no addressee. The
 * body is one command, because what a manager wants here is to see output with
 * its own eyes — a line count, a `git status`, a grep — not to compose a
 * script it then has to debug.
 */
export function scanShellFences(text: string): ShellFenceBlock[] {
	const blocks: ShellFenceBlock[] = [];
	let cursor = 0;

	while (cursor < text.length) {
		const openMatch = SHELL_FENCE_OPEN_RE.exec(text.slice(cursor));
		if (!openMatch || openMatch.index === undefined) {
			break;
		}
		const openStart = cursor + openMatch.index;
		const bodyStart = openStart + openMatch[0].length;

		let lineStart = bodyStart;
		let bodyEnd = text.length;
		let blockEnd = text.length;
		let unterminated = true;

		while (lineStart <= text.length) {
			const newlineIndex = text.indexOf("\n", lineStart);
			const lineEnd = newlineIndex === -1 ? text.length : newlineIndex;
			const line = text.slice(lineStart, lineEnd).replace(/\r$/, "");
			if (SHELL_FENCE_CLOSE_LINE_RE.test(line)) {
				bodyEnd = lineStart;
				blockEnd = newlineIndex === -1 ? text.length : newlineIndex + 1;
				unterminated = false;
				break;
			}
			if (newlineIndex === -1) {
				break;
			}
			lineStart = newlineIndex + 1;
		}

		blocks.push({
			start: openStart,
			end: blockEnd,
			command: text.slice(bodyStart, bodyEnd).trim(),
			flags: parseShellFenceFlags(openMatch[1]),
			unterminated,
		});
		cursor = blockEnd;
	}

	return blocks;
}

/**
 * Pull PowerShell fences out and turn each into a `run_commands` call.
 *
 * A manager has no file access on purpose, but "no access" and "has to believe
 * whatever a worker says" are different things. A worker once reported files
 * already deleted that were not, and the manager had no way to check. This is
 * the check: one command, output pasted back, same shell the workers use.
 */
function extractShellFences(text: string): ParsedManagerBlocks {
	const blocks = scanShellFences(text);
	if (blocks.length === 0) {
		return { cleanedContent: text, delegations: [], problems: [] };
	}

	const delegations: ManagerDelegation[] = [];
	const problems: string[] = [];
	const parts: string[] = [];
	let cursor = 0;

	for (const block of blocks) {
		parts.push(text.slice(cursor, block.start));
		cursor = block.end;

		if (block.unterminated) {
			problems.push(
				"A PowerShell block was never closed. Put ``` alone on its own line at the end of it.",
			);
			continue;
		}
		if (!block.command) {
			problems.push(
				"A PowerShell block was empty, so there was nothing to run.",
			);
			continue;
		}
		if (isManagerPromptExample(block.command)) {
			// The example command out of the manager's own prompt, echoed back.
			// See `isManagerPromptExample`.
			problems.push(ECHOED_PROMPT_PROBLEM);
			continue;
		}
		delegations.push({
			name: "run_commands",
			arguments: { commands: [block.command], ...block.flags },
		});
	}

	parts.push(text.slice(cursor));

	return {
		cleanedContent: parts.join("").trim(),
		delegations,
		problems,
	};
}

/**
 * The manager's sign-off, mirrored from `@cline/shared`'s prompt module.
 *
 * Copied rather than imported: nothing else in this file reaches into that
 * package, and the token is one string. `manager-block.test.ts` reads the
 * shared source back, so the copy cannot drift.
 */
// Shared with the prompt these blocks are written in answer to, so an edit
// there cannot leave this parser recognising a token the manager no longer
// sees. See `MANAGER_DONE_TOKEN` in shared/prompt/manager.ts.
const DONE_TOKEN = MANAGER_DONE_TOKEN;

/**
 * A fence with no language tag, capturing its body.
 *
 * Kept separate from `SHELL_FENCE_OPEN_RE` because these are deliberately NOT
 * run: an untagged fence is how a model quotes a worker's output back, shows an
 * example, or pastes a file, and executing those would be a disaster. This is
 * only for noticing one and asking for the tag.
 */
const UNTAGGED_FENCE_RE =
	/^[ \t]*(?:`{3,}|~{3,})[ \t]*\r?\n([\s\S]*?)^[ \t]*(?:`{3,}|~{3,})[ \t]*$/gm;

/**
 * PowerShell and shell commands start in a recognisable way: a `Verb-Noun`
 * cmdlet, a `$variable` assignment, or one of the binaries an agent actually
 * reaches for. Prose, JSON, quoted output and source code do not.
 *
 * This only decides whether to ASK for a language tag, never whether to run
 * anything, so a false positive costs one extra line in a retry prompt.
 */
const SHELL_FIRST_LINE_RE =
	/^(?:[A-Z][a-z]+-[A-Z][A-Za-z]+\b|\$[A-Za-z_]\w*\s*=|(?:cd|ls|dir|cat|type|git|npm|npx|bun|bunx|node|python|python3|pip|grep|rg|find|echo|mkdir|del|rm|cp|copy|mv|move|where|which|Get|Set|Select|Where|ForEach|Test|New|Remove)\b)/;

/**
 * Does this reply hold an untagged fence that is plainly a command?
 *
 * ChatGPT in particular writes the same request two ways from one turn to the
 * next — ```powershell one time and a bare ``` the next — so the same
 * instruction ran once and was silently ignored the next time. Rather than
 * loosening what gets executed, notice the shape and ask for the tag.
 */
function untaggedShellFenceNudge(text: string): string | undefined {
	// A reply carrying a patch is answered by the patch parser, which runs after
	// this one. Bouncing the turn here would send back "tag your fence" and the
	// edit would never be applied — and a model that pastes shell commands
	// alongside a patch is the normal case, not the exception.
	if (text.includes("*** Begin Patch")) {
		return undefined;
	}
	// EVERY untagged fence is checked, not just the first. ChatGPT routinely
	// opens a reply with an empty ``` pair and puts the real command in a second
	// fence below it. Stopping at the first match meant the empty body won, the
	// nudge returned nothing, and the command was dropped with no feedback at
	// all — the exact silent failure this function exists to prevent.
	UNTAGGED_FENCE_RE.lastIndex = 0;
	let match = UNTAGGED_FENCE_RE.exec(text);
	let found = false;
	while (match !== null) {
		const body = match[1]?.trim();
		const firstLine = body?.split("\n")[0]?.trim() ?? "";
		if (body && SHELL_FIRST_LINE_RE.test(firstLine)) {
			found = true;
			break;
		}
		match = UNTAGGED_FENCE_RE.exec(text);
	}
	UNTAGGED_FENCE_RE.lastIndex = 0;
	if (!found) {
		return undefined;
	}
	return (
		"That looks like a command, but its code fence has no language tag, so it " +
		"was not run. Send it again as ```powershell so I can run it — an " +
		"untagged fence is treated as quoted text on purpose."
	);
}

/**
 * True when this is a worked example copied out of the manager's own prompt.
 *
 * Some web chat models answer a long system prompt by repeating it back. Kimi
 * did, in full, and the two `<manager>` examples and the ```powershell example
 * in `buildManagerSystemPrompt` came back looking exactly like real ones —
 * because they are real ones, written by us. Two workers were dispatched with
 * the body "Your message here." and `Get-Content src/foo.ts` ran as a command.
 *
 * The check is exact equality against the constants the prompt itself is built
 * from, so it cannot drift and cannot match real work: a manager that genuinely
 * wants to send the literal string "Your message here." to a worker has no
 * reason to, and the cost of being wrong in that direction is one blocked
 * message rather than an unintended dispatch.
 */
function isManagerPromptExample(value: string): boolean {
	const trimmed = value.trim();
	return (
		trimmed === MANAGER_EXAMPLE_BODY || trimmed === MANAGER_EXAMPLE_COMMAND
	);
}

/** The complaint sent back when a reply was the prompt rather than an answer. */
const ECHOED_PROMPT_PROBLEM =
	"That reply repeated my instructions back to me instead of answering, " +
	"so the examples in them were skipped rather than run. Send the delegation " +
	"you actually want, with a real message under the TO: line.";

export function parseManagerBlocks(
	text: string,
	options: { allowCommands?: boolean } = {},
): ParsedManagerBlocks {
	// PowerShell fences are stripped first so a command that mentions the word
	// manager can never be mistaken for a delegation, and so the manager can
	// check something and delegate in the same reply.
	const verify = options.allowCommands
		? extractShellFences(text)
		: { cleanedContent: text, delegations: [], problems: [] };
	const blocks = scanManagerBlocks(verify.cleanedContent);
	if (
		blocks.length === 0 &&
		verify.delegations.length === 0 &&
		verify.problems.length === 0 &&
		options.allowCommands &&
		!verify.cleanedContent.includes(DONE_TOKEN)
	) {
		// Nothing was dispatched and nothing is wrong yet — but if the reply is
		// visibly a command in an untagged fence, the turn is about to end with
		// the instruction silently dropped. Ask for the tag instead; the caller
		// resends this into the same chat (see the retry loop in each provider).
		// A reply that already delegated, already has a complaint, or is signing
		// off is left alone: those are turns doing their job.
		const nudge = untaggedShellFenceNudge(verify.cleanedContent);
		if (nudge) {
			return { ...verify, problems: [nudge] };
		}
	}
	if (blocks.length === 0) {
		// No nudge here for a reply with no block.
		//
		// This used to bounce any block-less reply that lacked the sign-off, to
		// catch a manager that wrote "Starting with extractor" and stopped. But
		// the only gate available at this layer is "does the session have
		// team_run_task", and EVERY team-enabled session has it — so an ordinary
		// agent finishing its turn with plain text got told to send a <manager>
		// block. The check belongs on manager mode, not on tool presence, and
		// comes back when the manager has a tool of its own to key off.
		return verify;
	}

	const delegations: ManagerDelegation[] = [...verify.delegations];
	const problems: string[] = [...verify.problems];
	const parts: string[] = [];
	let cursor = 0;
	const source = verify.cleanedContent;

	for (const block of blocks) {
		parts.push(source.slice(cursor, block.start));
		cursor = block.end;

		if (!block.agentId) {
			problems.push(
				"A <manager> block had no `TO: <worker>` line, so there was no way to tell which assistant it was for. Repeat it with the worker named on the first line.",
			);
			continue;
		}
		if (!block.task) {
			problems.push(
				`The <manager> block addressed to "${block.agentId}" had no message under the TO: line.`,
			);
			continue;
		}
		if (block.unterminated) {
			problems.push(
				`The <manager> block addressed to "${block.agentId}" was never closed. Put </manager> alone on its own line at the end of the block.`,
			);
			continue;
		}
		if (isManagerPromptExample(block.task)) {
			// The model echoed its own instructions. Never dispatch that, and say
			// so rather than dropping it silently — a manager whose block vanished
			// with no complaint writes the same block again.
			problems.push(ECHOED_PROMPT_PROBLEM);
			continue;
		}
		// Every block is a follow-up to an existing worker.
		delegations.push({
			name: "team_run_task",
			arguments: {
				agentId: block.agentId,
				task: block.task,
				runMode: "sync",
				continueConversation: true,
				...(block.tools ? { tools: block.tools } : {}),
			},
		});
	}

	parts.push(source.slice(cursor));

	return {
		cleanedContent: parts.join("").trim(),
		delegations,
		problems,
	};
}
