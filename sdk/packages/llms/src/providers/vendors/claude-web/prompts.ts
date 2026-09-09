import type { LanguageModelV2Prompt } from "@ai-sdk/provider";
import type { WebProviderPrompts } from "@cline/shared";
import { messagesToPrompt } from "../deepseek-web";
import { buildLeanConversation, continuationLabel } from "../deepseek-web-v2";
import { SIMPLE_WEB_SYSTEM_PROMPT } from "../tool-pipeline/simple-system-prompt";

/**
 * Maximum number of lines of a Claude Web tool result sent back to the model.
 * Claude Web answers in plain text and the whole flattened prompt is sent in a
 * single browser request; a very long command output (e.g. `Get-Content -Raw`
 * of a large file) makes the page return an empty response. Cap every tool
 * result at this many lines so the request stays within the web client's
 * practical limits.
 */
export const CLAUDE_WEB_TOOL_RESULT_MAX_LINES = 200;

/**
 * `run_commands` returns a JSON array of `ToolOperationResult` entries
 * (`[{query, result, success, error, ...}]`). Sending that raw JSON back to
 * Claude Web is unnatural; it only cares about the actual command output. Parse
 * the array and join each entry's `result` (or `error`) string, so the model
 * sees the PowerShell output like a human would. Falls back to the raw text
 * when the payload isn't that structured shape.
 */
function extractRunCommandsOutput(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("[")) return trimmed;

	const outputs: string[] = [];
	let cursor = 0;

	// The runtime can stack multiple `ToolOperationResult[]` arrays back to
	// back (one per command in a single run_commands call), e.g.
	// `[{...}]\n[{...}]`. JSON.parse can't handle the concatenation, so scan
	// each balanced `[...]` block individually.
	for (;;) {
		const start = trimmed.indexOf("[", cursor);
		if (start === -1) break;

		let depth = 0;
		let inString = false;
		let escaped = false;
		let end = -1;
		for (let i = start; i < trimmed.length; i++) {
			const ch = trimmed[i];
			if (inString) {
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') inString = true;
			else if (ch === "[") depth++;
			else if (ch === "]") {
				depth--;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
		if (end === -1) break;

		const raw = trimmed.slice(start, end + 1);
		cursor = end + 1;

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			continue;
		}
		if (!Array.isArray(parsed)) continue;

		for (const entry of parsed) {
			if (!entry || typeof entry !== "object") continue;
			const record = entry as Record<string, unknown>;
			const result =
				typeof record.result === "string" ? record.result.trim() : "";
			const error = typeof record.error === "string" ? record.error.trim() : "";
			if (error && result !== error) {
				// A failed entry (exit code, timeout, etc.) has a non-empty
				// `error` and often an empty `result`. Emit the error so the
				// model sees why the command failed instead of raw JSON.
				outputs.push(result ? `${result}\n${error}` : error);
			} else if (result) {
				outputs.push(result);
			}
		}
	}

	return outputs.length > 0 ? outputs.join("\n\n") : trimmed;
}

function truncateToolResultLines(text: string): string {
	const lines = text.split("\n");
	if (lines.length <= CLAUDE_WEB_TOOL_RESULT_MAX_LINES) return text;
	const dropped = lines.length - CLAUDE_WEB_TOOL_RESULT_MAX_LINES;
	return [
		...lines.slice(0, CLAUDE_WEB_TOOL_RESULT_MAX_LINES),
		`... [output truncated: ${dropped} more lines]`,
	].join("\n");
}

function formatClaudeToolResult(toolName: string, text: string): string {
	const body = text.trim();
	const capped = truncateToolResultLines(body);
	switch (toolName) {
		case "read_files":
			return `Here is the file content I just read:\n${capped}`;
		case "_codebase":
			return `Here are the files/functions I found when searching:\n${capped}`;
		case "run_commands":
			return `Here is the output of the command I just ran:\n${truncateToolResultLines(extractRunCommandsOutput(body))}`;
		case "editor":
			return `I just edited the file. Here is the result:\n${capped}`;
		case "fetch_web_content":
			return `Here is the content I fetched from the web:\n${capped}`;
		case "ask_question":
		case "ask_followup_question":
			// This is the user's answer to a question we asked them, not a
			// tool discovery. Send it back as plain natural language instead
			// of wrapping it in "Here is what I found:".
			return capped;
		default:
			return `Here is what I found:\n${capped}`;
	}
}

/**
 * Clean the flattened prompt for Claude Web:
 *   - rephrase `Tool result: (name) ...` turns into natural first-person prose,
 *   - drop the stale `Previous user message:` echo (Claude Web keeps its own
 *     server-side history, so re-sending the prior user text is redundant), and
 *   - drop the runtime's synthetic `Note:` continuation (it reads like a
 *     machine instruction, not a human pasting results back).
 * This runs AFTER the shared `messagesToPrompt` formatter (which we do not
 * modify). Segments are the formatter's own `\n\n`-joined turns.
 */
function rephraseClaudeToolResults(promptText: string): string {
	const segments = promptText.split("\n\n");
	return segments
		.filter((segment, index) => {
			const trimmed = segment.trim();
			// Keep the LAST "Previous user message:" segment: it is the current
			// queued directive when the user steers the turn right after a tool
			// round. Every earlier one is stale context (Claude Web already
			// holds it server-side) and is dropped.
			const isLastPreviousUser =
				trimmed.startsWith("Previous user message:") &&
				index === segments.length - 1;
			return (
				isLastPreviousUser ||
				(!trimmed.startsWith("Previous user message:") &&
					!trimmed.startsWith("Note:"))
			);
		})
		.map((segment) => {
			const match = /^Tool result: \(([^)]+)\)\s*([\s\S]*)$/.exec(segment);
			if (!match) return segment;
			return formatClaudeToolResult(match[1], match[2]);
		})
		.join("\n\n");
}

