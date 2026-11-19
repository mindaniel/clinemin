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
 * `/update` closes the other cline windows first (they would keep the hub and
 * the old code running), so only a running `--zen` session still blocks it.
 */

import { execFile, spawnSync } from "node:child_process";
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

/** pid -> parent pid for every process (empty if the listing fails). */
function parentPids(): Promise<Map<number, number>> {
	return new Promise((resolve) => {
		const parse = (out: string) => {
			const map = new Map<number, number>();
			for (const line of out.split(/\r?\n/)) {
				const [pid, ppid] = line.trim().split(/\s+/).map(Number);
				if (pid && ppid !== undefined && !Number.isNaN(ppid)) map.set(pid, ppid);
			}
			resolve(map);
		};
		if (process.platform === "win32") {
			execFile(
				"powershell",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
				],
				{ windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
				(error, stdout) => (error ? resolve(new Map()) : parse(stdout)),
			);
			return;
		}
		execFile(
			"ps",
			["-eo", "pid=,ppid="],
			{ maxBuffer: 8 * 1024 * 1024 },
			(error, stdout) => (error ? resolve(new Map()) : parse(stdout)),
		);
	});
}

/**
 * This window's own process family: the launcher chain above it (wrapper
 * script, shell shim, earlier clines of a restart chain) and everything it
 * started (tool commands, the background update build, helpers). Their
 * command lines can look like a cline window but none of them is another one.
 */
async function ownProcessFamily(): Promise<Set<number>> {
	const parentOf = await parentPids();
	const family = new Set<number>([process.pid, process.ppid]);
	for (const pid of (process.env[PARENTS_ENV] ?? "").split(",").map(Number)) {
		if (pid) family.add(pid);
	}
	// Ancestors (bounded: a pid map can be inconsistent while processes exit).
	for (let pid = process.ppid, n = 0; pid > 1 && n < 64; n++) {
		family.add(pid);
		pid = parentOf.get(pid) ?? 0;
	}
	// Descendants.
	for (const pid of parentOf.keys()) {
		for (let p = parentOf.get(pid) ?? 0, n = 0; p > 1 && n < 64; n++) {
			if (p === process.pid) {
				family.add(pid);
				break;
			}
			p = parentOf.get(p) ?? 0;
		}
	}
	return family;
}

/** Build and install steps of the background update (`bun -F @cline/cli build`, ...). */
const NOT_A_WINDOW = /\s(-F|--filter)\s|source-auto-update|\sbuild(:sdk)?(\s|$)|\sinstall(\s|$)/;

/** Other cline windows (pids) on this machine. */
async function otherClineWindows(): Promise<number[]> {
	const family = await ownProcessFamily();
	return (await scanProcesses())
		.filter(
			(entry) =>
				!family.has(entry.pid) &&
				!NOT_A_WINDOW.test(entry.commandLine) &&
				describeClineProcess(entry.commandLine) === "cline session",
		)
		.map((entry) => entry.pid);
}

/** `/update`: close the other cline windows so the restart can go ahead. */
export async function closeOtherClineWindows(): Promise<number[]> {
	const pids = await otherClineWindows();
	for (const pid of pids) {
		try {
			if (process.platform === "win32") {
				spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
			} else {
				process.kill(pid, "SIGTERM");
			}
		} catch {
			// already gone
		}
	}
	if (pids.length > 0) await new Promise((r) => setTimeout(r, 1500));
	return pids;
}

/** Why a restart would cut other work off, or undefined when it is safe. */
export async function findUpdateRestartBlocker(
	ownSessionId: string | undefined,
): Promise<string | undefined> {
	if (!sourceCheckoutRoot()) {
		return "cline is not running from a source checkout.";
	}
	const others = await otherClineWindows();
	if (others.length > 0) {
		return `${others.length} other cline window${others.length === 1 ? " is" : "s are"} open (pid ${others.join(", ")}). They could not be closed; close ${others.length === 1 ? "it" : "them"} by hand.`;
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
