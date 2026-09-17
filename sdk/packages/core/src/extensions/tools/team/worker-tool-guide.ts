import { isWebChatProvider } from "@cline/shared";

/**
 * How-to text for tools a web worker's own prompt does not teach.
 *
 * A worker on a web chat provider learns its tools from the simple web prompt,
 * which covers exactly two: PowerShell in a ```powershell fence (run as
 * `run_commands`) and `*** Begin Patch` blocks (`apply_patch`). A manager can
 * still grant `read_files` or `search_codebase` on a TOOLS: line, and the
 * worker then holds a tool whose name it has never seen and no idea how to
 * call. So the task message carries the missing instructions, only for the
 * tools that need them.
 */

/** Tools the web worker prompt already explains. */
const PROMPT_TAUGHT_TOOLS = new Set(["run_commands", "apply_patch"]);

const TOOL_CALL_FORMAT =
	'Call it by writing a block exactly like this, alone in your reply (no code fence around it):\n<tool>{"name":"TOOL_NAME","arguments":{...}}</tool>';

const TOOL_GUIDES: Record<string, string> = {
	read_files: `- read_files: read file contents, optionally a line range.
  <tool>{"name":"read_files","arguments":{"files":[{"path":"src/app.ts","start_line":1,"end_line":80}]}}</tool>
  Omit start_line/end_line to read from the top. Long files are capped, so page through with ranges.`,
	search_codebase: `- search_codebase: regex search across the workspace; returns file:line matches.
  <tool>{"name":"search_codebase","arguments":{"queries":["queuedMessage","onEscape"]}}</tool>`,
	editor: `- editor: replace text in a file, create a file, or insert lines.
  <tool>{"name":"editor","arguments":{"path":"C:/abs/path/file.ts","old_text":"exact text that appears once","new_text":"replacement"}}</tool>
  path must be absolute. Omit old_text to create a new file with new_text. Use "insert_line": N (1-based) instead of old_text to insert before line N. Keep each edit small.`,
	fetch_web_content: `- fetch_web_content: fetch a web page and answer a question about it.
  <tool>{"name":"fetch_web_content","arguments":{"requests":[{"url":"https://example.com/docs","prompt":"What does it say about X?"}]}}</tool>`,
};

/**
 * Returns the task with tool instructions appended, or the task unchanged
 * when the grant only holds tools the worker's prompt already covers.
 *
 * `providerId` undefined means the worker inherits the session's provider,
 * which in manager mode is a web provider as often as not; the guide is added
 * then too, since a few extra lines cost far less than a stalled worker.
 */
export function appendWorkerToolGuide(
	task: string,
	tools: string[] | undefined,
	providerId: string | undefined,
): string {
	if (!tools || tools.length === 0) return task;
	if (providerId && !isWebChatProvider(providerId)) return task;
	const extra = tools.filter((name) => !PROMPT_TAUGHT_TOOLS.has(name));
	if (extra.length === 0) return task;
	const guides = extra.map(
		(name) =>
			TOOL_GUIDES[name] ??
			`- ${name}: <tool>{"name":"${name}","arguments":{...}}</tool>`,
	);
	return `${task}

---
Tools for this task, beyond PowerShell and apply_patch. ${TOOL_CALL_FORMAT}

${guides.join("\n")}

Send one tool call, wait for its result, then continue. PowerShell and apply_patch still work as usual.`;
}
