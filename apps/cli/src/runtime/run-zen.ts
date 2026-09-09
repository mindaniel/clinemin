import type { UserInstructionConfigService } from "@cline/core";
import { HubSessionClient } from "@cline/core";
import type { ChatStartSessionRequest } from "@cline/shared";
import { resolveCliSessionMetadata } from "../utils/enterprise";
import { ensureCliHubServer } from "../utils/hub-runtime";
import { c, emitJsonLine, writeErr, writeln } from "../utils/output";
import type { Config } from "../utils/types";
import { buildUserInputMessage } from "./prompt";

/**
 * How long to wait for the hub to answer before assuming the turn is simply
 * long-running and exiting anyway.
 *
 * `session.send_input` has no command timeout and does not reply until the turn
 * FINISHES (see the hub's `run-handlers.ts`), so its reply is a result, not an
 * acknowledgement. There is no ack-only send. This used to be raced as though
 * it were one, and the expiry was reported as a failed dispatch — so every
 * provider whose first turn takes longer than this, which is all of the
 * browser-driven ones, printed "zen dispatch failed" for a session that had in
 * fact started and was running fine.
 *
 * The expiry is now the expected path: it means the frame reached the hub and
 * the turn is still going, which is exactly what zen wants.
 */
const ZEN_DISPATCH_SETTLE_MS = 5_000;

/**
 * Zen mode: fire-and-forget dispatch of a task to the background hub.
 *
 * Unlike a normal CLI run, zen mode does not stay connected to watch the
 * session stream. It submits the turn to the hub and exits immediately. The
 * hub continues to execute the agent loop in the background and, on
 * completion, already publishes a `ui.notify` event which the menubar app
 * (if installed) surfaces as a system notification. If the menubar app is not
 * running, users can still find the result later via `cline history`.
 *
 * Because no human is available to approve tool calls once the CLI exits,
 * zen mode forces full tool auto-approval (same semantics as yolo) and only
 * works with a hub-backed session. Sandbox mode (enabled via --data-dir) is
 * incompatible with zen because sandbox requires a local backend that
 * terminates with the CLI.
 */
export async function runZen(
	prompt: string,
	config: Config,
	userInstructionService?: UserInstructionConfigService,
): Promise<void> {
	if (config.sandbox) {
		writeErr(
			"--zen cannot be combined with --data-dir (sandbox requires a local backend).",
		);
		process.exitCode = 1;
		return;
	}
	if (
		process.env.CLINE_SESSION_BACKEND_MODE?.trim().toLowerCase() === "local"
	) {
		writeErr(
			"--zen requires the hub backend but CLINE_SESSION_BACKEND_MODE=local is set.",
		);
		process.exitCode = 1;
		return;
	}

	const workspaceRoot = config.workspaceRoot ?? config.cwd;
	let hubUrl: string;
	let hubAuthToken: string;
	try {
		const hub = await ensureCliHubServer(workspaceRoot);
		hubUrl = hub.url;
		hubAuthToken = hub.authToken;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		writeErr(`failed to start background hub: ${message}`);
		process.exitCode = 1;
		return;
	}

	const sessionClient = new HubSessionClient({
		address: hubUrl,
		authToken: hubAuthToken,
		clientType: "cli-zen",
		displayName: "Cline CLI (zen)",
		workspaceRoot,
		cwd: config.cwd,
	});

	let sessionId: string | undefined;
	try {
		await sessionClient.connect();

		const {
			prompt: userInput,
			userImages,
			userFiles,
		} = await buildUserInputMessage(prompt, userInstructionService);

		const startRequest: ChatStartSessionRequest = {
			workspaceRoot,
			cwd: config.cwd,
			provider: config.providerId,
			model: config.modelId,
			apiKey: config.apiKey || undefined,
			systemPrompt: config.systemPrompt,
			// Zen runs unattended: use yolo-style tool behavior so tool calls are
			// auto-approved without a human in the loop.
			mode: "yolo",
			rules: undefined,
			enableTools: true,
			enableSpawn: false,
			enableTeams: false,
			autoApproveTools: true,
			toolExecutors: ["submit"],
			source: "cline-cli-zen",
			interactive: false,
			logger: config.loggerConfig,
		};

		const started = await sessionClient.startRuntimeSession(startRequest);
		sessionId = started.sessionId;
		const remoteConfigMetadata = await resolveCliSessionMetadata(
			sessionId,
		).catch(() => undefined);
		if (remoteConfigMetadata && sessionClient.updateSession) {
			await sessionClient
				.updateSession({
					sessionId,
					metadata: remoteConfigMetadata,
				})
				.catch(() => undefined);
		}

		// Give the hub a moment to reject the frame before closing the socket,
		// which catches a silent drop on a slow or loaded system. A turn that is
		// still running when the timer expires is the normal case, not an error:
		// see the note on ZEN_DISPATCH_SETTLE_MS.
		const dispatch = sessionClient
			.sendRuntimeSession(started.sessionId, {
				config: startRequest,
				prompt: userInput,
				attachments:
					userImages.length > 0 || userFiles.length > 0
						? {
								userImages: userImages.length > 0 ? userImages : undefined,
								userFiles:
									userFiles.length > 0
										? userFiles.map((content, index) => ({
												name: `attachment-${index + 1}`,
												content,
											}))
										: undefined,
							}
						: undefined,
			})
			// The CLI is about to exit, so nothing is left to surface a late
			// failure. Swallow it rather than leaving an unhandled rejection to
			// take the process down after the success message has printed.
			.catch(() => undefined);

		await Promise.race([
			dispatch,
			new Promise<void>((resolve) => {
				setTimeout(resolve, ZEN_DISPATCH_SETTLE_MS);
			}),
		]);

		if (config.outputMode === "json") {
			emitJsonLine("stdout", {
				type: "zen_dispatched",
				sessionId,
				hubUrl,
				workspaceRoot,
			});
		} else {
			writeln(
				`${c.dim}[zen]${c.reset} the CLI is exiting; the session ${sessionId} will continue running in the background.`,
			);
			writeln(
				`${c.dim}[zen]${c.reset} check ${c.dim} history${c.reset} later to see the result,`,
			);
			writeln(
				`${c.dim}[zen]${c.reset} or steer it with ${c.dim}cline send ${sessionId} "<message>"${c.reset}.`,
			);
		}
		process.exitCode = 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (config.outputMode === "json") {
			emitJsonLine("stderr", {
				type: "zen_error",
				sessionId,
				message,
			});
		} else {
			writeErr(`zen dispatch failed: ${message}`);
		}
		process.exitCode = 1;
	} finally {
		sessionClient.close();
	}
}
