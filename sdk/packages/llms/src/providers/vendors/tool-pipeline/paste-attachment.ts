/**
 * Long prompts as pasted attachments, shared by the web providers.
 *
 * chat.deepseek.com and chatgpt.com both turn a long paste into an attached
 * text file, which is what a person gets by pasting a whole paper or source
 * file. A provider that does the same pastes the long part and types only a
 * short message next to it.
 */

/**
 * A prompt holds this line to say which part is the attachment: the text
 * before it is typed as the message, the text after it goes in as the file
 * (`PASTED_FILE_MESSAGE` is typed when nothing comes before it). Only marked
 * text is ever attached: an agent's opening turn carries its system prompt and
 * tool contract, and a model that finds those in an attachment reads them as
 * a document and decides it has no tools. `attachToolResults` marks tool
 * output; scripts mark the documents they send.
 */
export const ATTACH_MARKER = "<<<ATTACH>>>";

/** Typed as the message when the whole prompt went in as an attachment. */
export const PASTED_FILE_MESSAGE =
	"My full message is in the attached file. Read all of it and follow the instructions in it.";

export interface AttachmentSplit {
	/** Typed before the attachment ("" when the prompt has no marker). */
	head: string;
	/** What would go in as the attachment. */
	body: string;
	marked: boolean;
}

export function splitAttachment(prompt: string): AttachmentSplit {
	const at = prompt.indexOf(ATTACH_MARKER);
	if (at < 0) return { head: "", body: prompt, marked: false };
	return {
		head: prompt.slice(0, at).trim(),
		body: prompt.slice(at + ATTACH_MARKER.length).trim(),
		marked: true,
	};
}

/** The text to type, given whether `split.body` went in as an attachment. */
export function typedMessage(
	prompt: string,
	split: AttachmentSplit,
	attached: boolean,
): string {
	if (attached) return split.head || PASTED_FILE_MESSAGE;
	// A trailing marker with nothing after it means "type all of this".
	return split.marked
		? [split.head, split.body].filter(Boolean).join("\n\n")
		: prompt;
}

/** Labels that open a tool result (`formatToolResult` in deepseek-web/prompt.ts). */
const TOOL_RESULT_LABELS = "path|Output|Error|Tool result";

/** Labels that start a segment in the flat web prompt (see deepseek-web/prompt.ts). */
const SEGMENT_LABELS = `${TOOL_RESULT_LABELS}|Assistant|Note|My last message|Previous user message|User`;

/**
 * Move this turn's tool-result segments behind the attach marker, so a long
 * file read or command output goes in as an attachment while the note that
 * follows it is still typed. Left as is when the prompt already has a marker
 * or the tool results are shorter than `minChars`.
 */
export function attachToolResults(prompt: string, minChars: number): string {
	if (minChars <= 0 || prompt.includes(ATTACH_MARKER)) return prompt;
	const segment = new RegExp(
		`(?:^|\\n\\n)(?:${TOOL_RESULT_LABELS}):[\\s\\S]*?(?=\\n\\n(?:${SEGMENT_LABELS}):|$)`,
		"g",
	);
	const results = (prompt.match(segment) ?? []).map((s) => s.trim());
	const body = results.join("\n\n");
	if (body.length < minChars) return prompt;
	const head = prompt.replace(segment, "").trim();
	return [
		head,
		"The tool results for this turn are in the attached file.",
		ATTACH_MARKER,
		body,
	]
		.filter(Boolean)
		.join("\n\n");
}

/** Page expression: paste `text` into `editorExpr` like Ctrl+V. True when the page handled it. */
export function buildPasteScript(editorExpr: string, text: string): string {
	return `(() => {
  const ed = ${editorExpr};
  if (!ed) return false;
  ed.focus();
  const dt = new DataTransfer();
  dt.setData('text/plain', ${JSON.stringify(text)});
  return !ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
})()`;
}
