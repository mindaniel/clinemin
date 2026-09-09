import * as fs from "node:fs";
import * as path from "node:path";
import type {
	LanguageModelV2,
	LanguageModelV2CallOptions,
	LanguageModelV2FinishReason,
	LanguageModelV2FunctionTool,
	LanguageModelV2Prompt,
	LanguageModelV2StreamPart,
} from "@ai-sdk/provider";
import type {
	BasicLogger,
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
} from "@cline/shared";
import {
	type DeepSeekWebUsageEstimate,
	estimateDeepSeekWebUsage,
	messagesToPrompt,
	parseDeepSeekToolCalls,
	parseLooseDeepSeekToolCalls,
} from "../deepseek-web";
import { withBrowserLock } from "../tool-pipeline/browser-lock";
import { resolveChatKey } from "../tool-pipeline/chat-target";
import { isSyntheticUserText } from "../tool-pipeline/continuation-note";
import { logConversationTurn } from "../tool-pipeline/conversation-logger";
import { consumePendingInjectedReply } from "../tool-pipeline/injected-reply";
import { parseInvokeStyleToolCalls } from "../tool-pipeline/invoke-parser";
import { stripPreviousUserBlock } from "../tool-pipeline/previous-user-dedupe";
import { extractShellFenceCommands } from "../tool-pipeline/shell-fence";
import {
	isToolCallStuckInThinking,
	THINKING_MODE_NUDGE,
} from "../tool-pipeline/thinking-mode";
import { validateToolCalls } from "../tool-pipeline/tool-dispatcher";
import type { ProviderFactoryResult } from "../types";
import { runCompletion } from "./capture";
import { chatKeyFromPrompt, lookupChatSession } from "./chat-registry";
import { resolveDeepSeekWebV2Config } from "./config";

function detectMalformedToolTag(text: string): string | null {
	// Look for `<tool` followed by whitespace and then `{` before any `>`.
	// This catches the common mistake of missing `>` after `<tool`.
	const match = /<tool\s+\{/i.exec(text);
	if (match) {
		console.log("[deepseek-web-v2] malformed tag detected in:", text);
		return 'Malformed tool tag: missing \'>\' after \'<tool\'. Expected format: <tool>{"name":"...","arguments":{...}}</tool>.';
	}
	return null;
}

function detectUnparsedToolBlock(
	text: string,
	toolNames: string[],
): string | null {
	const lower = text.toLowerCase();
	const open = lower.indexOf("<tool");
	if (open === -1) return null;
	const example = `<tool>${JSON.stringify({ name: "tool_name", arguments: {} })}</tool>`;
	const close = lower.indexOf("</tool>", open);
	if (close === -1) {
		return (
			"Tool call rejected: detected a <tool opening tag but could not find a complete </tool> body. Re-emit the block as exactly " +
			example +
			". Ensure every string is double-quoted, JSON string values do not contain literal newlines, and there are no trailing commas."
		);
	}
	const innerStart = text.indexOf(">", open) + 1;
	const inner = text.slice(innerStart, close).trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(inner);
	} catch {
		parsed = undefined;
	}
	if (parsed) {
		const record = parsed as Record<string, unknown>;
		const usedName =
			typeof record.name === "string"
				? record.name
				: typeof record.type === "string"
					? record.type
					: "unknown";
		const available = toolNames.length > 0 ? toolNames.join(", ") : "none";
		return (
			"Tool call rejected: attempted tool " +
			usedName +
			" but it is not an available tool. Available tools: " +
			available +
			". Re-emit the block with a valid tool name: " +
			example +
			"."
		);
	}
	try {
		JSON.parse(inner);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return (
			"Tool call rejected: the <tool> JSON could not be parsed. Reason: " +
			reason +
			". Re-emit as " +
			example +
			". JSON string values must not contain literal newlines (escape them instead), use double quotes, and avoid trailing commas."
		);
	}
	return null;
}

// ── LanguageModelV2 adapter ─────────────────────────────────────────────────

interface ParsedToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

/** File extension for a markdown code-fence language tag. */
function extensionForLanguage(lang?: string): string {
	const map: Record<string, string> = {
		python: ".py",
		py: ".py",
		javascript: ".js",
		js: ".js",
		jsx: ".jsx",
		typescript: ".ts",
		ts: ".ts",
		tsx: ".tsx",
		bash: ".sh",
		sh: ".sh",
		shell: ".sh",
		powershell: ".ps1",
		ps1: ".ps1",
		json: ".json",
		yaml: ".yaml",
		yml: ".yaml",
		markdown: ".md",
		md: ".md",
		html: ".html",
		css: ".css",
		go: ".go",
		rust: ".rs",
		rs: ".rs",
		java: ".java",
		c: ".c",
		cpp: ".cpp",
		csharp: ".cs",
		cs: ".cs",
		ruby: ".rb",
		rb: ".rb",
		php: ".php",
		sql: ".sql",
		text: ".txt",
	};
	return map[lang ?? ""] ?? ".txt";
}

