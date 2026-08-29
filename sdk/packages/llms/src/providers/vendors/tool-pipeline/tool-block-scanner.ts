/**
 * Locating `<tool>` blocks without letting the payload end them early.
 *
 * The obvious way to find a block is a non-greedy regex — `<tool>([\s\S]*?)
 * </tool>`. That is unsound, because the closing tag is plain text that the
 * JSON body is allowed to contain. An `editor` call that writes this line:
 *
 *     const example = '<tool>' + JSON.stringify(call) + '</tool>';
 *
 * carries a literal `</tool>` inside a JSON string. The regex stops at that
 * one, so the captured body is a truncated JSON object, every parse and repair
 * pass fails, the call is dropped, and the rest of the block leaks into the
 * reply as prose. JSON escaping cannot prevent it: `<`, `/` and `>` are
 * ordinary characters in a JSON string, so a correctly-escaped payload still
 * contains the terminator verbatim. Any tool that edits code about tool
 * parsing hits this on every single attempt, and the model cannot fix it —
 * the block it sent was already well-formed.
 *
 * So the block's extent is decided by the JSON envelope, not by the tag: scan
 * the body as a balanced object while tracking string and escape state, and
 * treat `</tool>` as an optional terminator that follows it. A `</tool>` inside
 * a string is then invisible, which is the property the regex could never have.
 *
 * The tag-matching fallback is kept for bodies that are not a JSON object
 * (`<tool><name>x</name><arguments>{...}</arguments></tool>`), where there is
 * no envelope to scan and the old behavior is still the best available.
 */

/** Opening tag, tolerating `< tool>`, `<tool:name>`, and `id=`/`name=` attrs. */
const OPEN_TAG_RE = /<\s*tool(?::([\w-]+))?([^>]*)>/gi;

/** Closing tag, tolerating `</ tool >` and a `:name` suffix. */
const CLOSE_TAG_RE = /^<\s*\/\s*tool(?::[\w-]+)?\s*>/i;

/** A markdown fence the model sometimes wraps around the JSON body. */
const OPEN_FENCE_RE = /^```[a-zA-Z0-9_+-]*[ \t]*\r?\n?/;

export interface ToolBlockMatch {
	/** Index of the `<` that opens the block. */
	start: number;
	/** Index just past the block — past `</tool>` when one was present. */
	end: number;
	/** The `:name` suffix on the opening tag (`<tool:editor>`), without colon. */
	tagName: string;
	/** Raw attribute text inside the opening tag. */
	attrs: string;
	/** Body between the tags, trimmed. Fences are left on for the parser. */
	body: string;
	/** True when the extent came from the balanced-JSON scan. */
	scanned: boolean;
	/** True when no closing tag followed the body. */
	unterminated: boolean;
}

/**
 * Walk a balanced `{...}` (or `[...]`) starting at `from`, ignoring braces that
 * sit inside a JSON string. Returns the index just past the closing brace, or
 * `-1` when the object never balances (a truncated reply).
 */
function scanBalancedJson(text: string, from: number): number {
	const opener = text[from];
	if (opener !== "{" && opener !== "[") return -1;

	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = from; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{" || ch === "[") depth++;
		else if (ch === "}" || ch === "]") {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return -1;
}

/**
 * Index of the first `</tool>` at or after `from` that is NOT inside a JSON
 * string, or `-1`. Returns the length of the tag in `[index, length]`.
 *
 * Used when the envelope does not balance — a model that drops the object's
 * final `}` leaves nothing to scan, but the terminator it meant is still the
 * first one written outside a string. Choosing that one instead of the first
 * one in the raw text is what keeps a payload's own `'</tool>'` from cutting a
 * merely-unbalanced block down to nothing.
 */
function findClosingTagOutsideString(
	text: string,
	from: number,
): [number, number] | null {
	let inString = false;
	let escaped = false;

	for (let i = from; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch !== "<") continue;
		const close = CLOSE_TAG_RE.exec(text.slice(i));
		if (close) return [i, close[0].length];
	}
	return null;
}

/**
 * Find every `<tool>` block in `content`.
 *
 * Blocks are returned in order and never overlap: the scan resumes after the
 * end of the previous block, so a `<tool>` written inside a payload cannot open
 * a second block.
 */
export function scanToolBlocks(content: string): ToolBlockMatch[] {
	if (!content) return [];

	const matches: ToolBlockMatch[] = [];
	OPEN_TAG_RE.lastIndex = 0;
	let open: RegExpExecArray | null;

	while ((open = OPEN_TAG_RE.exec(content)) !== null) {
		const start = open.index;
		const afterTag = start + open[0].length;

		// Skip whitespace and an opening markdown fence to find where the body
		// really begins; the fence itself stays in `body` for the JSON parser,
		// which strips fences of its own accord.
		let cursor = afterTag;
		while (cursor < content.length && /\s/.test(content[cursor])) cursor++;
		const fence = OPEN_FENCE_RE.exec(content.slice(cursor));
		const jsonStart = fence ? cursor + fence[0].length : cursor;

		const jsonEnd = scanBalancedJson(content, jsonStart);
		let bodyEnd: number;
		let end: number;
		let scanned: boolean;
		let unterminated: boolean;

		if (jsonEnd !== -1) {
			// The envelope decided the extent. Consume an optional trailing fence
			// and closing tag; anything else after the object stays visible text.
			scanned = true;
			bodyEnd = jsonEnd;
			let tail = jsonEnd;
			while (tail < content.length && /\s/.test(content[tail])) tail++;
			if (content.startsWith("```", tail)) {
				tail += 3;
				while (tail < content.length && /[ \t]/.test(content[tail])) tail++;
			}
			while (tail < content.length && /\s/.test(content[tail])) tail++;
			const close = CLOSE_TAG_RE.exec(content.slice(tail));
			unterminated = close === null;
			end = close ? tail + close[0].length : jsonEnd;
		} else {
			// No usable envelope: either an XML-children body, or a JSON object the
			// model left unbalanced (dropping the final `}` is common). Fall back to
			// the first closing tag written OUTSIDE a string, so a payload that
			// contains `'</tool>'` still cannot end the block early. Repairing the
			// unbalanced braces is then the JSON layer's job.
			scanned = false;
			const close = findClosingTagOutsideString(content, afterTag);
			if (close === null) {
				bodyEnd = content.length;
				end = content.length;
				unterminated = true;
			} else {
				bodyEnd = close[0];
				end = close[0] + close[1];
				unterminated = false;
			}
		}

		matches.push({
			start,
			end,
			tagName: open[1] ?? "",
			attrs: (open[2] ?? "").trim(),
			body: content.slice(afterTag, bodyEnd).trim(),
			scanned,
			unterminated,
		});

		// Resume past this block so a `<tool>` inside the payload is not treated
		// as the start of another one.
		OPEN_TAG_RE.lastIndex = Math.max(end, afterTag);
	}

	return matches;
}
