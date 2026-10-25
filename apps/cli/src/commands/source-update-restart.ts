/**
 * `/update`: apply a staged source update without leaving the work behind.
 *
 * The swap in `source-update-apply.ts` only runs at launch with no hub alive,
 * so picking an update up used to mean closing cline by hand and reopening
 * the chat. This does it in one step: the TUI exits as usual, the hub is
 * stopped, and a new cline starts in this terminal on the same session. The
 * new process swaps the update in before loading anything, then resumes.
 *
 * It refuses while other work depends on the hub — another cline window or a
 * running `--zen` session — since stopping the hub would cut those off.
 */

import { spawnSync } from "node:child_process";
import { looksUnattended } from "./send";
import {
	isHubRunning,
	resolveCliClineDir,
	sourceCheckoutRoot,
} from "./source-update-apply";
import { describeClineProcess, scanProcesses } from "./stop-all";

/** A zen row still "running" after this long is a crash leftover, not work. */
const STALE_RUNNING_MS = 6 * 60 * 60_000;
/**
 * Pids of earlier clines in this restart chain. Each one stays alive, idle,
 * waiting for its child, so it must not count as another window.
 */
const PARENTS_ENV = "CLINE_UPDATE_PARENT_PIDS";

let restartRequested = false;

export function requestUpdateRestart(): void {
	restartRequested = true;
}

export function isUpdateRestartRequested(): boolean {
	return restartRequested;
}

/** Why a restart would cut other work off, or undefined when it is safe. */
export async function findUpdateRestartBlocker(
	ownSessionId: string | undefined,
): Promise<string | undefined> {
	if (!sourceCheckoutRoot()) {
		return "cline is not running from a source checkout.";
	}
	const parents = new Set(
		(process.env[PARENTS_ENV] ?? "").split(",").map(Number).filter(Boolean),
	);
	const others = (await scanProcesses()).filter(
		(entry) =>
			entry.pid !== process.pid &&
			entry.pid !== process.ppid &&
			!parents.has(entry.pid) &&
			describeClineProcess(entry.commandLine) === "cline session",
	);
	if (others.length > 0) {
		return `${others.length} other cline window${others.length === 1 ? " is" : "s are"} open (pid ${others.map((entry) => entry.pid).join(", ")}). Close ${others.length === 1 ? "it" : "them"} first.`;
	}
	const { listSessions } = await import("../session/session");
	const now = Date.now();
	const zen = (await listSessions(200)).filter(
		(row) =>
			row.sessionId !== ownSessionId &&
			row.status === "running" &&
			looksUnattended(row.metadata) &&
			now - Date.parse(row.updatedAt) < STALE_RUNNING_MS,
	);
	if (zen.length > 0) {
		return `${zen.length} --zen session${zen.length === 1 ? " is" : "s are"} still running in the hub (${zen.map((row) => row.sessionId).join(", ")}). Wait for ${zen.length === 1 ? "it" : "them"} to finish.`;
	}
	return undefined;
}

/**
 * Stop the hub, then run a new cline on `sessionId` in this terminal and exit
 * with its code. Called after the TUI has torn down.
 */
export async function relaunchForUpdate(
	sessionId: string | undefined,
): Promise<never> {
	const { stopHubServer } = await import("./hub");
	await stopHubServer(process.cwd());
	if (isHubRunning(resolveCliClineDir())) {
		process.stderr.write(
			"The hub is still running, so the update waits for the next restart.\n",
		);
	}

	const args = [...process.execArgv, process.argv[1] ?? "", "-i"];
	const configFlag = process.argv.indexOf("--config");
	if (configFlag >= 0 && process.argv[configFlag + 1]) {
		args.push("--config", process.argv[configFlag + 1] as string);
	}
	if (sessionId) {
		args.push("--id", sessionId);
	}
	// The child owns the terminal from here; nothing in this process may read it.
	process.stdin.removeAllListeners();
	process.stdin.pause();
	const result = spawnSync(process.execPath, args, {
		cwd: process.cwd(),
		env: {
			...process.env,
			[PARENTS_ENV]: [process.env[PARENTS_ENV], process.pid]
				.filter(Boolean)
				.join(","),
		},
		stdio: "inherit",
	});
	process.exit(result.status ?? 1);
}
