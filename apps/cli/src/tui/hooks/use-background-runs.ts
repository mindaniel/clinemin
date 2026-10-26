/**
 * Background worker runs, as the side panel shows them.
 *
 * A manager can hand a job to a worker with `BACKGROUND: yes` and end its turn
 * while the worker keeps going (see `team_run_task`). Nothing in the transcript
 * says that worker is still busy, so this follows the team's run lifecycle and
 * keeps one row per run: who, how long, and what it is doing right now.
 *
 * A sync delegation never creates a run record, so only background work shows
 * up here.
 */

import { useCallback, useEffect, useState } from "react";
import type { TeamProgressUpdate } from "../../runtime/session-events";

export type BackgroundRunStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";

export interface BackgroundRunItem {
	runId: string;
	agentId: string;
	status: BackgroundRunStatus;
	/** Latest step, already worded for a person ("running run_commands"). */
	activity?: string;
	startedAt: number;
	endedAt?: number;
}

/** How long a finished run stays on the panel before it drops off. */
const FINISHED_LINGER_MS = 90_000;

const END_STATUS: Record<string, BackgroundRunStatus> = {
	run_completed: "completed",
	run_failed: "failed",
	run_cancelled: "cancelled",
	run_interrupted: "interrupted",
};

/** `running_tool_run_commands` -> `running run_commands`. */
export function describeRunActivity(message: string): string | undefined {
	if (message === "heartbeat" || message === "queued") return undefined;
	if (message === "run_started") return "starting";
	if (message === "finalizing_response") return "writing its reply";
	const tool = /^(running|finished)_tool_(.+)$/.exec(message);
	if (tool) return `${tool[1]} ${tool[2]}`;
	const iteration = /^iteration_(\d+)_started$/.exec(message);
	if (iteration) return `step ${iteration[1]}`;
	const retry = /^retry_scheduled_(\d+)$/.exec(message);
	if (retry) return `retry ${retry[1]} scheduled`;
	return message.replace(/_/g, " ");
}

export function applyTeamProgress(
	runs: BackgroundRunItem[],
	update: TeamProgressUpdate,
	now: number,
): BackgroundRunItem[] {
	const { lifecycle } = update;
	const runId = lifecycle.runId;
	if (!runId || !lifecycle.eventType.startsWith("run_")) return runs;
	const existing = runs.find((run) => run.runId === runId);
	const base: BackgroundRunItem = existing ?? {
		runId,
		agentId: lifecycle.agentId ?? "worker",
		status: "queued",
		startedAt: now,
	};
	let next: BackgroundRunItem;
	const endStatus = END_STATUS[lifecycle.eventType];
	if (endStatus) {
		next = {
			...base,
			status: endStatus,
			endedAt: now,
			activity:
				endStatus === "completed"
					? "reply sent to manager"
					: (lifecycle.message ?? endStatus),
		};
	} else if (lifecycle.eventType === "run_started") {
		next = { ...base, status: "running", startedAt: now, activity: "starting" };
	} else if (lifecycle.eventType === "run_progress") {
		const activity = lifecycle.message
			? describeRunActivity(lifecycle.message)
			: undefined;
		next = {
			...base,
			status: base.status === "queued" ? "running" : base.status,
			...(activity ? { activity } : {}),
		};
	} else {
		next = base;
	}
	return existing
		? runs.map((run) => (run.runId === runId ? next : run))
		: [...runs, next];
}

export function useBackgroundRuns(): {
	runs: BackgroundRunItem[];
	now: number;
	handleTeamProgress: (update: TeamProgressUpdate) => void;
} {
	const [runs, setRuns] = useState<BackgroundRunItem[]>([]);
	const [now, setNow] = useState(() => Date.now());

	const handleTeamProgress = useCallback((update: TeamProgressUpdate) => {
		setRuns((current) => applyTeamProgress(current, update, Date.now()));
	}, []);

	// Ticks the elapsed times, and drops finished runs once they have been
	// visible long enough to be noticed.
	const hasRuns = runs.length > 0;
	useEffect(() => {
		if (!hasRuns) return;
		const timer = setInterval(() => {
			const tick = Date.now();
			setNow(tick);
			setRuns((current) => {
				const kept = current.filter(
					(run) => !run.endedAt || tick - run.endedAt < FINISHED_LINGER_MS,
				);
				return kept.length === current.length ? current : kept;
			});
		}, 1000);
		return () => clearInterval(timer);
	}, [hasRuns]);

	return { runs, now, handleTeamProgress };
}
