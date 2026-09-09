import { jsonrepair } from "jsonrepair";
import { parsePatchBlocks } from "../tool-pipeline/patch-block";
import { scanToolBlocks } from "../tool-pipeline/tool-block-scanner";

// ── Tool-call parsing ──────────────────────────────────────────────────────

export interface ParsedToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

/**
 * Normalize common tool-name mistakes the DeepSeek web model makes into their
 * real names. `_codebase` (for `search_codebase`) and similar are frequent
 * enough that recovering them recovers the actual search instead of silently
 * dropping the call. Keys are matched case-insensitively (after trim).
 */
const TOOL_NAME_ALIASES: Record<string, string> = {
	_codebase: "search_codebase",
	codebase: "search_codebase",
	search: "search_codebase",
	searchcodebase: "search_codebase",
	search_code: "search_codebase",
	bash: "run_commands",
	shell: "run_commands",
	command: "run_commands",
	cmd: "run_commands",
	execute: "run_commands",
	execute_command: "run_commands",
	exec_command: "run_commands",
	run: "run_commands",
	runcommand: "run_commands",
	run_command: "run_commands",
	commands: "run_commands",
	terminal: "run_commands",
	read: "read_files",
	readfile: "read_files",
	read_files: "read_files", // identity, harmless
	"file-read": "read_files",
	file_read: "read_files",
	view: "read_files",
	fetch: "fetch_web_content",
	fetch_web: "fetch_web_content",
	"web-fetch": "fetch_web_content",
	web_fetch: "fetch_web_content",
	"http-get": "fetch_web_content",
	http_get: "fetch_web_content",
	write: "editor",
	write_file: "editor",
	edit: "editor",
	edit_file: "editor",
	"edit-file": "editor",
	edits: "editor",
	write_file_from_contents: "editor",
	update: "editor",
	patch: "editor",
	apply_patch: "editor",
	create_file: "editor",
	replace: "editor",
	grep: "search_codebase",
	glob: "search_codebase",
	file_search: "search_codebase",
	search_files: "search_codebase",
	list_code_definition_names: "search_codebase",
	spawn: "spawn_agent",
	spawn_agent_tool: "spawn_agent",
	skill: "skills",
	ask_user: "ask_question",
	question: "ask_question",
};

export function normalizeToolName(name: string): string {
	const key = name.trim().toLowerCase();
	return TOOL_NAME_ALIASES[key] ?? key;
}

/**
 * Parse `<tool>{json}</tool>` blocks from the model's reply into tool calls,
 * and strip them from the visible text. Handles the canonical shape
 * `{"name": "x", "arguments": {...}}` plus common DeepSeek variants
 * (`<tool:name>`, `{"type": "x", "params": {...}}`, XML children).
 *
 * Tolerant of noisy model output: allows a space in the tags (`< tool>`,
 * `</tool >`), ignores markdown bullets/asterisks immediately around a block,
 * repairs common broken JSON (trailing commas, single quotes, stray leading
 * text), and normalizes common tool-name mistakes (`_codebase` →
 * `search_codebase`, `bash` → `run_commands`, etc.).
 */
