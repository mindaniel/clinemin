import { normalizeToolName } from "../deepseek-web";

/**
 * Recovery for tool calls written in Anthropic's `<invoke>` XML instead of our
 * `<tool>{json}</tool>` contract.
 *
 * Every big model has seen a lot of Anthropic-style tool use in training, so
 * under load — long turn, many tools, an argument whose JSON is awkward to
 * write inline — a web model will open our tag correctly and then fill it with
 * the syntax it knows best:
 *
 *     <tool>
 *       <invoke name="read_files">
 *         <parameter name="files">[{"path": "a.ts", "start_line": 1}]</parameter>
 *       </invoke>
 *
 * The tool name and the arguments are right; only the envelope is wrong. This
 * is not DeepSeek-specific — it shows up on every web provider.
 *
 * Rejecting these and asking for a resend does not work well in practice: the
 * model reaches for the same format again. Parsing them does, because the
 * intent is unambiguous.
 *
 * ## Why this is a safe rung to add
 *
 * It runs only after the strict and loose `<tool>` JSON parsers found nothing,
 * and it only emits calls whose name (after the usual alias normalising) is one
 * of the tools actually wired up for the turn. Prose that merely mentions the
 * word "invoke" cannot produce a call, and a reply that already parsed as real
 * `<tool>` JSON never reaches here.
 */

export interface ParsedInvokeCall {
	name: string;
	arguments: Record<string, unknown>;
}

/**
 * Parameter bodies arrive as text. Only convert the shapes where the intent is
 * unambiguous — arrays, objects, the JSON literals, and plain integers — and
 * leave everything else a string.
 *
 * Deliberately does NOT convert decimals or quoted-looking text: a version
 * `"1.0"` or an id `"007"` would come back as `1` / `7` and silently corrupt an
 * argument that was meant to stay a string. A tool wanting a real number from a
 * decimal is rarer than a string that looks like one.
 */
function coerceParameterValue(raw: string): unknown {
	const value = raw.trim();
	if (value === "true") return true;
	if (value === "false") return false;
	if (value === "null") return null;
	if (/^-?\d+$/.test(value)) {
		const asNumber = Number(value);
		if (Number.isSafeInteger(asNumber)) return asNumber;
		return value;
	}
	if (value.startsWith("[") || value.startsWith("{")) {
		try {
			return JSON.parse(value);
		} catch {
			// A Windows path written with single backslashes is the usual cause.
			// JSON needs each backslash doubled, and a lone one in front of `U`
			// (or any non-escape letter) is a parse error. Double the lone
			// backslashes and retry once.
			try {
				return JSON.parse(value.replace(/\\(?![\\"/bfnrtu])/g, "\\\\"));
			} catch {
				// Still malformed — hand the raw text to the tool's own schema
				// validation, which produces a better message than we could here.
				return value;
			}
		}
	}
	return value;
}

const INVOKE_PATTERN =
	/<\s*invoke\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)(?:<\s*\/\s*invoke\s*>|(?=<\s*invoke\b)|$)/gi;

const PARAMETER_PATTERN =
	/<\s*parameter\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)(?:<\s*\/\s*parameter\s*>|(?=<\s*parameter\b)|(?=<\s*\/\s*invoke\b)|$)/gi;

/**
 * Pull Anthropic-style `<invoke>` tool calls out of a reply, returning the
 * calls and the text with those blocks removed.
 *
 * Unclosed tags are tolerated: a reply that gets cut off mid-call, or that
 * omits `</invoke>`, still yields the call. Only names in `toolNames` (alias
 * normalised) are emitted; anything else is left in the visible text.
 */
export function parseInvokeStyleToolCalls(
	content: string,
	toolNames: readonly string[],
): { cleanedContent: string; toolCalls: ParsedInvokeCall[] } {
	const accepted = new Set(toolNames.map(normalizeToolName));
	const toolCalls: ParsedInvokeCall[] = [];
	const cleanedParts: string[] = [];
	let cursor = 0;

	INVOKE_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = INVOKE_PATTERN.exec(content)) !== null) {
		const rawName = match[1] ?? "";
		const body = match[2] ?? "";
		const name = normalizeToolName(rawName);
		if (!accepted.has(name)) {
			// Not one of our tools — leave the block in the visible text rather
			// than inventing a call.
			continue;
		}

		cleanedParts.push(content.slice(cursor, match.index));
		cursor = match.index + match[0].length;

		const args: Record<string, unknown> = {};
		PARAMETER_PATTERN.lastIndex = 0;
		let parameter: RegExpExecArray | null;
		while ((parameter = PARAMETER_PATTERN.exec(body)) !== null) {
			const key = (parameter[1] ?? "").trim();
			if (!key) continue;
			args[key] = coerceParameterValue(parameter[2] ?? "");
		}

		toolCalls.push({ name, arguments: args });
	}

	if (toolCalls.length === 0) {
		return { cleanedContent: content, toolCalls: [] };
	}

	cleanedParts.push(content.slice(cursor));
	// The wrapper the model opened around the invoke block (`<tool>`, usually
	// unclosed) is now an orphan; drop it so it isn't shown as prose.
	const cleanedContent = cleanedParts
		.join("")
		.replace(/<\s*\/?\s*tool\s*>/gi, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	return { cleanedContent, toolCalls };
}
