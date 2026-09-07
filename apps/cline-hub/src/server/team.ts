/**
 * Team dashboard: read the live team, edit the declared roster.
 *
 * The hub does not own the team runtime — that lives inside the core session —
 * so this reads the same local team store the runtime persists to, rather than
 * inventing a second source of truth that could disagree with it.
 *
 * Writes are deliberately limited to the roster file. Spawning a worker or
 * claiming a task are lead-agent actions with conversation state behind them;
 * a dashboard that poked at them directly would race the running agent loop.
 * The dashboard instead edits what the team is *declared* to be, and hands the
 * lead instructions through the ordinary chat path.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	createLocalTeamStore,
	loadTeamRoster,
	resolveTeamRosterSearchPaths,
} from "@cline/core";
import type {
	MissionLogEntry,
	TeamRunRecord,
	TeamTask,
	TeamTeammateSpec,
} from "@cline/shared";
import type {
	WebviewTeamMissionLogEntry,
	WebviewTeamRoster,
	WebviewTeamRun,
	WebviewTeamState,
	WebviewTeamTask,
	WebviewTeamWorker,
} from "../webview-protocol";

const MISSION_LOG_LIMIT = 50;
const RUN_LIMIT = 50;

function toIso(value: Date | string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	return value instanceof Date ? value.toISOString() : String(value);
}

function toWorker(
	spec: TeamTeammateSpec,
	status: WebviewTeamWorker["status"],
): WebviewTeamWorker {
	return {
		agentId: spec.agentId,
		rolePrompt: spec.rolePrompt,
		providerId: spec.providerId,
		modelId: spec.modelId,
		status,
	};
}

function toTask(task: TeamTask): WebviewTeamTask {
	return {
		id: task.id,
		title: task.title,
		description: task.description,
		status: task.status,
		assignee: task.assignee,
		dependsOn: task.dependsOn ?? [],
		summary: task.summary,
		updatedAt: toIso(task.updatedAt),
	};
}

function toRun(run: TeamRunRecord): WebviewTeamRun {
	const result = run.result as
		| {
				finishReason?: string;
				usage?: { inputTokens?: number };
				text?: string;
		  }
		| undefined;
	return {
		id: run.id,
		agentId: run.agentId,
		taskId: run.taskId,
		status: run.status,
		startedAt: toIso(run.startedAt),
		endedAt: toIso(run.endedAt),
		currentActivity: run.currentActivity,
		lastProgressMessage: run.lastProgressMessage,
		error: run.error,
		finishReason: result?.finishReason,
		textPreview: result?.text?.slice(0, 400),
	};
}

function toMissionLogEntry(entry: MissionLogEntry): WebviewTeamMissionLogEntry {
	return {
		id: entry.id,
		ts: toIso(entry.ts) ?? "",
		agentId: entry.agentId,
		taskId: entry.taskId,
		kind: entry.kind,
		summary: entry.summary,
		nextAction: entry.nextAction,
	};
}

export function readTeamState(options: {
	teamKey: string;
	workspaceRoot?: string;
}): WebviewTeamState {
	const rosterLoad = loadTeamRoster({ workspaceRoot: options.workspaceRoot });
	const roster: WebviewTeamRoster = {
		// When no roster file exists yet, report where one would be written so the
		// dashboard can offer to create it instead of failing silently.
		path:
			rosterLoad.path ??
			resolveTeamRosterSearchPaths(options.workspaceRoot)[0] ??
			"",
		exists: Boolean(rosterLoad.roster),
		error: rosterLoad.error,
		workers: (rosterLoad.roster?.workers ?? []).map((worker) => ({
			agentId: worker.agentId,
			rolePrompt: worker.rolePrompt,
			providerId: worker.providerId,
			modelId: worker.modelId,
			maxIterations: worker.maxIterations,
		})),
	};

	let runtime: ReturnType<
		ReturnType<typeof createLocalTeamStore>["loadRuntime"]
	>;
	try {
		const store = createLocalTeamStore();
		runtime = store.loadRuntime(options.teamKey);
	} catch (error) {
		return {
			type: "team_state",
			teamKey: options.teamKey,
			roster,
			workers: [],
			tasks: [],
			runs: [],
			missionLog: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}

	const state = runtime?.state;
	const memberStatus = new Map(
		(state?.members ?? []).map(
			(member) => [member.agentId, member.status] as const,
		),
	);

	// Runs and the mission log are append-only histories that grow for the life
	// of the team; the dashboard shows the recent end of each rather than
	// shipping the whole history to the browser on every refresh.
	const runs = [...(state?.runs ?? [])]
		.reverse()
		.slice(0, RUN_LIMIT)
		.map(toRun);
	const missionLog = [...(state?.missionLog ?? [])]
		.reverse()
		.slice(0, MISSION_LOG_LIMIT)
		.map(toMissionLogEntry);

	return {
		type: "team_state",
		teamKey: options.teamKey,
		roster,
		workers: (runtime?.teammates ?? []).map((spec) =>
			toWorker(spec, memberStatus.get(spec.agentId) ?? "stopped"),
		),
		tasks: (state?.tasks ?? []).map(toTask),
		runs,
		missionLog,
	};
}

export function writeTeamRoster(options: {
	path: string;
	workers: WebviewTeamRoster["workers"];
}): void {
	const roster = {
		version: 1 as const,
		workers: options.workers.map((worker) => ({
			agentId: worker.agentId,
			rolePrompt: worker.rolePrompt,
			// Omitted rather than written as null: the roster schema is strict, and
			// an absent provider is what makes a worker inherit the lead's.
			...(worker.providerId ? { providerId: worker.providerId } : {}),
			...(worker.modelId ? { modelId: worker.modelId } : {}),
			...(worker.maxIterations ? { maxIterations: worker.maxIterations } : {}),
		})),
	};
	mkdirSync(dirname(options.path), { recursive: true });
	writeFileSync(options.path, `${JSON.stringify(roster, null, 2)}\n`, "utf8");
}
