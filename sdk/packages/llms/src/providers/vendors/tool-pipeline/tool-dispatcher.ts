/**
 * Stage 3 of the tool-call pipeline: safe dispatch & error routing.
 *
 * Composes `extractToolCalls` (stage 1) with `validatePythonCode` (stage 2) to
 * turn a raw LLM response into an executable, validated tool list.
 *
 * For `editor` calls whose `new_text` contains Python, a malformed payload is
 * REJECTED — the tool is dropped from the executable set and a precise,
 * line-anchored retry prompt is produced so the model can correct itself on
 * the next turn. Zero silent failures, zero execution of invalid code.
 */

import { validatePythonCode } from "./python-validator";
import { extractToolCalls } from "./tool-parser";

/**
 * A tool call that survived extraction + validation and is safe to hand to the
 * executor. `arguments` keeps the raw, as-parsed argument map (the executor is
 * responsible for schema-shaping).
 */
export interface ValidTool {
	name: string;
	arguments: Record<string, unknown>;
}

/**
 * The value of an `editor` call's `new_text`, when present. Refined to a
 * string so downstream validation can rely on the shape.
 */
type EditorNewText = { new_text?: unknown };

/** Matches raw `<tool>` blocks when we only need to know whether any exist. */
const HAS_TOOL_RE = /<tool>[\s\S]*?<\/tool>/i;

/**
 * Result of processing a raw response through the full pipeline.
 */
export interface ProcessedResponse {
	/** Validated tools, safe to execute. */
	tools: ValidTool[];
	/**
	 * When present, at least one editor call embedded invalid Python. The
	 * rejected tools are NOT in `tools`; this prompt should be routed back into
	 * the conversation so the model re-emits corrected `<tool>` blocks.
	 */
	retryPrompt?: string;
}

/**
 * A tool call as produced by an upstream parser (e.g. the provider's
 * `parseDeepSeekToolCalls`). Shape-compatible with `ValidTool`.
 */
export interface ParsedToolInput {
	name: string;
	arguments: Record<string, unknown>;
}

/**
 * Validate a single tool against the pipeline's safety rules (currently: only
 * `editor.new_text` Python syntax). Returns the tool unchanged when it passes,
 * or an error message when it must be rejected.
 */
function validateSingleTool(
	tool: ParsedToolInput,
): { ok: true; value: ValidTool } | { ok: false; error: string } {
	// Only editor calls that actually carry `new_text` need Python checks.
	if (
		tool.name === "editor" &&
		typeof (tool.arguments as EditorNewText).new_text === "string"
	) {
		const python = (tool.arguments as EditorNewText).new_text as string;
		const validation = validatePythonCode(python);
		if (!validation.valid) {
			// Reject precisely, using the line-anchored message from stage 2.
			return { ok: false, error: validation.error ?? "invalid Python" };
		}
	}
	return { ok: true, value: { name: tool.name, arguments: tool.arguments } };
}

/**
 * Process a raw LLM response: extract `<tool>` blocks, repair loose JSON, and
 * reject any `editor.new_text` that fails Python syntax validation.
 *
 * Two kinds of model "tried to use a tool but failed" are surfaced back to the
 * model via `retryPrompt`:
 *   1. A `<tool>` block whose JSON could not be parsed (even after repair) —
 *      the tool name is unknown, so the message focuses on formatting.
 *   2. An `editor` call whose `new_text` failed Python syntax validation —
 *      reported with the tool name and a line-precise reason.
 * In both cases the offending attempt is NOT dispatched (never executed or
 * written to disk); the model is told exactly how to re-emit it correctly.
 *
 * @param rawResponse The full model reply.
 * @returns `{ tools, retryPrompt? }`. `retryPrompt` is set whenever any tool
 *          attempt was rejected (for any reason); `tools` only contains the
 *          validated, executable calls.
 */
