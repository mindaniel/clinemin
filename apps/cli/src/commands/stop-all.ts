import { execFile } from "node:child_process";
import { disableConnectorAutostart } from "@cline/core";
import type { ConnectIo } from "../connectors/types";
import { stopAllConnectors } from "./connect";
import { stopHubServer } from "./hub";

/**
 * Markers that identify a process as belonging to Cline.
 *
 * Matching is on what the process IS — its command line — rather than on a pid
 * file, because the stray processes worth killing are exactly the ones whose
 * state files went missing or were never written. Both path separators are
 * listed: a Windows command line spells the same entrypoint with backslashes.
 */
const CLINE_PROCESS_MARKERS = [
	"apps/cli/src/index.ts",
	String.raw`apps\cli\src\index.ts`,
	"hub/daemon/entry",
	String.raw`hub\daemon\entry`,
	"telegram-bridge",
	"@cline/cli",
	String.raw`@cline\cli`,
];

export interface ClineProcess {
	pid: number;
	commandLine: string;
}

function scanProcesses(): Promise<ClineProcess[]> {
	return new Promise((resolve) => {
		const done = (
			out: string,
			extract: (line: string) => { pid: number; rest: string } | undefined,
		) => {
			const found = new Map<number, string>();
			for (const line of out.split(/\r?\n/)) {
				if (!CLINE_PROCESS_MARKERS.some((marker) => line.includes(marker))) {
					continue;
				}
				const parsed = extract(line);
				if (!parsed?.pid || Number.isNaN(parsed.pid)) continue;
				found.set(parsed.pid, parsed.rest.trim());
			}
			resolve(
				Array.from(found, ([pid, commandLine]) => ({ pid, commandLine })),
			);
		};
		if (process.platform === "win32") {
			execFile(
				"powershell",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
				],
				{ windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
				(error, stdout) => {
					if (error) return resolve([]);
					done(stdout, (line) => {
						const [rawPid, ...rest] = line.split("\t");
						return {
							pid: Number.parseInt(rawPid ?? "", 10),
							rest: rest.join("\t"),
						};
					});
				},
			);
			return;
		}
		execFile(
			"ps",
			["-eo", "pid=,args="],
			{ maxBuffer: 8 * 1024 * 1024 },
			(error, stdout) => {
				if (error) return resolve([]);
				done(stdout, (line) => {
					const trimmed = line.trim();
					const separator = trimmed.indexOf(" ");
					if (separator < 0) return undefined;
					return {
						pid: Number.parseInt(trimmed.slice(0, separator), 10),
						rest: trimmed.slice(separator + 1),
					};
				});
			},
		);
	});
}

function killProcess(pid: number): Promise<void> {
	return new Promise((resolve) => {
		if (process.platform === "win32") {
			execFile(
				"taskkill",
				["/pid", String(pid), "/T", "/F"],
				{ windowsHide: true },
				() => resolve(),
			);
			return;
		}
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// Already gone.
		}
		resolve();
	});
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Short label for a command line, so the report stays readable. */
export function describeClineProcess(commandLine: string): string {
	if (
		commandLine.includes("hub/daemon/entry") ||
		commandLine.includes("hub\\daemon\\entry")
	) {
		return "hub daemon";
	}
	if (commandLine.includes("telegram-bridge")) {
		return "telegram-bridge (example)";
	}
	if (commandLine.includes("connect")) {
		return "connector";
	}
	return "cline session";
}

/**
 * Stop every Cline process this machine is running: connectors, the hub
 * daemon, and anything left over that the state files no longer track.
 *
 * `cline hub stop` only stops the hub, and `cline connect --stop` only stops
 * connectors that still have a state file — neither covers a process whose
 * bookkeeping is gone, which is precisely the case where things appear to keep
 * running after being "stopped".
 *
 * The current process is never killed, so this can be run from a live CLI.
 */
export async function runStopEverything(
	io: ConnectIo,
	options: { dryRun?: boolean; cwd?: string } = {},
): Promise<number> {
	const dryRun = options.dryRun === true;

	if (!dryRun) {
		const connectors = await stopAllConnectors(io);
		disableConnectorAutostart();
		io.writeln(
			`[stop] connectors: processes=${connectors.stoppedProcesses} failed=${connectors.failedProcesses} sessions=${connectors.stoppedSessions}`,
		);
		const hub = await stopHubServer(options.cwd ?? process.cwd());
		io.writeln(`[stop] hub: ${hub}`);
	}

	// Sweep last: stopping a connector or the hub the clean way is better than
	// killing it, so whatever is still standing here is the leftover.
	const survivors = (await scanProcesses()).filter(
		(entry) => entry.pid !== process.pid && entry.pid !== process.ppid,
	);
	if (survivors.length === 0) {
		io.writeln(
			dryRun
				? "[stop] nothing else is running"
				: "[stop] no leftover processes",
		);
		return 0;
	}

	for (const entry of survivors) {
		io.writeln(
			`[stop] ${dryRun ? "would kill" : "killing"} pid=${entry.pid} ${describeClineProcess(entry.commandLine)}`,
		);
		if (!dryRun) {
			await killProcess(entry.pid);
		}
	}
	if (dryRun) {
		return 0;
	}

	// Report what actually died, not what was asked to die.
	await new Promise((resolve) => setTimeout(resolve, 500));
	const stillAlive = survivors.filter((entry) => isAlive(entry.pid));
	if (stillAlive.length > 0) {
		for (const entry of stillAlive) {
			io.writeErr(
				`[stop] pid=${entry.pid} is still running (${describeClineProcess(entry.commandLine)})`,
			);
		}
		return 1;
	}
	io.writeln(`[stop] killed ${survivors.length} leftover process(es)`);
	return 0;
}
