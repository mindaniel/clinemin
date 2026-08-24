/**
 * Stage 1 of the tool-call pipeline: extract & parse.
 *
 * Given a raw LLM response, pull every `<tool>...</tool>` block, strip any
 * markdown/code fences around the JSON body, parse it with `JSON.parse()`,
 * and — when that fails — attempt a safe, syntax-only repair via `jsonrepair`
 * (fixes trailing commas, unescaped newlines, missing quotes / closing
 * brackets, Python constants, stray prose, etc.).
 *
 * Safety rules:
 * - Repair is ONLY ever applied to the JSON envelope (`name` / `arguments`).
 *   It is NEVER used to "fix" the code embedded inside `new_text` etc.
 * - A block that cannot be parsed (even after repair) is logged as a warning
 *   and skipped — this function never throws and never drops the caller.
 * - Returns only successfully-parsed tool objects.
 */

import { jsonrepair } from "jsonrepair";

/**
 * A single successfully-parsed `<tool>` call.
 *
 * `name` is the tool identifier the model emitted (not yet normalized or
 * allow-listed within this module). `arguments` is the raw argument object.
 */
export interface ParsedTool {
	/** Tool identifier, e.g. `editor`, `read_files`, `run_commands`. */
	name: string;
	/** Argument map. May be an empty object if the model omitted `arguments`. */
	arguments: Record<string, unknown>;
}

/**
 * Outcome of attempting to extract & parse one `<tool>` block.
 */
export interface ParseResult {
	/** `true` when the block survived JSON parsing (possibly after repair). */
	ok: boolean;
	/** The parsed call when `ok === true`. */
	tool?: ParsedTool;
	/** Human-readable explanation when `ok === false`. */
	error?: string;
	/** Raw inner text of the `<tool>` block (without the surrounding tags). */
	raw?: string;
}

/**
 * Match every `<tool>...</tool>` block. `[\\s\\S]*?` is non-greedy so adjacent
 * blocks don't swallow each other; `gi` makes it case-insensitive + global.
 */
const TOOL_BLOCK_RE = /<tool>([\s\S]*?)<\/tool>/gi;

/**
 * Match a malformed opening tag where `>` is missing: `<tool { ...`
 * (case-insensitive, allows whitespace after `tool`).
 */
const MALFORMED_TOOL_RE = /<tool\s+([\s\S]*?)(?:<\/tool>|$)/gi;

/**
 * Match an opening markdown fence that may or may not carry a language hint
 * (`` ```json ``, ` ``` `, ` ```python `). Captured at the very start.
 */
const LEADING_FENCE_RE = /^\s*```[a-zA-Z0-9_+-]*\s*[\r\n]*/;

/** Match a trailing markdown fence at the very end of the inner text. */
const TRAILING_FENCE_RE = /\s*```\s*$/;

/**
 * Strip leading/trailing markdown code fences (`` ```json `` or `` ``` ``) that
 * a model sometimes wraps around the JSON body inside a `<tool>` block.
 */
function stripMarkdownFences(raw: string): string {
	let text = raw;
	text = text.replace(LEADING_FENCE_RE, "");
	text = text.replace(TRAILING_FENCE_RE, "");
	return text.trim();
}

/**
 * Attempt to interpret a JSON body as a tool call of the canonical shape
 * `{ "name": string, "arguments": object }`. Returns a `ParseResult`.
 */
