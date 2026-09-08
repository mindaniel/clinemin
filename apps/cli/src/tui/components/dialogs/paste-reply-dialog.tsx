import type { ChoiceContext } from "@opentui-ui/dialog";
import { useDialogKeyboard } from "@opentui-ui/dialog/react";
import { useState } from "react";
import { palette } from "../../palette";
import { describePasteReply } from "./paste-reply-preview";

const PREVIEW_LINES = 12;
const PREVIEW_LINE_WIDTH = 96;

function previewRows(text: string): { rows: string[]; hiddenLines: number } {
	const all = text.split("\n");
	const rows = all.slice(0, PREVIEW_LINES).map((line) => {
		const flattened = line.replace(/\t/g, "  ");
		return flattened.length > PREVIEW_LINE_WIDTH
			? `${flattened.slice(0, PREVIEW_LINE_WIDTH - 1)}…`
			: flattened;
	});
	return { rows, hiddenLines: Math.max(0, all.length - PREVIEW_LINES) };
}

/**
 * Dialog content for `/paste`: show what is on the clipboard before it is
 * queued as the model's reply.
 *
 * Enter accepts it, `r` re-reads the clipboard (copy the right thing in the
 * browser, then press `r` without leaving the dialog), Escape cancels and
 * queues nothing.
 */
export function PasteReplyDialogContent(
	props: ChoiceContext<string> & {
		initialText: string;
		readClipboard: () => Promise<string>;
		providerName: string;
	},
) {
	const {
		resolve,
		dismiss,
		dialogId,
		initialText,
		readClipboard,
		providerName,
	} = props;
	const [preview, setPreview] = useState(() => describePasteReply(initialText));
	const [rereading, setRereading] = useState(false);

	useDialogKeyboard(async (key) => {
		if (key.name === "escape") {
			dismiss();
			return;
		}
		if (key.name === "r") {
			setRereading(true);
			try {
				setPreview(describePasteReply(await readClipboard()));
			} finally {
				setRereading(false);
			}
			return;
		}
		if (key.name === "return" || key.name === "enter") {
			if (preview.text) resolve(preview.text);
		}
	}, dialogId);

	if (!preview.text) {
		return (
			<box flexDirection="column" paddingX={1} gap={1}>
				<text>Paste a {providerName} reply</text>
				<text fg={palette.error}>
					The clipboard is empty. Copy the reply from the browser, then press r.
				</text>
				<text fg={palette.muted}>
					<em>
						{rereading ? "Reading clipboard..." : "r to re-read, Esc to cancel"}
					</em>
				</text>
			</box>
		);
	}

	const { rows, hiddenLines } = previewRows(preview.text);

	return (
		<box flexDirection="column" paddingX={1} gap={1}>
			<text>Paste a {providerName} reply</text>

			<text fg={preview.looksLikeToolCall ? palette.success : palette.plan}>
				{preview.looksLikeToolCall
					? `Looks like a tool call${
							preview.toolNames.length > 0
								? `: ${preview.toolNames.join(", ")}`
								: ""
						}`
					: "No tool call found — this will be treated as a plain text answer"}
			</text>

			<box
				border
				borderStyle="rounded"
				borderColor={palette.muted}
				flexDirection="column"
				paddingX={1}
			>
				{rows.map((row, index) => (
					// Clipboard lines have no identity of their own, and the preview is
					// re-rendered wholesale on every re-read, so the index is stable.
					// biome-ignore lint/suspicious/noArrayIndexKey: no better key exists
					<text key={index} fg={palette.muted}>
						{row === "" ? " " : row}
					</text>
				))}
				{hiddenLines > 0 ? (
					<text fg={palette.muted}>
						<em>... {hiddenLines} more line(s)</em>
					</text>
				) : null}
			</box>

			<text fg={palette.muted}>
				{preview.text.length} chars, {preview.lines} line(s)
			</text>

			<text fg={palette.muted}>
				<em>
					{rereading
						? "Reading clipboard..."
						: "Enter to send it to the model, r to re-read the clipboard, Esc to cancel"}
				</em>
			</text>
		</box>
	);
}
