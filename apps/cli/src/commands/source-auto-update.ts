/**
 * Background auto-update for a source checkout (this fork is git-cloned, not
 * installed from npm), the way Claude Code updates itself: build the new
 * version on the side, swap it in on the next launch.
 *
 * Nothing here writes to the checkout's working tree, `dist/` or
 * `node_modules`, so running sessions keep the code they loaded. A detached,
 * low-priority child (this file run as a script) fetches, checks the upstream
 * commit out into a separate git worktree under the cline dir, installs and
 * builds the SDK there. `source-update-apply.ts` swaps the result in when
 * cline next starts with no other cline running.
 *
 * Only fast-forwards: unpushed local commits make it skip.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants, setPriority } from "node:os";
import { useSyncExternalStore } from "react";
import {
	autoUpdateStateFile,
	git,
	readUpdateState,
	runBun,
	stagingWorktreeDir,
	writeUpdateState,
} from "./source-update-apply";

/** Skip the check when one ran this recently (worker sessions start often). */
const CHECK_INTERVAL_MS = 5 * 60_000;
/** A run older than this is assumed dead, so a new one may start. */
const STALE_RUN_MS = 20 * 60_000;

/**
 * Build `root`'s upstream in the staging worktree `stage`. Returns the
 * staged commit, or undefined when there is nothing to fast-forward to.
 */
export function stageUpstreamBuild(
	root: string,
	stage: string,
	alreadyStaged?: string,
	beforeRebuild: () => void = () => {},
): { commit: string; short: string } | undefined {
	git(root, ["rev-parse", "--abbrev-ref", "@{u}"]); // throws without upstream
	git(root, ["fetch", "--quiet"]);
	const behind = Number(git(root, ["rev-list", "--count", "HEAD..@{u}"]));
	const ahead = Number(git(root, ["rev-list", "--count", "@{u}..HEAD"]));
	if (!behind || ahead) return undefined;
	const commit = git(root, ["rev-parse", "@{u}"]);
	const short = git(root, ["rev-parse", "--short", commit]);
	if (commit === alreadyStaged) return { commit, short };

	beforeRebuild();
	if (existsSync(stage)) {
		git(stage, ["checkout", "--quiet", "--detach", "--force", commit]);
	} else {
		git(root, ["worktree", "prune"]);
		git(root, [
			"worktree",
			"add",
			"--quiet",
			"--detach",
			"--force",
			stage,
			commit,
		]);
	}
	// --ignore-scripts: the repo's postinstall would point the user's `cline`
	// shell alias at this staging copy.
	runBun(stage, ["install", "--ignore-scripts"], 15 * 60_000);
	runBun(stage, ["run", "build:sdk"], 15 * 60_000);
	return { commit, short };
}

let readyUpdate: string | undefined;
const listeners = new Set<() => void>();

function setReadyUpdate(short: string | undefined): void {
	if (short === readyUpdate) return;
	readyUpdate = short;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Short hash of a staged update waiting for a restart, if any. */
export function useSourceUpdate(): string | undefined {
	return useSyncExternalStore(subscribe, () => readyUpdate);
}

/**
 * Show any update already staged, then start a background check unless one
 * ran recently or is still running.
 */
export function startSourceAutoUpdate(root: string, clineDir: string): void {
	const stateFile = autoUpdateStateFile(clineDir);
	const state = readUpdateState(stateFile);
	setReadyUpdate(state.staged?.short);
	const now = Date.now();
	if (state.runningSince && now - state.runningSince < STALE_RUN_MS) return;
	if (state.lastCheckAt && now - state.lastCheckAt < CHECK_INTERVAL_MS) return;
	writeUpdateState(stateFile, {
		...state,
		lastCheckAt: now,
		runningSince: now,
	});

	const child = spawn(process.execPath, [import.meta.path, root, clineDir], {
		cwd: root,
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	try {
		// Its git and bun children inherit this, so builds yield to the user.
		if (child.pid) setPriority(child.pid, constants.priority.PRIORITY_LOW);
	} catch {
		// Best-effort.
	}
	child.once("exit", () =>
		setReadyUpdate(readUpdateState(stateFile).staged?.short),
	);
	child.once("error", () =>
		writeUpdateState(stateFile, {
			...state,
			lastCheckAt: now,
			runningSince: undefined,
		}),
	);
	child.unref();
}

if (import.meta.main) {
	const [root, clineDir] = process.argv.slice(2);
	const stateFile = autoUpdateStateFile(clineDir);
	const before = readUpdateState(stateFile);
	try {
		const staged = stageUpstreamBuild(
			root,
			stagingWorktreeDir(clineDir),
			before.staged?.commit,
			// The worktree is about to change: a launch must not swap it in now.
			() => writeUpdateState(stateFile, { ...before, staged: undefined }),
		);
		writeUpdateState(stateFile, { lastCheckAt: Date.now(), staged });
	} catch (error) {
		// A failed build must not be swapped in: drop whatever was staged.
		writeUpdateState(stateFile, {
			lastCheckAt: Date.now(),
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
