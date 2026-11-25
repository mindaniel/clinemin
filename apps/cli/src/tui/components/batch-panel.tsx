import path from "node:path";
import type { BatchItem, BatchPrompt } from "../hooks/use-batch-runner";
import { palette } from "../palette";

const MARK: Record<BatchItem["status"], string> = {
	pending: "○",
	running: "▶",
	done: "✓",
	error: "✗",
};

const COLOR: Record<BatchItem["status"], string> = {
	pending: "gray",
	running: "yellow",
	done: "green",
	error: "red",
};

const MAX_ROWS = 8;

/** `/runbatch` panes: the prompt on the left, the batch files on the right. */
export function BatchPanel(props: {
	prompt: BatchPrompt | null;
	batches: BatchItem[];
	running: boolean;
}) {
	const { prompt, batches, running } = props;
	const preview = (prompt?.text ?? "")
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
		.slice(0, MAX_ROWS - 2);
	const done = batches.filter((b) => b.status === "done").length;
	const firstShown = Math.max(
		0,
		Math.min(
			batches.findIndex(
				(b) => b.status === "running" || b.status === "pending",
			),
			batches.length - MAX_ROWS,
		),
	);
	const shown = batches.slice(firstShown, firstShown + MAX_ROWS);
	const hint = running
		? "Running. Esc stops the current batch; /runbatch stop pauses after it."
		: !prompt
			? "Type or paste the prompt, or drag the prompt .txt in, then Enter."
			: batches.length === 0
				? "Drag the batch files in (several at once is fine), then Enter."
				: "Type go to run. /runbatch prompt replaces the prompt, /runbatch off leaves.";

	return (
		<box flexDirection="column" flexShrink={0}>
			<box flexDirection="row">
				<box
					flexDirection="column"
					border
					borderStyle="rounded"
					borderColor={prompt ? "gray" : palette.selection}
					paddingX={1}
					width="50%"
				>
					<text fg="gray">
						<em>
							Prompt
							{prompt
								? ` · ${prompt.source ? path.basename(prompt.source) : "typed"} · ${prompt.text.length} chars`
								: " · empty"}
						</em>
					</text>
					{preview.length === 0 ? (
						<text fg="gray">(none yet)</text>
					) : (
						preview.map((line, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: static preview lines
							<text key={i}>
								{line.length > 70 ? `${line.slice(0, 70)}…` : line}
							</text>
						))
					)}
				</box>
				<box
					flexDirection="column"
					border
					borderStyle="rounded"
					borderColor={
						prompt && batches.length === 0 ? palette.selection : "gray"
					}
					paddingX={1}
					width="50%"
				>
					<text fg="gray">
						<em>
							Batches · {done}/{batches.length} saved
						</em>
					</text>
					{batches.length === 0 ? (
						<text fg="gray">(none yet)</text>
					) : (
						shown.map((b) => (
							<text key={b.path} fg={COLOR[b.status]}>
								{MARK[b.status]} {path.basename(b.path)}
								{b.outPath ? ` → ${path.basename(b.outPath)}` : ""}
								{b.status === "error" && b.detail
									? ` (${b.detail.slice(0, 40)})`
									: ""}
							</text>
						))
					)}
					{batches.length > shown.length && (
						<text fg="gray">… {batches.length - shown.length} more</text>
					)}
				</box>
			</box>
			<text fg="gray">
				<em> {hint}</em>
			</text>
		</box>
	);
}