/** Best-effort filename for a code block, from nearby text, the prompt, or a generated name. */
function inferFileName(
	fullText: string,
	blockIndex: number,
	prompt: string,
	lang: string,
	index: number,
): string {
	// The directory prefix is optional but captured when present. A reply that
	// says "**File:** `C:\Users\me\thing.py`" is naming one exact file, and
	// reducing that to `thing.py` both writes to the wrong place and hides the
	// target from the exists-check in `fileAlreadyExists`.
	const namePattern =
		/\b((?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?(?:[\w.-]+[\\/])*[\w-]+\.(?:py|js|ts|tsx|jsx|sh|ps1|json|ya?ml|md|txt|html|css|go|rs|java|c|cpp|cs|rb|php|sql))\b/i;
	// Search a window around the block ("save it as x.py" usually follows it).
	const around = fullText.slice(
		Math.max(0, blockIndex - 200),
		blockIndex + 300,
	);
	const inReply = namePattern.exec(around);
	if (inReply) return inReply[1];
	const inPrompt = namePattern.exec(prompt);
	if (inPrompt) return inPrompt[1];
	return `output_${index + 1}${extensionForLanguage(lang)}`;
}

/**
 * Does the inferred target already exist?
 *
 * `inferFileName` guesses from prose, so it happily returns a file the reply is
 * merely TALKING about. Writing a fence to a file that already exists is never
 * something this fallback should do: it exists to catch "here is the script I
 * wrote for you", where the file is new. Any change to an existing file has to
 * come through a real tool call that carries the full intended content.
 *
 * Relative names are resolved against the process cwd, which is the workspace
 * root the editor executor would write into.
 */
function fileAlreadyExists(filename: string): boolean {
	try {
		const resolved = path.isAbsolute(filename)
			? filename
			: path.resolve(process.cwd(), filename);
		return fs.existsSync(resolved);
	} catch {
		// Unreadable path: treat as existing. Skipping a write is recoverable;
		// a wrong whole-file overwrite is not.
		return true;
	}
}

/** The text of the last user message in the prompt, for filename hints. */
function lastUserText(prompt: LanguageModelV2Prompt): string {
	for (let i = prompt.length - 1; i >= 0; i--) {
		const message = prompt[i];
		if (message.role !== "user") continue;
		const parts = message.content as Array<{ type?: string; text?: string }>;
		return parts
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n")
			.trim();
	}
	return "";
}

/**
 * Fallback when the web model ignored the `<tool>` contract and answered with
 * plain text (a plan, code fences, install commands). Convert the visible
 * structure of the reply into real tool calls the agent can execute:
 *
 *  - markdown code fences      → `editor` (create the file with that content)
 *  - `pip install ...` lines   → `run_commands`
 *
 * Only emits calls for tools that are actually available, and strips the
 * converted code fences from the visible text so the file content isn't shown
 * twice.
 */
export function parseFallbackToolUses(
	text: string,
	prompt: string,
	availableToolNames: string[],
): { cleanedText: string; toolUses: ParsedToolCall[] } {
	const hasEditor = availableToolNames.includes("editor");
	const hasRunCommands = availableToolNames.includes("run_commands");

	// Shell fences FIRST, and their text removed before anything below sees it.
	// The fence-to-file pass further down cannot tell a command from a program,
	// so a ```powershell block reaching it becomes a file write: the command
	// never runs and the model is told a file was created. See
	// tool-pipeline/shell-fence.ts.
	const shell = extractShellFenceCommands(text, availableToolNames);
	const toolUses: ParsedToolCall[] = [...shell.toolUses];
	text = shell.remainingText;

	// `pip install ...` (and similar) → run_commands
	if (hasRunCommands) {
		const installPattern =
			/(?:^|\n)\s*(?:pip|pip3|python\s+-m\s+pip)\s+install\s+[^\n]+/gi;
		const installs = [...text.matchAll(installPattern)].map((m) =>
			m[0].replace(/^\s*\n/, "").trim(),
		);
		if (installs.length > 0) {
			toolUses.push({
				name: "run_commands",
				arguments: { commands: installs },
			});
		}
	}

	// markdown code fences → editor (create file)
	//
	// Done in ONE pass so the decision to emit a call and the decision to strip
	// the fence from the visible text can never disagree. They used to be two
	// independent regex passes, and a fence that was skipped still got replaced
	// with "[code saved to a file]" — a lie about a file that was never written.
	let cleanedText = text;
	const quoted: string[] = [];
	if (hasEditor) {
		const fencePattern = /```([\w+-]*)\s*\n([\s\S]*?)```/g;
		let index = 0;
		cleanedText = text.replace(
			fencePattern,
			(full: string, rawLang: string, rawCode: string, offset: number) => {
				const lang = (rawLang ?? "").toLowerCase();
				const code = rawCode.replace(/\s+$/, "");
				if (!code.trim()) {
					index++;
					return full;
				}
				const filename = inferFileName(text, offset, prompt, lang, index);
				index++;
				if (fileAlreadyExists(filename)) {
					// The fence is a QUOTE, not a file. A reply like "Old line
					// (line 569): ```python ...```" names an existing file in its
					// prose, so `inferFileName` picks that file up — and writing
					// the fence would replace the whole file with the one line
					// being discussed. Whole-file writes to an existing file must
					// come from a real `editor` call, never from this guess.
					quoted.push(filename);
					return full;
				}
				toolUses.push({
					name: "editor",
					arguments: { path: filename, new_text: code },
				});
				return "[code saved to a file]";
			},
		);
	}

	if (quoted.length > 0) {
		// Loud, because the alternative is the model believing an edit landed.
		const names = [...new Set(quoted)].join(", ");
		cleanedText = `${cleanedText}\n\nNote: a code fence here looks like a quote from ${names}, which already exists, so nothing was written. To change an existing file, send a real editor or apply_patch tool call.`;
	}

	return { cleanedText: cleanedText.trim(), toolUses };
}

/**
 * The prefix of the auto-generated context-compaction summary user message
 * (see `buildSummaryMessage` in compacton-shared.ts). After a manual `/compact`
 * or an auto-compaction, this message becomes the first user message of the
 * working context and must NOT be dropped by the lean-conversation trimmer,
 * otherwise the fresh DeepSeek web chat would lose all prior conversation
 * context.
 *
 * Note: `metadata.kind === "compaction_summary"` does NOT survive the runtime's
 * message formatting (it is stripped before the prompt reaches the provider),
 * so the leading user message's text is the reliable signal available here.
 */
const COMPACTION_SUMMARY_PREFIX = "Context summary:";

/**
 * True when the leading user message is the auto-generated context-compaction
 * summary (its text opens with `COMPACTION_SUMMARY_PREFIX`). This identifies a
 * compaction-transition turn, where the DeepSeek web chat was reopened/refreshed
 * and must be re-seeded with the compacted context.
 */
function hasLeadingCompactionSummary(prompt: LanguageModelV2Prompt): boolean {
	for (const message of prompt) {
		if (message.role !== "user") continue;
		// The compaction summary is the FIRST user message. Return based on its
		// text; do not keep scanning for a later user message.
		const content = Array.isArray(message.content)
			? message.content
					.map((block) => ("text" in block ? block.text : ""))
					.join("\n")
			: message.content;
		return (
			typeof content === "string" &&
			content.trim().startsWith(COMPACTION_SUMMARY_PREFIX)
		);
	}
	return false;
}

/**
 * Trim the prompt for the DeepSeek web chat. The real web client keeps its own
 * server-side conversation state, so re-sending the full transcript every turn
 * is redundant and causes the model to echo back its own prior output.
 *
 * Behavior:
 *  - First turn (`[system, user]` and nothing else) is sent verbatim so the
 *    model receives the system prompt exactly once.
 *  - Every follow-up turn drops the system prompt, all prior assistant/user
 *    messages, and keeps ONLY:
 *      * the most recent user message (the current prompt), and
 *      * any `tool` result messages that come after that user message (the
 *        results of the agent's latest tool calls).
 *  - Iteration turns are special-cased: the agent runtime appends a synthetic
 *    "Use tool to continue..." user message right after tool execution (see
 *    agent-runtime.ts), so the most recent user message is that continuation
 *    and the latest tool results sit BEFORE it. Keeping only "last user +
 *    tool results after it" would trim to the bare continuation sentence and
 *    lose both the tool outputs and the original instruction. When the last
 *    user message is directly preceded by tool results, the previous user
 *    message, the intervening tool results, and the continuation are all kept.
 *  - Compaction-transition turns are special-cased: when a `compaction_summary`
 *    user message leads the prompt, that summary is retained as the leading
 *    context so the fresh DeepSeek web chat (which has no prior server-side
 *    state) is re-seeded with what was compacted. The summary is kept alongside
 *    the current user prompt and any trailing tool results.
 */
// The agent runtime's synthetic "keep going" nudge appended after every round
// of tool execution (see `agent-runtime.ts`'s `continuationMessage`) is never
// something the user typed, so it must never be echoed back to the model
// labeled as "Previous user message". Its text is per project and set at
// runtime by the CLI `/note` command, so match it through the shared helper
// rather than against a literal here — see `tool-pipeline/continuation-note.ts`.

function messageText(message: LanguageModelV2Prompt[number]): string {
	const content = Array.isArray(message.content)
		? message.content
				.map((block) => ("text" in block ? block.text : ""))
				.join("\n")
		: message.content;
	return typeof content === "string" ? content.trim() : "";
}

/**
 * True for a user message the runtime wrote rather than the user: the post-tool
 * continuation note, or the carrier text `/paste` starts its turn with.
 */
function isToolContinuationMessage(
	message: LanguageModelV2Prompt[number],
): boolean {
	return message.role === "user" && isSyntheticUserText(messageText(message));
}

/**
 * Walk backward from (but not including) `beforeIndex` for the nearest user
 * message that is NOT a synthetic continuation placeholder. A multi-round
 * tool loop appends one such placeholder per round, so the "user message
 * right before this one" can itself be an earlier placeholder rather than
 * anything the user actually typed.
 */
function findPriorRealUserIndex(
	nonSystem: LanguageModelV2Prompt,
	beforeIndex: number,
): number {
	for (let i = beforeIndex - 1; i >= 0; i--) {
		if (nonSystem[i].role !== "user") continue;
		if (isToolContinuationMessage(nonSystem[i])) continue;
		return i;
	}
	return -1;
}

export function buildLeanConversation(
	prompt: LanguageModelV2Prompt,
	preserveCompactionContext = false,
): LanguageModelV2Prompt {
	const nonSystem = prompt.filter((m) => m.role !== "system");

	// A first turn is exactly a single user message (with no other roles).
	const isFirstTurn = nonSystem.length === 1 && nonSystem[0].role === "user";
	if (isFirstTurn) return prompt;

	// Find the index of the last user message and the user message before it.
	let lastUserIndex = -1;
	let prevUserIndex = -1;
	for (let i = nonSystem.length - 1; i >= 0; i--) {
		if (nonSystem[i].role !== "user") continue;
		if (lastUserIndex === -1) {
			lastUserIndex = i;
		} else {
			prevUserIndex = i;
			break;
		}
	}

	// Compaction-transition turn: a fresh DeepSeek web chat is about to be
	// opened (it has no prior server-side state), so the compaction summary
	// must be carried over as leading context to seed the new chat with what
	// was compacted. The summary is the FIRST user message; keep it in front of
	// the current prompt. On later turns the web chat already holds the summary
	// server-side, so `preserveCompactionContext` is false and it is dropped.
	const firstUserIndex = nonSystem.findIndex((m) => m.role === "user");
	const hasCompactionSummary =
		preserveCompactionContext &&
		firstUserIndex >= 0 &&
		hasLeadingCompactionSummary(nonSystem);

	// An iteration turn: the last user message is the runtime's synthetic
	// "Use tool to continue..." continuation, which directly follows the tool
	// results. Keep the previous user message (as "Previous user message"
	// context), every tool result after it, and the continuation message so
	// the model sees both the tool outputs and the original instruction.
	const isContinuationTurn =
		lastUserIndex > 0 && nonSystem[lastUserIndex - 1]?.role === "tool";

	// A queued user message after a tool round: the synthetic continuation
	// note sits between the tool result and the queued message, so the
	// last-user predecessor is a USER (the note) instead of the tool result.
	// Without this case the fallback branch below keeps only the queued
	// message and drops the pending tool output the model still needs.
	const isQueuedAfterToolTurn =
		lastUserIndex > 1 &&
		isToolContinuationMessage(nonSystem[lastUserIndex - 1]) &&
		nonSystem[lastUserIndex - 2]?.role === "tool";

	// Keep the last user message plus every tool result after it.
	const kept: LanguageModelV2Prompt = [];
	if (hasCompactionSummary && lastUserIndex > firstUserIndex) {
		kept.push(nonSystem[firstUserIndex]);
	}
	if (isContinuationTurn && prevUserIndex >= 0) {
		// On a multi-round tool loop, `prevUserIndex` may itself be an earlier
		// synthetic continuation placeholder that was already sent to the chat
		// in a prior real turn — not something the user typed. Re-anchor to
		// the nearest REAL user message so "Previous user message" never
		// echoes our own placeholder text back at the model. The tool-result
		// window below still starts right after `prevUserIndex` (unaffected),
		// so only the CURRENT round's results are included, not the whole
		// history the placeholder skip may reach past.
		const anchorIndex = isToolContinuationMessage(nonSystem[prevUserIndex])
			? findPriorRealUserIndex(nonSystem, prevUserIndex)
			: prevUserIndex;
		if (anchorIndex >= 0) kept.push(nonSystem[anchorIndex]);
		for (let i = prevUserIndex + 1; i < nonSystem.length; i++) {
			if (nonSystem[i].role === "tool") kept.push(nonSystem[i]);
		}
		kept.push(nonSystem[lastUserIndex]);
	} else if (isQueuedAfterToolTurn) {
		// Keep the pending tool output AND the queued message. The synthetic
		// continuation note sits between them, so a regular continuation turn
		// would never match (the last user's predecessor is the note, not the
		// tool). Anchor to the nearest REAL user message before the note, keep
		// every tool result that follows it, then append the queued message as
		// the final turn so it is sent as the new ask instead of dropped.
		const anchorIndex = findPriorRealUserIndex(nonSystem, lastUserIndex);
		if (anchorIndex >= 0) kept.push(nonSystem[anchorIndex]);
		for (let i = anchorIndex + 1; i < lastUserIndex; i++) {
			if (nonSystem[i].role === "tool") kept.push(nonSystem[i]);
		}
		kept.push(nonSystem[lastUserIndex]);
	} else {
		if (lastUserIndex >= 0) kept.push(nonSystem[lastUserIndex]);
		for (let i = lastUserIndex + 1; i < nonSystem.length; i++) {
			if (nonSystem[i].role === "tool") kept.push(nonSystem[i]);
		}
	}

	// Fallback (no user message at all): keep only trailing tool results.
	if (kept.length === 0) {
		for (let i = nonSystem.length - 1; i >= 0; i--) {
			if (nonSystem[i].role === "tool") {
				kept.unshift(nonSystem[i]);
			} else {
				break;
			}
		}
	}

	return kept;
}

/**
 * Context-token thresholds (as reported by DeepSeek's `accumulated_token_usage`)
 * at which the system prompt is re-injected on the next turn, so the model
 * doesn't forget the `<tool>` protocol and real tool names over a long session.
 */
const SYSTEM_REINJECT_THRESHOLDS = [200_000, 500_000, 700_000];

/**
 * Build the flat prompt sent to the web chat.
 *
 * The runtime-composed system prompt (sdk/packages/shared/src/prompt/system.ts)
 * already contains the `<tool>` calling protocol and the available tool list,
 * so no separate tool-contract block is prepended — the chat shows exactly the
 * system prompt + conversation.
 *
 * The system prompt is sent on the first turn, dropped on follow-up turns
 * (the web client keeps its own server-side state, so re-sending the full
 * transcript causes echo), but re-injected whenever the accumulated context
 * passed a `SYSTEM_REINJECT_THRESHOLDS` level in the previous turn.
 */
export function buildPrompt(
	prompt: LanguageModelV2Prompt,
	_tools: LanguageModelV2FunctionTool[] | undefined,
	reInjectSystem = false,
	preserveCompactionContext = false,
): string {
	const conversation = buildLeanConversation(prompt, preserveCompactionContext);
	const systemMessage = prompt.find((m) => m.role === "system");
	// Avoid doubling the system prompt: on a first turn the lean conversation
	// already carries it, so only prepend it again for follow-up turns (where
	// `buildLeanConversation` strips it) — e.g. after a compaction opens a fresh
	// DeepSeek chat or a re-inject threshold is crossed.
	const alreadyHasSystem = conversation.some((m) => m.role === "system");
	if (
		reInjectSystem &&
		systemMessage &&
		!alreadyHasSystem &&
		conversation.length > 0
	) {
		return messagesToPrompt([systemMessage, ...conversation], {
			historyWindow: 10,
			userLabel: "Previous user message",
			lastUserLabel: currentUserLabel(conversation),
			toolResultLabel: "Tool result",
		});
	}
	return messagesToPrompt(conversation, {
		historyWindow: 10,
		userLabel: "Previous user message",
		lastUserLabel: currentUserLabel(conversation),
		toolResultLabel: "Tool result",
	});
}

/**
 * Label for the final user message of the lean conversation. On an iteration
 * turn the runtime appends a synthetic "Use tool to continue..." continuation
 * as the LAST user message (directly after the tool results), so it is the
 * current directive — frame it as "Note:" instead of "Previous user message:"
 * (stale context). Any other final user message keeps the generic label.
 */
/**
 * Label for the final user message when it is the CURRENT directive.
 *
 * `continuationLabel` covers the runtime's synthetic "Use tool to continue..."
 * note. This adds the other case: a turn whose last message is something the
 * user just typed. That is a fresh ask, so it must not be labeled
 * `Previous user message:` — every provider strips those blocks before
 * sending, and stripping the current instruction would send a turn with
 * nothing in it.
 *
 * A user message followed by tool results is the agent iterating, not a new
 * ask: that keeps the stale label and is stripped.
 */
export function currentUserLabel(
	conversation: LanguageModelV2Prompt,
): string | undefined {
	const continuation = continuationLabel(conversation);
	if (continuation) return continuation;
	return conversation[conversation.length - 1]?.role === "user"
		? "User"
		: undefined;
}

export function continuationLabel(
	conversation: LanguageModelV2Prompt,
): string | undefined {
	const last = conversation[conversation.length - 1];
	const beforeLast = conversation[conversation.length - 2];
	if (last?.role !== "user" || beforeLast?.role !== "tool") {
		return undefined;
	}
	// Only the runtime's synthetic post-tool continuation note gets the "Note"
	// label. A REAL user message queued right after a tool round must keep
	// going out as a normal user message, not be relabeled (and then dropped
	// by the provider's "Note:" cleaner) as if it were the synthetic note.
	if (!isToolContinuationMessage(last)) {
		return undefined;
	}
	return "Note";
}

/**
 * Turn a raw reply body into a completion result, running the same tool
 * recovery ladder a live capture goes through: strict `<tool>` blocks, then
 * loose ones, then the plain-prose fallback. Usage is zero — nothing was sent.
 */
function buildCompletionFromText(
	text: string,
	options: LanguageModelV2CallOptions,
	functionTools: LanguageModelV2FunctionTool[],
): {
	text: string;
	reasoning: string;
	toolCalls: ParsedToolCall[];
	usage: DeepSeekWebUsageEstimate;
} {
	const usage: DeepSeekWebUsageEstimate = {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
	};
	const toolNames = functionTools.map((tool) => tool.name);
	if (toolNames.length === 0) {
		return { text, reasoning: "", toolCalls: [], usage };
	}

	const { cleanedContent, toolCalls } = parseDeepSeekToolCalls(text, toolNames);
	const looseCalls =
		toolCalls.length === 0
			? parseLooseDeepSeekToolCalls(text, toolNames)
			: toolCalls;
	if (looseCalls.length > 0) {
		const { tools: validatedLoose, retryPrompt } =
			validateToolCalls(looseCalls);
		return {
			text: retryPrompt
				? `${cleanedContent}\n\n${retryPrompt}`.trim()
				: cleanedContent,
			reasoning: "",
			toolCalls: validatedLoose,
			usage,
		};
	}

	// Anthropic-style `<invoke>` bodies (see tool-pipeline/invoke-parser.ts).
	// Before the malformed-tag hint, which would fire on the `<tool>` wrapper
	// the model opened around the invoke block.
	const invoked = parseInvokeStyleToolCalls(text, toolNames);
	if (invoked.toolCalls.length > 0) {
		const { tools: validatedInvoked, retryPrompt } = validateToolCalls(
			invoked.toolCalls,
		);
		return {
			text: retryPrompt
				? `${invoked.cleanedContent}\n\n${retryPrompt}`.trim()
				: invoked.cleanedContent,
			reasoning: "",
			toolCalls: validatedInvoked,
			usage,
		};
	}

	const malformedError = detectMalformedToolTag(text);
	if (malformedError) {
		return {
			text: `${text}\n\n${malformedError}`,
			reasoning: "",
			toolCalls: [],
			usage,
		};
	}

	const unparsedError = detectUnparsedToolBlock(text, toolNames);
	if (unparsedError) {
		return {
			text: `${text}\n\n${unparsedError}`,
			reasoning: "",
			toolCalls: [],
			usage,
		};
	}

	const fallback = parseFallbackToolUses(
		cleanedContent,
		lastUserText(options.prompt),
		toolNames,
	);
	return {
		text: fallback.cleanedText,
		reasoning: "",
		toolCalls: fallback.toolUses,
		usage,
	};
}

function finishReasonFor(
	text: string,
	toolCalls: ParsedToolCall[],
): LanguageModelV2FinishReason {
	return toolCalls.length > 0 ? "tool-calls" : text ? "stop" : "unknown";
}

function createDeepSeekWebV2Model(
	modelId: string,
	logger?: BasicLogger,
): LanguageModelV2 {
	// Tracks the last reported accumulated context tokens so a threshold cross
	// re-injects the system prompt on the next turn.
	let lastAccumulatedTokenUsage: number | undefined;
	// Highest threshold already re-injected, so each threshold fires once.
	let reinjectedThroughThreshold = 0;
	const doCompletion = async (
		options: LanguageModelV2CallOptions,
		onText?: (text: string) => void,
		onReasoning?: (text: string) => void,
	): Promise<{
		text: string;
		reasoning: string;
		toolCalls: ParsedToolCall[];
		usage: DeepSeekWebUsageEstimate;
	}> => {
		const functionTools = (options.tools ?? []).filter(
			(tool): tool is LanguageModelV2FunctionTool => tool.type === "function",
		);

		// A reply the user pasted back with `/paste` after a network error ate
		// the real one. Short-circuit before touching the browser: the text is
		// already the model's answer, it just needs the same tool parsing a
		// captured reply gets. No retry loop — a paste is a fixed string, so
		// resending a correction into the chat would be meaningless here.
		const injectedReply = consumePendingInjectedReply("deepseek-web-v2");
		if (injectedReply) {
			return buildCompletionFromText(injectedReply, options, functionTools);
		}

		// The CLI conversation is keyed by its first user message. A fresh key
		// (no mapped DeepSeek chat yet) means this call opens a brand-new web
		// chat — e.g. right after a compaction, where the newly-generated
		// `compaction_summary` becomes the first user message and the compacted
		// context moves into a fresh DeepSeek chat.
		// Which web chat does this call go to?
		//
		// Normally: hash the conversation's first user message. Same
		// conversation, same key, same chat.
		//
		// During compaction: the summarize request is standalone text that would
		// hash to a chat of its own (an empty one, where the model would answer
		// that it has nothing to summarize), so compaction instead routes
		// explicitly to the chat the last ordinary turn used. See
		// `tool-pipeline/chat-target.ts` for the full three-stage /compact
		// hand-off and for how to wire another web provider into it.
		const chatKey = resolveChatKey("deepseek-web-v2", () =>
			chatKeyFromPrompt(options.prompt),
		);
		const isNewChat =
			lookupChatSession(resolveDeepSeekWebV2Config().chatsFile, chatKey) ===
			undefined;
		// Re-inject the system prompt exactly once per threshold cross (e.g.
		// ~200k, ~500k, ~700k accumulated context), so the model re-learns the
		// <tool> protocol and real tool names without hammering every turn.
		// A brand-new chat also re-injects it, because a fresh DeepSeek chat has
		// no prior context and must be re-taught the tool contract.
		const toReinject = SYSTEM_REINJECT_THRESHOLDS.find(
			(threshold) =>
				(lastAccumulatedTokenUsage ?? 0) >= threshold &&
				threshold > reinjectedThroughThreshold,
		);
		const shouldReinject = toReinject !== undefined || isNewChat;
		const prompt = buildPrompt(
			options.prompt,
			functionTools,
			shouldReinject,
			// Preserve the compaction summary only when this call opens the fresh
			// DeepSeek web chat (the first turn after /compact). On later turns the
			// new chat already holds the summary in its server-side conversation
			// state, so it must not be re-sent.
			isNewChat,
		);
		// The web chat is stateful: everything the user typed is
		// still in it, so an older `Previous user message:` block teaches the
		// model nothing and grows the chat's context every round. The current
		// instruction still goes out — `messagesToPrompt` labels it `User:`, or
		// `Note:` on an iteration turn — and fresh tool results are untouched
		// because they change each iteration. Anything the user wants restated
		// goes through `/note`.
		const dedupedPrompt = stripPreviousUserBlock(prompt);

		// Bounded retry: when EVERY tool call in a reply gets rejected (e.g.
		// invalid Python in an `editor` call), the rejection note is OUR
		// commentary on what the model typed — DeepSeek never sees it just
		// because we computed it locally, since it isn't part of its
		// server-side chat history. Resend it as a real follow-up message in
		// the SAME chat so the model actually sees the rejection and can
		// self-correct, capped so a persistently broken model can't loop
		// forever.
		const MAX_TOOL_REJECTION_RETRIES = 2;
		const toolNames = functionTools.map((t) => t.name);
		let sendPrompt = dedupedPrompt;
		let text = "";
		let reasoning = "";
		let accumulatedTokenUsage: number | undefined;
		let rateLimited: boolean | undefined;
		let finalText = "";
		let finalToolCalls: ParsedToolCall[] = [];
		let lastRawBody = "";

		for (let attempt = 0; ; attempt++) {
			const result = await withBrowserLock(
				"deepseek-web-v2",
				options.abortSignal,
				() =>
					runCompletion({
						modelId,
						prompt: sendPrompt,
						chatKey,
						// This turn requests tool calls when function tools are wired up —
						// so it is exactly the rapid-fire pattern that needs extra pacing.
						isToolTurn: functionTools.length > 0,
						onText,
						onReasoning,
						signal: options.abortSignal,
						logger,
					}),
			);
			text = result.text;
			reasoning = result.reasoning;
			accumulatedTokenUsage = result.accumulatedTokenUsage;
			rateLimited = result.rateLimited;
			lastRawBody = result.rawBody;

			if (functionTools.length === 0) {
				finalText = text;
				finalToolCalls = [];
				break;
			}

			// The model worked the tool call out while thinking and never
			// repeated it in the answer. Reasoning is a scratchpad, not output,
			// so we can't execute what's in there — ask for it for real instead.
			if (
				attempt < MAX_TOOL_REJECTION_RETRIES &&
				isToolCallStuckInThinking({ text, reasoning, toolNames })
			) {
				logger?.log(
					`[deepseek-web-v2] tool call left in thinking stream, nudging for a real one (attempt ${attempt + 1}/${MAX_TOOL_REJECTION_RETRIES})`,
					{ severity: "warn" },
				);
				sendPrompt = THINKING_MODE_NUDGE;
				continue;
			}

			const { cleanedContent, toolCalls } = parseDeepSeekToolCalls(
				text,
				toolNames,
			);
			// Recover "wrong" tool-call shapes the strict regex missed before
			// falling back to plain-text heuristics.
			const looseCalls =
				toolCalls.length === 0
					? parseLooseDeepSeekToolCalls(text, toolNames)
					: toolCalls;
			if (looseCalls.length > 0) {
				const { tools: validatedLoose, retryPrompt: looseRetry } =
					validateToolCalls(looseCalls);
				if (
					validatedLoose.length === 0 &&
					looseRetry &&
					attempt < MAX_TOOL_REJECTION_RETRIES
				) {
					logger?.log(
						`[deepseek-web-v2] all tool calls rejected, resending correction into chat (attempt ${attempt + 1}/${MAX_TOOL_REJECTION_RETRIES})`,
						{ severity: "warn" },
					);
					sendPrompt = looseRetry;
					continue;
				}
				finalText = looseRetry
					? `${cleanedContent}\n\n${looseRetry}`.trim()
					: cleanedContent;
				finalToolCalls = validatedLoose;
				break;
			}
			// Anthropic-style `<invoke name="...">` bodies: right tool, right
			// arguments, wrong envelope. Must come before the malformed-tag
			// hint below, which would otherwise fire on the (usually unclosed)
			// `<tool>` wrapper the model opened around it.
			const invoked = parseInvokeStyleToolCalls(text, toolNames);
			if (invoked.toolCalls.length > 0) {
				const { tools: validatedInvoked, retryPrompt: invokedRetry } =
					validateToolCalls(invoked.toolCalls);
				if (
					validatedInvoked.length === 0 &&
					invokedRetry &&
					attempt < MAX_TOOL_REJECTION_RETRIES
				) {
					logger?.log(
						`[deepseek-web-v2] all <invoke> tool calls rejected, resending correction into chat (attempt ${attempt + 1}/${MAX_TOOL_REJECTION_RETRIES})`,
						{ severity: "warn" },
					);
					sendPrompt = invokedRetry;
					continue;
				}
				finalText = invokedRetry
					? `${invoked.cleanedContent}\n\n${invokedRetry}`.trim()
					: invoked.cleanedContent;
				finalToolCalls = validatedInvoked;
				break;
			}
			// Both parsers above already repair a `<tool` tag whose `>` was
			// dropped before the JSON body — only surface the malformed-tag
			// hint when that repair still couldn't recover a call (e.g. the
			// JSON body itself is broken too).
			const malformedError = detectMalformedToolTag(text);
			if (malformedError) {
				finalText = `${text}\n\n${malformedError}`;
				finalToolCalls = [];
				break;
			}
			// Last-chance invalid-tool detection: the reply still contains a
			// <tool> block that none of the recovery parsers could turn into an
			// executable call (typically literal newlines inside JSON string values).
			// Surface a precise reason instead of leaking the raw block as text.
			const unparsedError = detectUnparsedToolBlock(text, toolNames);
			if (unparsedError) {
				if (attempt < MAX_TOOL_REJECTION_RETRIES) {
					logger?.log(
						`[deepseek-web-v2] unparsed tool block detected, resending correction into chat (attempt ${attempt + 1}/${MAX_TOOL_REJECTION_RETRIES})`,
						{ severity: "warn" },
					);
					sendPrompt = unparsedError;
					continue;
				}
				finalText = `${text}\n\n${unparsedError}`;
				finalToolCalls = [];
				break;
			}
			// The web model often ignores the <tool> contract and answers with
			// plain text (a plan, code fences, install commands). If no
			// structured call came back, convert the visible reply into real
			// tool calls so the agent actually executes them.
			const fallback = parseFallbackToolUses(
				cleanedContent,
				lastUserText(options.prompt),
				toolNames,
			);
			finalText = fallback.cleanedText;
			finalToolCalls = fallback.toolUses;
			break;
		}
		// Track the context strictly monotonically. DeepSeek's reported
		// `accumulated_token_usage` can DROP when it rejects/rolls back a
		// rate-limited message (the user-visible "tokens reset to lower"). If we
		// blindly record that lower value we'd lose the system-prompt
		// re-injection thresholds and under-report context. Only ever move
		// forward; a new chat (fresh key, no history) legitimately restarts.
		if (accumulatedTokenUsage !== undefined) {
			if (
				lastAccumulatedTokenUsage === undefined ||
				accumulatedTokenUsage > lastAccumulatedTokenUsage ||
				isNewChat
			) {
				lastAccumulatedTokenUsage = accumulatedTokenUsage;
			} else if (rateLimited) {
				logger?.debug?.(
					`[deepseek-web-v2] ignoring lower accumulated_token_usage ${accumulatedTokenUsage} (kept ${lastAccumulatedTokenUsage}) — likely a post-rate-limit rollback`,
				);
			}
		}
		if (toReinject !== undefined && toReinject > reinjectedThroughThreshold) {
			reinjectedThroughThreshold = toReinject;
		}

		// When DeepSeek reports the real cumulative context-token count for this
		// conversation, prefer it over the heuristic; otherwise fall back to the
		// chars/3 estimate. `accumulated_token_usage` is the total input context,
		// so it maps to `inputTokens` and `totalTokens` = input + this turn's output.
		const estimated = estimateDeepSeekWebUsage(prompt, `${text}${reasoning}`);
		const usage: DeepSeekWebUsageEstimate =
			accumulatedTokenUsage !== undefined
				? {
						inputTokens: accumulatedTokenUsage,
						outputTokens: estimated.outputTokens,
						totalTokens: accumulatedTokenUsage + estimated.outputTokens,
					}
				: estimated;

		// Log raw and parsed response per conversation
		try {
			logConversationTurn("deepseek-web-v2", chatKey, lastRawBody, {
				text: finalText,
				toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
				usage,
				finishReason: finishReasonFor(finalText, finalToolCalls),
			});
		} catch (_logErr) {
			// Ignore logging failures
		}

		return { text: finalText, reasoning, toolCalls: finalToolCalls, usage };
	};

	return {
		specificationVersion: "v2",
		provider: "deepseek-web-v2",
		modelId,
		supportedUrls: {},
		doGenerate: async (options) => {
			const { text, reasoning, toolCalls, usage } = await doCompletion(options);
			const content: Array<
				| { type: "text"; text: string }
				| { type: "reasoning"; text: string }
				| {
						type: "tool-call";
						toolCallId: string;
						toolName: string;
						input: string;
				  }
			> = [];
			if (reasoning) content.push({ type: "reasoning", text: reasoning });
			if (text) content.push({ type: "text", text });
			for (let i = 0; i < toolCalls.length; i++) {
				content.push({
					type: "tool-call",
					toolCallId: `call-${Date.now()}-${i}`,
					toolName: toolCalls[i].name,
					input: JSON.stringify(toolCalls[i].arguments),
				});
			}
			return {
				content,
				finishReason: finishReasonFor(text, toolCalls),
				usage: {
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					totalTokens: usage.totalTokens,
				},
				warnings: [],
			};
		},
		doStream: async (options) => {
			const id = `deepseek-web-v2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const textChunks: string[] = [];
			const reasoningChunks: string[] = [];
			const functionTools = (options.tools ?? []).filter(
				(tool): tool is LanguageModelV2FunctionTool => tool.type === "function",
			);

			// The web client has no per-token tool streaming; buffer the reply so
			// `<tool>` blocks can be parsed and stripped before emitting.
			const completion = await doCompletion(
				options,
				(t) => textChunks.push(t),
				(r) => reasoningChunks.push(r),
			);

			const reasoningText = reasoningChunks.join("");
			const rawText = textChunks.join("");
			const { cleanedContent, toolCalls } =
				functionTools.length > 0
					? parseDeepSeekToolCalls(
							rawText,
							functionTools.map((t) => t.name),
						)
					: { cleanedContent: rawText, toolCalls: [] };

			// Recover "wrong" tool-call shapes the strict regex missed before
			// emitting, mirroring doCompletion's recovery path.
			const streamToolCalls =
				toolCalls.length === 0 && functionTools.length > 0
					? parseLooseDeepSeekToolCalls(
							rawText,
							functionTools.map((t) => t.name),
						)
					: toolCalls;
			// Last recovery rung: Anthropic-style `<invoke>` bodies, which neither
			// parser above understands (see tool-pipeline/invoke-parser.ts).
			const invoked =
				streamToolCalls.length === 0 && functionTools.length > 0
					? parseInvokeStyleToolCalls(
							rawText,
							functionTools.map((t) => t.name),
						)
					: { cleanedContent, toolCalls: [] };
			const recoveredCalls =
				invoked.toolCalls.length > 0 ? invoked.toolCalls : streamToolCalls;
			const recoveredContent =
				invoked.toolCalls.length > 0 ? invoked.cleanedContent : cleanedContent;

			// Fallback: convert shell fences (```powershell) and other code fences
			// into tool calls if no structured tool calls were found.
			let finalCalls = recoveredCalls;
			let finalContent = recoveredContent;
			if (finalCalls.length === 0 && functionTools.length > 0) {
				const fallback = parseFallbackToolUses(
					finalContent,
					lastUserText(options.prompt),
					functionTools.map((t) => t.name),
				);
				finalContent = fallback.cleanedText;
				finalCalls = fallback.toolUses;
			}

			// Python-validation gate (same as doCompletion's non-streaming path):
			// drop editor calls with malformed `new_text` and surface the retry
			// prompt as text so the correction feeds back to the model instead of
			// executing bad code.
			const { tools: validatedCalls, retryPrompt } =
				validateToolCalls(finalCalls);
			const displayText = retryPrompt
				? `${finalContent}\n\n${retryPrompt}`.trim()
				: finalContent;

			const parts: LanguageModelV2StreamPart[] = [
				{ type: "stream-start", warnings: [] },
				{ type: "response-metadata", id },
			];
			if (reasoningText) {
				parts.push({ type: "reasoning-start", id });
				parts.push({ type: "reasoning-delta", id, delta: reasoningText });
				parts.push({ type: "reasoning-end", id });
			}
			if (displayText) {
				parts.push({ type: "text-start", id });
				parts.push({ type: "text-delta", id, delta: displayText });
				parts.push({ type: "text-end", id });
			}
			for (let i = 0; i < validatedCalls.length; i++) {
				const input = JSON.stringify(validatedCalls[i].arguments);
				parts.push({
					type: "tool-input-start",
					id,
					toolName: validatedCalls[i].name,
				});
				parts.push({ type: "tool-input-delta", id, delta: input });
				parts.push({ type: "tool-input-end", id });
				parts.push({
					type: "tool-call",
					toolCallId: `call-${Date.now()}-${i}`,
					toolName: validatedCalls[i].name,
					input,
				});
			}
			parts.push({
				type: "finish",
				finishReason: finishReasonFor(displayText, validatedCalls),
				usage: {
					inputTokens: completion.usage.inputTokens,
					outputTokens: completion.usage.outputTokens,
					totalTokens: completion.usage.totalTokens,
				},
			});

			let index = 0;
			const stream = new ReadableStream<LanguageModelV2StreamPart>({
				pull(controller) {
					if (index < parts.length) {
						controller.enqueue(parts[index++]);
						return;
					}
					controller.close();
				},
				cancel() {
					index = parts.length;
				},
			});

			return { stream, warnings: [] };
		},
	};
}

export function createDeepSeekWebV2ProviderModule(
	_config: GatewayResolvedProviderConfig,
	context: GatewayProviderContext,
): ProviderFactoryResult {
	return {
		model: (modelId) => createDeepSeekWebV2Model(modelId, context.logger),
	};
}
