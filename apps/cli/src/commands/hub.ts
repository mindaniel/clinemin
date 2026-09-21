import { execFile } from "node:child_process";
import {
	clearHubDiscovery,
	ensureDetachedHubServer,
	probeHubServer,
	readHubDiscovery,
	resolveProductionHubOwnerContext,
	resolveSharedHubOwnerContext,
	stopLocalHubServerGracefully,
} from "@cline/core";
import { formatUptime, resolveClineBuildEnv } from "@cline/shared";
import { Command } from "commander";
import { version as cliVersion } from "../../package.json";

interface HubCommandIo {
	writeln: (text?: string) => void;
	writeErr: (text: string) => void;
}

/**
 * Kill a process and the children it spawned.
 *
 * The daemon is a detached bun process; SIGTERM to the parent alone leaves its
 * children holding the port, which is one of the ways `hub stop` used to report
 * success over a hub that was still answering.
 */
function killProcessTree(pid: number): Promise<void> {
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
			process.kill(-pid, "SIGTERM");
		} catch {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				// Already gone.
			}
		}
		resolve();
	});
}

/**
 * Find running hub daemons by what they are, not by what a file claims.
 *
 * The discovery record is the normal way to locate the daemon, but it is also
 * the thing that goes missing — and when it does, `hub stop` had no pid, killed
 * nothing, and said `{"stopped":false}` while the daemon kept running and the
 * next `cline` run attached straight back to it. The process table still knows.
 */
function findHubDaemonPids(): Promise<number[]> {
	return new Promise((resolve) => {
		const marker = "hub/daemon/entry";
		const altMarker = String.raw`hub\daemon\entry`;
		const done = (
			out: string,
			extract: (line: string) => number | undefined,
		) => {
			const pids = new Set<number>();
			for (const line of out.split(/\r?\n/)) {
				if (!line.includes(marker) && !line.includes(altMarker)) continue;
				const pid = extract(line);
				if (pid && pid !== process.pid) pids.add(pid);
			}
			resolve(Array.from(pids));
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
					done(stdout, (line) =>
						Number.parseInt(line.split("\t")[0] ?? "", 10),
					);
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
				done(stdout, (line) =>
					Number.parseInt(line.trim().split(/\s+/)[0] ?? "", 10),
				);
			},
		);
	});
}

/** Is a hub still answering on this discovery record's URL? */
async function hubStillUp(url: string | undefined): Promise<boolean> {
	if (!url) return false;
	return Boolean(await probeHubServer(url));
}

type HubStopResult = "stopped" | "not_running" | "still_running";

/**
 * Stop the local hub, and report whether it is actually stopped.
 *
 * "not_running" is separate from "still_running": both used to print
 * `{"stopped":false}`, so "there was no hub" read like "the stop failed".
 *
 * The old version returned `!!pid` — whether a discovery record happened to
 * name a process — which was neither "we killed it" nor "it is gone". Now the
 * answer is the observable one: nothing is listening any more.
 */