export function processResponseForTools(
	rawResponse: string,
): ProcessedResponse {
	const results = extractToolCalls(rawResponse);

	const tools: ValidTool[] = [];
	const rejectionNotes: string[] = [];

	for (const result of results) {
		// Failed to parse the block's JSON — the model attempted a tool but its
		// formatting was broken. Report it as a caller-facing rejection so the
		// model gets feedback instead of an unexplained silent skip.
		if (!result.ok || !result.tool) {
			rejectionNotes.push(
				`Attempted a <tool> block but its JSON could not be parsed (${result.error ?? "unknown reason"}). ` +
					'Re-emit it as exactly: <tool>{"name": "<tool_name>", "arguments": { ... }}</tool>. ' +
					"Ensure every string is double-quoted, no trailing commas, and the argument " +
					"names/keys match the tool's schema.",
			);
			continue;
		}

		const outcome = validateSingleTool(result.tool);
		if (outcome.ok) {
			tools.push(outcome.value);
		} else {
			rejectionNotes.push(`[Tool: ${result.tool.name}] ${outcome.error}`);
		}
	}

	if (rejectionNotes.length === 0) {
		return { tools };
	}

	return { tools, retryPrompt: formatRetryPrompt(rejectionNotes) };
}

/**
 * Validate an array of already-parsed tool calls (e.g. the calls produced by an
 * upstream `<tool>` parser like the provider's `parseDeepSeekToolCalls`). This
 * is the integration entry point for the deepseek-web-v2 provider, so it can
 * reuse the parser + text-stripping it already has while still getting the
 * Python-validation gate and retry-prompt routing.
 *
 * @param toolCalls Parsed (but not yet validated) tool calls.
 * @returns `{ tools, retryPrompt? }` — invalid `editor` calls are dropped and
 *          reported in `retryPrompt` (when any were rejected).
 */
export function validateToolCalls(
	toolCalls: readonly ParsedToolInput[],
): ProcessedResponse {
	const tools: ValidTool[] = [];
	const validationErrors: string[] = [];

	for (const tool of toolCalls) {
		const outcome = validateSingleTool(tool);
		if (outcome.ok) {
			tools.push(outcome.value);
		} else {
			validationErrors.push(`[Tool: ${tool.name}] ${outcome.error}`);
		}
	}

	if (validationErrors.length === 0) {
		return { tools };
	}
	return { tools, retryPrompt: formatRetryPrompt(validationErrors) };
}

/**
 * Build the retry-prompt contract the model is told to honor. Each rejection
 * becomes one `Tool call rejected: ...` sentence:
 * - Python-in-`editor` rejections keep the canonical shape
 *   `Tool call rejected: [Tool: editor] Python syntax error at line ~X: [msg].`
 *   followed by the code-structure fix instruction.
 * - JSON-parse rejections carry their own formatting guidance (no tool name is
 *   known, so a generic re-emit instruction is given instead).
 * Multiple rejections are joined on one line — the model's prompt contract
 * allows several `<tool>` blocks, so it corrects them all at once.
 *
 * @param notes One rejection sentence-fragment per failed tool attempt. The
 *              `[Tool: ...]` prefix and any custom guidance are already
 *              included; this wrapper adds the canonical framing.
 */
function formatRetryPrompt(notes: string[]): string {
	const FIX_NOTE =
		"Fix the code structure (ensure bracket completion, variable name " +
		"consistency, and proper loop syntax) and emit a corrected <tool> block.";
	return notes
		.map((note) => {
			// Python-syntax rejections get the code-structure fix instruction.
			if (/\[Tool: editor\]/.test(note)) {
				return `Tool call rejected: ${note}. ${FIX_NOTE}`;
			}
			// Everything else (e.g. unparseable JSON) already says how to fix.
			return `Tool call rejected: ${note}`;
		})
		.join(" ");
}

/**
 * Idempotent guard: returns `true` when the raw response appears to contain a
 * `<tool>` block. Useful for cheap fast-paths before running full extraction.
 */
export function hasToolBlock(rawResponse: string): boolean {
	return HAS_TOOL_RE.test(rawResponse ?? "");
}