/**
 * Build the flat prompt sent to claude.ai, mirroring deepseek-web-v2's
 * `buildPrompt`: the real web client keeps its own server-side conversation
 * state, so the system prompt is sent verbatim on the conversation's first
 * turn (via `buildLeanConversation`'s own first-turn passthrough) and dropped
 * on every follow-up turn in the SAME Claude chat — re-added only when
 * `reInjectSystem` is true (a brand-new Claude chat, e.g. right after a
 * compaction opens a fresh one).
 */
export function buildClaudePrompt(
	prompt: LanguageModelV2Prompt,
	reInjectSystem: boolean,
	preserveCompactionContext: boolean,
): string {
	// The system prompt arrives already chosen: `buildClineSystemPrompt`
	// picks this provider's `default` / `worker` / `manager` wording from
	// its prompts file. This used to call `applySimpleWebSystemPrompt`,
	// which swapped the prompt here by testing it for a marker heading
	// that no web provider is ever sent — so it never once fired.
	const effectivePrompt = prompt;

	const conversation = buildLeanConversation(
		effectivePrompt,
		preserveCompactionContext,
	);
	const systemMessage = effectivePrompt.find((m) => m.role === "system");
	const alreadyHasSystem = conversation.some((m) => m.role === "system");
	const promptOptions = {
		historyWindow: 10,
		userLabel: "Previous user message",
		lastUserLabel: continuationLabel(conversation),
		toolResultLabel: "Tool result",
	};

	if (
		reInjectSystem &&
		systemMessage &&
		!alreadyHasSystem &&
		conversation.length > 0
	) {
		return rephraseClaudeToolResults(
			messagesToPrompt([systemMessage, ...conversation], promptOptions),
		);
	}
	return rephraseClaudeToolResults(
		messagesToPrompt(conversation, promptOptions),
	);
}

/**
 * Claude Web's three prompts.
 *
 * A session reaches a web provider as one of three things, and they want
 * different wording:
 *
 * - `default` — a plain session. One human, one chat box.
 * - `worker` — a teammate a manager delegated to. Its tool list lives in this
 *   text and nowhere else, because there is no function-calling API behind a
 *   scraped chat, so a worker handed only its role prompt knows the job and has
 *   no way to do any of it.
 * - `manager` — a coordinator. No file or shell tools at all; it delegates and
 *   reads reports.
 *
 * Leave a slot `undefined` and that role gets the shared prompt it has always
 * had. See `kimi-web/prompts.ts` for the placeholder list available to
 * `default` and `worker`.
 */
export const claudeWebPrompts: WebProviderPrompts = {
	// The human-in-the-loop prompt: PowerShell to read with, a patch block to
	// edit with. Claude is a strong reasoner behind a scraped chat box, not a
	// function-calling API, and handing it the JSON tool contract makes it
	// worse — it spends the turn formatting JSON instead of thinking.
	//
	// `claude-web` is on the `web-chat-providers-use-apply-patch` rule in
	// `model-tool-routing.ts`, which is what makes the patch grammar this
	// prompt teaches actually parse. The two lists have to stay in step.
	//
	// Backup: `default: undefined` restores the shared coding-agent prompt built
	// by `buildClineSystemPrompt` — the full tool-calling contract with
	// `{{AVAILABLE_TOOLS}}` substituted in.
	default: SIMPLE_WEB_SYSTEM_PROMPT,

	// Workers get the same human-in-the-loop prompt as a plain session, not the
	// `<tool>{"name": ...}</tool>` JSON contract. Same reason as `default`: a
	// scraped chat box has no function-calling API behind it, so the contract
	// buys nothing and costs the turn formatting JSON instead of thinking.
	//
	// Backup: `worker: undefined` restores the shared "# ROLE & OBJECTIVE"
	// contract, whose `{{AVAILABLE_TOOLS}}` renders only the tools that worker
	// was actually granted. The manager's role text is appended after whichever
	// of the two is used, under a "# Team Teammate Role" heading.
	worker: SIMPLE_WEB_SYSTEM_PROMPT,

	// Unset: a manager keeps the shared manager prompt.
	manager: undefined,
};