function normalizeJsonKeySeparators(text: string): string {
	return text.replace(/"([a-zA-Z0-9_]+)"\s*>\s*(?=["\[\{])/g, '"$1": ');
}

function parseToolJson(body: string): ParseResult {
	const inner = stripMarkdownFences(body);
	if (!inner) {
		return { ok: false, error: "empty <tool> block", raw: body };
	}

	// 0. Normalize a common malformed shape before parsing: a stray `> ` where
	//    `: ` belongs (e.g. `{"name"> "editor"}`). Rewrite it so the envelope
	//    parses as normal JSON while producing the same tool call.
	const normalized = normalizeJsonKeySeparators(inner);

	// 1. Try the strict parser first — valid JSON is always returned verbatim.
	try {
		const parsed: unknown = JSON.parse(normalized);
		return toParseResult(parsed, inner);
	} catch (_strictError) {
		// Fall through to repair below.
	}

	// 2. Syntax-only repair for genuinely-broken JSON. This fixes envelope
	//    sloppiness (commas, quotes, fences, missing brackets) — never logic.
	try {
		const repaired = jsonrepair(normalized);
		const parsed: unknown = JSON.parse(repaired);
		return toParseResult(parsed, inner);
	} catch {
		return {
			ok: false,
			error: `unparseable JSON in <tool> block: ${inner.slice(0, 120)}`,
			raw: body,
		};
	}
}

/**
 * Coerce a parsed value into a `ParseResult`. Tolerates the canonical shape
 * plus common variants (`type` instead of `name`, `params` instead of
 * `arguments`). Anything that is not an object, or lacks a usable name, is a
 * soft skip (not a hard error).
 */
function toParseResult(parsed: unknown, rawInner: string): ParseResult {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {
			ok: false,
			error: "parsed <tool> body is not a JSON object",
			raw: rawInner,
		};
	}
	const record = parsed as Record<string, unknown>;

	const name =
		typeof record.name === "string"
			? record.name
			: typeof record.type === "string"
				? record.type
				: "";

	if (!name.trim()) {
		return {
			ok: false,
			error: "parsed <tool> body has no usable name",
			raw: rawInner,
		};
	}

	// `arguments`, `params`, or (as a last resort) the whole body as args.
	const argsCandidate =
		record.arguments ?? record.params ?? record.arguments_json ?? record;
	const args =
		typeof argsCandidate === "object" &&
		argsCandidate !== null &&
		!Array.isArray(argsCandidate)
			? (argsCandidate as Record<string, unknown>)
			: {};

	return { ok: true, tool: { name, arguments: args }, raw: rawInner };
}

/**
 * Extract, parse, and repair every `<tool>` block from a raw LLM response.
 *
 * Non-tool prose in `rawResponse` is ignored here (this module is about
 * extraction + parsing only; text-stripping/cleanup is the caller's concern).
 *
 * @param rawResponse The complete model reply.
 * @returns One `ParseResult` per `<tool>` block. Malformed blocks are skipped
 *          (never thrown) and reported via their `error` field.
 */
export function extractToolCalls(rawResponse: string): Array<ParseResult> {
	if (!rawResponse) return [];

	const results: ParseResult[] = [];

	// First, collect all proper <tool>...</tool> blocks.
	TOOL_BLOCK_RE.lastIndex = 0;
	const properMatches: Array<{ start: number; end: number; body: string }> = [];
	let match;
	while ((match = TOOL_BLOCK_RE.exec(rawResponse)) !== null) {
		const start = match.index;
		const end = match.index + match[0].length;
		const body = match[1] ?? "";
		properMatches.push({ start, end, body });
		results.push(parseToolJson(body));
	}

	// Build intervals for proper blocks to avoid overlapping with malformed detection.
	const intervals = properMatches.map((m) => ({ start: m.start, end: m.end }));

	// Now scan for malformed tags: <tool ... without the '>' after 'tool'.
	MALFORMED_TOOL_RE.lastIndex = 0;
	let malformedMatch;
	while ((malformedMatch = MALFORMED_TOOL_RE.exec(rawResponse)) !== null) {
		const start = malformedMatch.index;
		const end = start + malformedMatch[0].length;
		// Check if this overlaps with any proper block.
		const overlaps = intervals.some((iv) => start < iv.end && end > iv.start);
		if (!overlaps) {
			const body = malformedMatch[1] ?? "";
			results.push({
				ok: false,
				error: `Malformed tool tag: missing '>' after '<tool'. Expected format: <tool>{"name":"...","arguments":{...}}</tool>.`,
				raw: body,
			});
		}
	}

	// Never fail the caller because of a stray block; surface a warning instead.
	const failures = results.filter((r) => !r.ok);
	if (failures.length > 0) {
		// eslint-disable-next-line no-console
		console.warn(
			`[tool-parser] skipped ${failures.length} unparseable <tool> block(s)`,
			failures.map((f) => f.error),
		);
	}

	return results;
}