export async function stopHubServer(
	_workspaceRoot: string,
): Promise<HubStopResult> {
	const owner = resolveCliHubOwnerContext();
	const discovery = await readHubDiscovery(owner.discoveryPath);
	const url = discovery?.url;

	if (await stopLocalHubServerGracefully(owner)) {
		await clearHubDiscovery(owner.discoveryPath);
		if (!(await hubStillUp(url))) {
			return "stopped";
		}
	}

	const pids = new Set<number>();
	if (discovery?.pid) {
		pids.add(discovery.pid);
	}
	// Always scan too. A stale discovery record can name a pid that has been
	// recycled while the real daemon runs under another one.
	for (const pid of await findHubDaemonPids()) {
		pids.add(pid);
	}
	for (const pid of pids) {
		await killProcessTree(pid);
	}

	await clearHubDiscovery(owner.discoveryPath);
	if (pids.size === 0) {
		return (await hubStillUp(url)) ? "still_running" : "not_running";
	}
	// Give the port a moment to be released before answering.
	for (let attempt = 0; attempt < 10; attempt++) {
		if (!(await hubStillUp(url))) {
			return "stopped";
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return "still_running";
}

function formatHubUptimeFromStartedAt(
	startedAt: string | undefined,
): string | undefined {
	if (!startedAt) {
		return undefined;
	}
	const timestamp = Date.parse(startedAt);
	if (Number.isNaN(timestamp)) {
		return undefined;
	}
	return formatUptime(Date.now() - timestamp);
}

function resolveCliHubOwnerContext() {
	return resolveClineBuildEnv() === "production"
		? resolveProductionHubOwnerContext()
		: resolveSharedHubOwnerContext();
}

export function createHubCommand(
	io: HubCommandIo,
	setExitCode: (code: number) => void,
): Command {
	let actionExitCode = 0;
	const fail = () => {
		actionExitCode = 1;
	};
	const action =
		<T extends unknown[]>(fn: (...args: T) => Promise<void>) =>
		async (...args: T) => {
			try {
				await fn(...args);
			} catch (error) {
				io.writeErr(error instanceof Error ? error.message : String(error));
				fail();
			}
		};

	const hub = new Command("hub")
		.description("Manage the local hub daemon")
		.exitOverride()
		.hook("postAction", () => {
			setExitCode(actionExitCode);
		})
		.option("--cwd <path>", "Workspace root", process.cwd())
		.option("--host <host>", "Hub host")
		.option("--port <port>", "Hub port", (value) => Number.parseInt(value, 10))
		.option("--pathname <path>", "Hub websocket path");

	hub.command("ensure").action(
		action(async () => {
			const opts = hub.opts<{
				cwd: string;
				host?: string;
				port?: number;
				pathname?: string;
			}>();
			// A hub started on purpose stays up. Only the ones spawned on demand
			// shut themselves down when idle, so `hub start` opts out.
			const previousIdleShutdown = process.env.CLINE_HUB_IDLE_SHUTDOWN_MS;
			process.env.CLINE_HUB_IDLE_SHUTDOWN_MS = "0";
			try {
				const { url } = await ensureDetachedHubServer(opts.cwd, {
					host: opts.host,
					port: opts.port,
					pathname: opts.pathname,
				});
				io.writeln(url);
			} finally {
				if (previousIdleShutdown === undefined) {
					process.env.CLINE_HUB_IDLE_SHUTDOWN_MS = undefined;
					delete process.env.CLINE_HUB_IDLE_SHUTDOWN_MS;
				} else {
					process.env.CLINE_HUB_IDLE_SHUTDOWN_MS = previousIdleShutdown;
				}
			}
		}),
	);

	hub.command("start").action(
		action(async () => {
			const opts = hub.opts<{
				cwd: string;
				host?: string;
				port?: number;
				pathname?: string;
			}>();
			const { url } = await ensureDetachedHubServer(opts.cwd, {
				host: opts.host,
				port: opts.port,
				pathname: opts.pathname,
			});
			io.writeln(url);
		}),
	);

	hub.command("status").action(
		action(async () => {
			const owner = resolveCliHubOwnerContext();
			const discovery = await readHubDiscovery(owner.discoveryPath);
			const health = discovery?.url
				? await probeHubServer(discovery.url, {
						authToken: discovery.authToken,
					})
				: undefined;
			const uptime = formatHubUptimeFromStartedAt(health?.startedAt);
			io.writeln(
				JSON.stringify({
					running: !!health?.url,
					url: health?.url,
					pid: health?.pid,
					startedAt: health?.startedAt,
					uptime,
					cliVersion,
					coreVersion: health?.coreVersion ?? discovery?.coreVersion,
				}),
			);
		}),
	);

	hub.command("stop").action(
		action(async () => {
			const opts = hub.opts<{ cwd: string }>();
			const result = await stopHubServer(opts.cwd);
			if (result === "stopped") {
				io.writeln(JSON.stringify({ stopped: true }));
				return;
			}
			io.writeln(JSON.stringify({ stopped: false, reason: result }));
			if (result === "still_running") {
				io.writeErr(
					"hub is still answering after stop; close running cline sessions and retry",
				);
			}
		}),
	);

	return hub;
}
