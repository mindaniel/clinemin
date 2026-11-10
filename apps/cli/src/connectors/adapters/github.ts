import type { Command } from "commander";
import { ConnectorBase } from "../base";
import {
	CONNECT_ALREADY_RUNNING_EXIT_CODE,
	isProcessRunning,
	resolveConnectorDebugLogPath,
	spawnDetachedConnector,
	terminateProcess,
} from "../common";
import { Bridge } from "../github/bridge";
import { loadConfig, readSavedConfig } from "../github/config";
import type { ConnectIo, ConnectRunContext, ConnectStopResult } from "../types";

/**
 * `cline connect github`: the phone app's bridge. Chats are issues in a
 * private GitHub repo; the bridge answers them with minh sessions. Settings
 * come from the /setupweb dialog (saved under ~/.minh-mobile), so nothing
 * secret is ever on the command line.
 */

interface GithubConnectOptions {
	interactive: boolean;
}

interface GithubConnectorState {
	pid: number;
	repo: string;
	startedAt: string;
	logPath?: string;
}

const CHILD_ENV = "CLINE_GITHUB_CONNECT_CHILD";
const STARTUP_TIMEOUT_MS = 30_000;

export class GithubConnector extends ConnectorBase<
	GithubConnectOptions,
	GithubConnectorState
> {
	constructor() {
		super("github", "Phone app: chats as issues in a private GitHub repo");
	}

	protected override createCommand(): Command {
		return super
			.createCommand()
			.option("-i, --interactive", "Keep the bridge in the foreground")
			.addHelpText(
				"after",
				[
					"",
					"Notes:",
					"  - Set it up with /setupweb in the minh terminal first.",
					"  - Without -i, the bridge runs in the background.",
				].join("\n"),
			);
	}

	protected override readOptions(command: Command): GithubConnectOptions {
		return {
			interactive: Boolean(
				command.opts<{ interactive?: boolean }>().interactive,
			),
		};
	}

	statePathFor(repo: string): string {
		return this.resolveConnectorPath(`${this.sanitizeKey(repo)}.json`);
	}

	readState(path: string): GithubConnectorState | undefined {
		return this.readStateFile(path, (value): value is GithubConnectorState =>
			Boolean(
				value &&
					typeof value === "object" &&
					typeof (value as GithubConnectorState).pid === "number" &&
					typeof (value as GithubConnectorState).repo === "string",
			),
		);
	}

	/** The running bridge, if any (stale state files are cleared on the way). */
	running(): GithubConnectorState | undefined {
		for (const path of this.listJsonStatePaths()) {
			const state = this.readState(path);
			if (state && isProcessRunning(state.pid)) return state;
			this.removeStateFile(path);
		}
		return undefined;
	}

	protected override async validateOptions(
		_options: GithubConnectOptions,
		io: ConnectIo,
	): Promise<number> {
		try {
			loadConfig();
			return 0;
		} catch (error) {
			io.writeErr(error instanceof Error ? error.message : String(error));
			return 1;
		}
	}

	protected override async runWithOptions(
		options: GithubConnectOptions,
		rawArgs: string[],
		io: ConnectIo,
		context: ConnectRunContext,
	): Promise<number> {
		const repo = readSavedConfig()?.repo ?? "";
		const statePath = this.statePathFor(repo);
		const logPath = resolveConnectorDebugLogPath(
			"github",
			this.sanitizeKey(repo),
		);
		context.setPersistenceArgs(
			rawArgs.filter((arg) => arg !== "-i" && arg !== "--interactive"),
		);
		context.setPersistenceInstanceId(repo);

		if (!options.interactive && process.env[CHILD_ENV] !== "1") {
			const already = this.running();
			if (already) {
				io.writeln(
					`[github] bridge already running pid=${already.pid} repo=${already.repo}`,
				);
				return CONNECT_ALREADY_RUNNING_EXIT_CODE;
			}
			const pid = spawnDetachedConnector(
				["connect", this.name],
				rawArgs,
				CHILD_ENV,
				{
					logPath,
					component: "github-connect",
					metadata: { repo },
				},
			);
			if (!pid) {
				io.writeErr("failed to start the GitHub bridge in the background");
				return 1;
			}
			io.writeln(`[github] starting bridge pid=${pid} repo=${repo}`);
			const startedAt = Date.now();
			while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
				const state = this.readState(statePath);
				if (state && isProcessRunning(state.pid)) return 0;
				if (!isProcessRunning(pid)) {
					io.writeErr(
						`the GitHub bridge stopped while starting; see ${logPath}`,
					);
					return 1;
				}
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			await terminateProcess(pid);
			io.writeErr(
				`the GitHub bridge did not start within ${STARTUP_TIMEOUT_MS / 1000}s; see ${logPath}`,
			);
			return 1;
		}

		// Foreground: this process is the bridge.
		const bridge = new Bridge(loadConfig());
		const stop = () => {
			bridge.stop();
			this.removeStateFile(statePath);
			process.exit(0);
		};
		process.on("SIGINT", stop);
		process.on("SIGTERM", stop);
		await bridge.start();
		this.writeStateFile(statePath, {
			pid: process.pid,
			repo,
			startedAt: new Date().toISOString(),
			logPath,
		} satisfies GithubConnectorState);
		await bridge.loop();
		return 0;
	}

	override async stopAll(io: ConnectIo): Promise<ConnectStopResult> {
		return this.stopAllFromStatePaths(
			io,
			this.listJsonStatePaths(),
			(statePath, stopIo) =>
				this.stopManagedProcess({
					io: stopIo,
					statePath,
					readState: (path) => this.readState(path),
					describeStoppedProcess: (state) =>
						`[github] stopped pid=${state.pid} repo=${state.repo}`,
					getPid: (state) => state.pid,
					// Sessions are left alone: each is a chat on the phone and comes back
					// from its transcript when the bridge starts again.
					stopSessions: async () => 0,
				}),
		);
	}

	override async stopInstance(
		instanceId: string,
		io: ConnectIo,
	): Promise<ConnectStopResult> {
		return this.stopAllFromStatePaths(
			io,
			[this.statePathFor(instanceId)],
			(statePath, stopIo) =>
				this.stopManagedProcess({
					io: stopIo,
					statePath,
					readState: (path) => this.readState(path),
					describeStoppedProcess: (state) =>
						`[github] stopped pid=${state.pid} repo=${state.repo}`,
					getPid: (state) => state.pid,
					stopSessions: async () => 0,
				}),
		);
	}
}

export const githubConnector = new GithubConnector();