export function parseDeepSeekToolCalls(
	content: string,
	toolNames: string[],
): { cleanedContent: string; toolCalls: ParsedToolCall[] } {
	// Some DeepSeek web replies drop the `>` after `<tool` when the JSON body
	// is pushed to a new line (`<tool\n{"name":...}`) instead of staying on
	// the same line (`<tool {"name":...}`). Both look identical to the tag
	// matcher below without a `>`, so repair them the same way: insert the
	// missing `>` whenever `<tool` (optionally `:name`) is directly followed
	// by whitespace/newline and then `{`, with no `>` in between.
	content = content.replace(
		/<tool(:[\w-]+)?\s+(?=\{)/gi,
		(_m, suffix: string | undefined) => `<tool${suffix ?? ""}>`,
	);

	// Alias-aware accepted names so near-miss model output still executes.
	const accepted = new Set(toolNames.map(normalizeToolName));
	const toolCalls: ParsedToolCall[] = [];
	const cleanedParts: string[] = [];
	let cursor = 0;
	// Where each block ENDS is decided by a string-aware scan of its JSON
	// envelope, not by the first `</tool>` in the text. A payload is allowed to
	// contain that tag verbatim — an `editor` call writing a line like
	// `const example = '<tool>' + json + '</tool>';` does — and a non-greedy
	// regex would stop inside the string, truncate the JSON, and drop a call
	// that was perfectly well-formed. See tool-block-scanner.ts.
	for (const block of scanToolBlocks(content)) {
		const full = content.slice(block.start, block.end);
		const tagName = block.tagName;
		const attrs = block.attrs;
		let inner = block.body;
		const matchIndex = block.start;
		// The tag itself is stripped while surrounding prose stays visible text.
		cleanedParts.push(content.slice(cursor, matchIndex));
		cursor = block.end;

		// Extract the tool name from tag suffix, id/name attributes, XML, or the
		// JSON body.
		const nameMatch = /(?:id|name)\s*=\s*["']([^"']+)["']/i.exec(attrs);
		let name = tagName || nameMatch?.[1] || "";

		// <tool><name>x</name><arguments>{...}</arguments></tool>
		// `<tool_name>` and `<tool_arguments>` are the same call written with the
		// prefix the model already used on the wrapper. Qwen sent
		//
		//     <tool_calls>
		//     <tool>
		//     <tool_name>run_commands</tool_name>
		//     <arguments>{"commands": "..."}</arguments>
		//     </tool>
		//
		// which found no `<name>`, left `name` empty, and fell through to "unknown
		// tool - keep the raw block as visible text". The manager then had to
		// notice the command had not run and ask for it again. Accepting the
		// prefixed spelling costs nothing: an unknown name is still rejected
		// below, so this widens what is recognised, not what is executed.
		const xmlName = /<(?:tool_)?name>([^<]+)<\/(?:tool_)?name>/i.exec(inner);
		const xmlArgs =
			/<(?:tool_)?arguments>([\s\S]*?)<\/(?:tool_)?arguments>/i.exec(inner);
		if (xmlName) name = xmlName[1].trim();
		if (xmlArgs) inner = xmlArgs[1].trim();

		const jsonText = inner;
		let args: unknown;

		try {
			const parsed = parseRepairedToolJson(jsonText) as
				| Record<string, unknown>
				| undefined;
			if (parsed) {
				const record = parsed as Record<string, unknown>;
				args = record.arguments ?? record.params;
				if (!name) name = typeof record.name === "string" ? record.name : "";
				if (!name) name = typeof record.type === "string" ? record.type : "";
				if (args === undefined && typeof record.arguments_json === "string") {
					try {
						args = JSON.parse(record.arguments_json);
					} catch {
						args = undefined;
					}
				}
				// <tool:name>{...args...}</tool:name> — bare JSON body is args.
				if (
					args === undefined &&
					name &&
					record.name === undefined &&
					record.type === undefined &&
					record.arguments_json === undefined
				) {
					args = record;
				}
			}
		} catch {
			args = undefined;
		}

		const normalizedName = normalizeToolName(name);
		if (!name || !accepted.has(normalizedName)) {
			// Unknown tool name — keep the raw block as visible text so the
			// user sees what was said instead of it disappearing silently.
			cleanedParts.push(full);
			continue;
		}
		toolCalls.push({
			name: normalizedName,
			arguments:
				args && typeof args === "object" && !Array.isArray(args)
					? (args as Record<string, unknown>)
					: {},
		});
	}
	cleanedParts.push(content.slice(cursor));

	// A bare `*** Begin Patch` block is `apply_patch` written as text instead of
	// as JSON, which is the only sane way to send a patch body through a chat
	// box. Gated on the session actually having the tool, so a provider still on
	// `editor` is untouched. See tool-pipeline/patch-block.ts.
	const patched = parsePatchBlocks(cleanedParts.join("").trim(), toolNames);
	toolCalls.push(...patched.toolCalls);

	return { cleanedContent: patched.cleanedContent, toolCalls };
}

/**
 * Catch tool calls the strict paired-tag regex in `parseDeepSeekToolCalls`
 * misses because the model emitted a "wrong" (but still recognizable) shape:
 * a bare `<tool name="...">`, an unbalanced `<tool>...</tool>`, or any
 * `<tool...>`-prefixed block whose closing tag is absent/malformed.
 *
 * This is a best-effort recovery: it extracts a candidate name (from a
 * `name`/`type` attribute or from a JSON body) and parses any trailing JSON
 * object as the argument map. If the result doesn't normalize to a known tool,
 * it returns an empty list so the caller falls through to its other handling.
 */
export function parseLooseDeepSeekToolCalls(
	content: string,
	toolNames: string[],
): ParsedToolCall[] {
	// See the matching repair pass in parseDeepSeekToolCalls: recover a `<tool`
	// tag whose `>` was dropped before a newline/space-then-`{` JSON body.
	content = content.replace(
		/<tool(:[\w-]+)?\s+(?=\{)/gi,
		(_m, suffix: string | undefined) => `<tool${suffix ?? ""}>`,
	);

	const accepted = new Set(toolNames.map(normalizeToolName));
	const toolCalls: ParsedToolCall[] = [];

	const openTagRe = /<\s*tool[\w:-]*\b([^>]*)>/gi;
	let match: RegExpExecArray | null;
	while ((match = openTagRe.exec(content)) !== null) {
		const attrs = (match[1] ?? "").trim();
		const afterTag = content.slice(match.index + match[0].length);

		let name = /(?:id|name)\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? "";

		let args: Record<string, unknown> = {};
		const bodyText = extractBalancedJsonValue(afterTag) ?? afterTag;
		const parsed = parseRepairedToolJson(bodyText);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const record = parsed as Record<string, unknown>;
			if (!name) {
				name =
					typeof record.name === "string"
						? record.name
						: typeof record.type === "string"
							? record.type
							: "";
			}
			const candidate =
				record.arguments ?? record.params ?? record.arguments_json ?? record;
			if (
				candidate &&
				typeof candidate === "object" &&
				!Array.isArray(candidate)
			) {
				args = candidate as Record<string, unknown>;
			}
		}

		const normalizedName = normalizeToolName(name);
		if (!normalizedName || !accepted.has(normalizedName)) continue;

		if (toolCalls.some((c) => c.name === normalizedName)) continue;

		toolCalls.push({ name: normalizedName, arguments: args });
	}

	return toolCalls;
}

/**
 * Extract the first balanced top-level JSON value (`{...}` or `[...]`) from a
 * string, tracking braces/brackets and strings so nested objects are handled.
 * Returns `null` if no balanced value is found. Used to strip trailing junk
 * (e.g. a stray `</tool>`) that would otherwise break the JSON repair parser.
 */
function extractBalancedJsonValue(text: string): string | null {
	const start = text.search(/[[{]/);
	if (start === -1) return null;
	const openChar = text[start];
	const closeChar = openChar === "{" ? "}" : "]";
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === openChar) depth++;
		else if (ch === closeChar) {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

/**
 * Parse the JSON body of a `<tool>` block, repairing common malformed output
 * the web model emits. Returns the parsed object, or `undefined` if it cannot
 * be recovered (in which case the block is treated as plain visible text).
 *
 * Safety: a block that is ALREADY valid JSON is returned verbatim — repair is
 * only attempted on genuinely-broken input, and the single-quote converter is
 * quote-aware so it never rewrites single quotes that live inside an already
 * double-quoted JSON string (e.g. a PowerShell command containing `'name'`).
 */
export function parseRepairedToolJson(raw: string): unknown {
	let text = raw.trim();
	if (!text) return undefined;

	// Pull the first balanced top-level JSON object if the block has prose.
	if (!/^[\s]*[{[]/.test(text)) {
		const objStart = text.indexOf("{");
		if (objStart === -1) return undefined;
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let i = objStart; i < text.length; i++) {
			const ch = text[i];
			if (inString) {
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') inString = true;
			else if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					text = text.slice(objStart, i + 1);
					break;
				}
			}
		}
	}

	// Fast path: already-valid JSON must pass through untouched.
	try {
		return JSON.parse(text);
	} catch {
		// fall through to repair
	}

	// Repair pass (only reached when plain JSON.parse failed above):
	//  - strip surrounding code-fence markers,
	//  - drop trailing commas,
	//  - fix invalid single-backslash escapes (the model often emits Windows
	//    paths like `C:\Users` inside a JSON string, where `\U` is an illegal
	//    escape and must become `\\U`),
	//  - convert single-quoted strings — skipping any quotes inside double-quoted
	//    JSON strings — so genuinely-broken input recovers without mangling
	//    values that legitimately contain single quotes (e.g. `'path'`).
	const repairedFinal = repairQuotesAndEscapes(
		text
			.replace(/^\s*```(?:json)?\s*/i, "")
			.replace(/\s*```\s*$/i, "")
			.replace(/,\s*([}\]])/g, "$1"),
	);
	try {
		return JSON.parse(repairedFinal);
	} catch {
		// Last rung: structural repair. The passes above fix characters inside an
		// otherwise well-formed envelope; they cannot close an object the model
		// never closed. Dropping the final `}` of a long `editor` call is one of
		// the most common ways a web reply arrives broken, and `jsonrepair`
		// completes the missing bracket. It is syntax-only — it never edits the
		// code carried inside `new_text`.
		try {
			return JSON.parse(jsonrepair(repairedFinal));
		} catch {
			return undefined;
		}
	}
}

/**
 * Convert single-quoted strings to JSON double-quoted strings, skipping any
 * single quotes that appear inside an already double-quoted JSON string value
 * (which are literal characters and must be preserved), AND repair invalid
 * single-backslash escapes inside double-quoted strings (e.g. `\U` from a
 * Windows path `C:\Users` → `\\U`) so the JSON parses.
 */
function repairQuotesAndEscapes(text: string): string {
	let out = "";
	let inDouble = false;
	let inSingle = false;
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (inDouble) {
			if (ch === "\\") {
				const next = text[i + 1];
				// Valid JSON escapes stay as-is; a backslash followed by anything
				// else is an illegal escape (common in Windows paths) — double it.
				if (
					next === '"' ||
					next === "\\" ||
					next === "/" ||
					next === "b" ||
					next === "f" ||
					next === "n" ||
					next === "r" ||
					next === "t" ||
					next === "u"
				) {
					out += `\\${next ?? ""}`;
					i += 2;
				} else if (next === undefined) {
					out += "\\\\";
					i += 1;
				} else {
					out += "\\\\" + next;
					i += 2;
				}
				continue;
			}
			out += ch;
			if (ch === '"') inDouble = false;
			i++;
			continue;
		}
		if (inSingle) {
			if (ch === "\\") {
				const next = text[i + 1];
				out += `\\${next ?? "\\\\"}`;
				i += 2;
				continue;
			}
			if (ch === "'") {
				out += '"';
				inSingle = false;
			} else {
				out += ch;
			}
			i++;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			out += ch;
		} else if (ch === "'") {
			inSingle = true;
			out += '"';
		} else {
			out += ch;
		}
		i++;
	}
	return out;
}
