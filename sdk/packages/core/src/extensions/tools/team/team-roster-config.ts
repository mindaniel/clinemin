import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ManagerWorkerSummary } from "@cline/shared";
import {
	parseTeamRoster,
	stripUtf8Bom,
	TEAM_ROSTER_FILENAME,
	type TeamRoster,
	type TeamRosterWorker,
	type TeamTeammateSpec,
} from "@cline/shared";
import { resolveClineDir } from "@cline/shared/storage";

export interface TeamRosterLoadResult {
	roster?: TeamRoster;
	/** Absolute path the roster was read from, when one was found. */
	path?: string;
	/** Human-readable problem with the file that was found, if any. */
	error?: string;
}

/**
 * Where a roster may live, nearest first.
 *
 * Workspace beats user-global so a repo can pin the exact worker line-up its
 * task needs, while a user who works the same way across repos writes it once.
 */
export function resolveTeamRosterSearchPaths(workspacePath?: string): string[] {
	const paths: string[] = [];
	if (workspacePath) {
		paths.push(join(workspacePath, ".cline", TEAM_ROSTER_FILENAME));
	}
	paths.push(join(resolveClineDir(), TEAM_ROSTER_FILENAME));
	return paths;
}

/**
 * Load the first roster found on the search path.
 *
 * A missing roster is not an error — teams work without one, with the lead
 * spawning workers itself. A roster that exists but does not parse *is*
 * reported, because silently ignoring it would start the team with the wrong
 * providers and no indication why.
 */
export function loadTeamRoster(options: {
	workspaceRoot?: string;
}): TeamRosterLoadResult {
	for (const path of resolveTeamRosterSearchPaths(options.workspaceRoot)) {
		if (!existsSync(path)) {
			continue;
		}
		let text: string;
		try {
			text = stripUtf8Bom(readFileSync(path, "utf8"));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { path, error: `Could not read ${path}: ${message}` };
		}
		const parsed = parseTeamRoster(text);
		if (!parsed.ok) {
			return { path, error: `${path}: ${parsed.error}` };
		}
		return { path, roster: parsed.roster };
	}
	return {};
}

/**
 * Merge roster workers into the teammate specs restored from persistence.
 *
 * Persistence wins on conflict. A worker already running carries conversation
 * state that the roster knows nothing about, and swapping its provider out from
 * under that history mid-job would be worse than honouring a stale entry — the
 * roster's job is to declare the team, not to restart it. Editing a live
 * worker's provider is the dashboard's job, through an explicit respawn.
 */
export function mergeRosterIntoTeammateSpecs(
	restored: readonly TeamTeammateSpec[],
	roster: TeamRoster | undefined,
): TeamTeammateSpec[] {
	if (!roster) {
		return [...restored];
	}
	const merged = new Map(restored.map((spec) => [spec.agentId, spec] as const));
	for (const worker of roster.workers) {
		if (merged.has(worker.agentId)) {
			continue;
		}
		merged.set(worker.agentId, {
			agentId: worker.agentId,
			rolePrompt: worker.rolePrompt,
			profile: worker.profile,
			providerId: worker.providerId,
			modelId: worker.modelId,
			maxIterations: worker.maxIterations,
			tools: worker.tools,
			notes: worker.notes,
		});
	}
	return Array.from(merged.values());
}

/**
 * The worker list a manager's system prompt is built from.
 *
 * Two sources, because a manager can be started either way: workers declared up
 * front in `team.json`, and workers a previous manager session already spawned
 * and that persistence still holds. Persistence wins, same as everywhere else.
 * The description is the role prompt's first line — enough for the manager to
 * tell its workers apart, without pasting a full role prompt per worker into a
 * prompt that is meant to stay short.
 */
export function listManagerWorkers(options: {
	workspaceRoot?: string;
	restored?: readonly TeamTeammateSpec[];
}): ManagerWorkerSummary[] {
	const { roster } = loadTeamRoster({ workspaceRoot: options.workspaceRoot });
	return mergeRosterIntoTeammateSpecs(options.restored ?? [], roster).map(
		(spec) => ({
			agentId: spec.agentId,
			profile: spec.profile,
			providerId: spec.providerId,
			modelId: spec.modelId,
			tools: spec.tools,
			notes: spec.notes,
			description: spec.rolePrompt
				.split("\n")
				.map((line) => line.trim())
				.find((line) => line.length > 0),
		}),
	);
}

/**
 * Write a roster back to disk.
 *
 * Shared so every editor of the roster produces the same file. Optional fields
 * are omitted rather than written as null: the schema is strict, and an absent
 * provider is exactly what makes a worker inherit the lead's.
 */
export function writeTeamRoster(options: {
	path: string;
	workers: TeamRosterWorker[];
}): void {
	const roster = {
		version: 1 as const,
		workers: options.workers.map((worker) => ({
			agentId: worker.agentId,
			rolePrompt: worker.rolePrompt,
			...(worker.profile ? { profile: worker.profile } : {}),
			...(worker.providerId ? { providerId: worker.providerId } : {}),
			...(worker.modelId ? { modelId: worker.modelId } : {}),
			...(worker.notes ? { notes: worker.notes } : {}),
			// An empty array is a real scope ("nothing but reporting back"), so it
			// is written; only `undefined` means unscoped.
			...(worker.tools ? { tools: worker.tools } : {}),
			...(worker.maxIterations ? { maxIterations: worker.maxIterations } : {}),
		})),
	};
	mkdirSync(dirname(options.path), { recursive: true });
	writeFileSync(
		options.path,
		`${JSON.stringify(roster, null, 2)}
`,
		"utf8",
	);
}
