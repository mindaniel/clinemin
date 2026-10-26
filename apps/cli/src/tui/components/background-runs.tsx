import type { BackgroundRunItem } from "../hooks/use-background-runs";
import { palette } from "../palette";

/** Width of the panel when it sits beside the chat. */
export const BACKGROUND_RUNS_PANEL_WIDTH = 36;

function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60)
		return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function statusMark(status: BackgroundRunItem["status"]): {
	mark: string;
	color: string;
} {
	switch (status) {
		case "queued":
			return { mark: "…", color: palette.muted };
		case "running":
			return { mark: "●", color: palette.act };
		case "completed":
			return { mark: "✓", color: palette.success };
		default:
			return { mark: "✗", color: palette.error };
	}
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Workers running a manager's job in the background. Beside the chat on a
 * wide terminal, above the input on a narrow one.
 */
export function BackgroundRuns(props: {
	runs: BackgroundRunItem[];
	now: number;
	/** Panel width in columns, or undefined to fill the row. */
	width?: number;
}) {
	if (props.runs.length === 0) return null;
	const textWidth = (props.width ?? 60) - 4;
	const active = props.runs.filter(
		(run) => run.status === "running" || run.status === "queued",
	).length;

	return (
		<box
			flexDirection="column"
			border
			borderStyle="rounded"
			borderColor="gray"
			paddingX={1}
			width={props.width}
			flexShrink={0}
		>
			<text fg="gray">
				<em>
					{active > 0
						? `Background workers (${active} busy)`
						: "Background workers"}
				</em>
			</text>
			{props.runs.map((run) => {
				const { mark, color } = statusMark(run.status);
				const elapsed = formatElapsed(
					(run.endedAt ?? props.now) - run.startedAt,
				);
				const finished = run.endedAt !== undefined;
				return (
					<box key={run.runId} flexDirection="column">
						<text>
							<span fg={color}>{mark} </span>
							<span fg={finished ? palette.muted : undefined}>
								{truncate(run.agentId, Math.max(8, textWidth - 10))}
							</span>
							<span fg={palette.muted}> {elapsed}</span>
						</text>
						{run.activity ? (
							<text fg={palette.muted}>
								{`  ${truncate(run.activity, Math.max(8, textWidth - 2))}`}
							</text>
						) : null}
					</box>
				);
			})}
		</box>
	);
}
