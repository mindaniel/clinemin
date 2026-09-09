/**
 * `cline send <session> "<message>"` — drive a session that is already running.
 *
 * `--zen` dispatches one prompt to the background hub and exits, and until now
 * that was the end of the conversation: the session kept running but nothing
 * could reach it again. This is the other half. The hub already accepts turns
 * for a session by id — `session.send_input` is addressed by session id and
 * carries a prompt, with no attach step and no config (see the hub's
 * `run-handlers.ts`) — so steering is a CLI surface over a command that was
 * already there.
 *
 * The turn runs to completion before this returns, because
 * `session.send_input` has no default timeout and its reply carries the
 * result. So `cline send` prints the answer rather than merely acknowledging.
 *
 * ## Approvals
 *
 * A session started with `--zen` runs `autoApproveTools: true`, because nobody
 * is attached to approve anything. A session started any other way will block
 * mid-turn on the first tool call that needs approval, and nothing here can
 * answer it — this command sends a turn, it does not attach as a client. That
 * would hang until interrupted, so a non-auto-approving target is refused up
 * front with an explanation instead. `--force` sends anyway, for a session the
 * caller knows is safe (a read-only run, or one already being watched in
 * another terminal).
 */

import { HubSessionClient } from "@cline/core";
import { ensureCliHubServer } from "../utils/hub-runtime";
import { c, emitJsonLine, writeErr, writeln } from "../utils/output";
import type { CliOutputMode } from "../utils/types";

export interface SendCommandOptions {
	sessionId: string;
	message: string;
	/** Jump the pending-prompt queue instead of joining the back of it. */
	steer?: boolean;
	/** Send even when the session does not look unattended. */
	force?: boolean;
	outputMode: CliOutputMode;
	workspaceRoot: string;
	cwd: string;
}

/**
 * Does this session approve its own tool calls?
 *
 * `startRuntimeSession` records `source` and `interactive` in the session's
 * metadata, and zen sets them to `cline-cli-zen` / `false`. That is the only
 * signal available from `session.list`; `autoApproveTools` lives in the
 * session's runtime options, which the row does not carry.
 */
export function looksUnattended(
	metadata: Record<string, unknown> | undefined,
): boolean {
	if (!metadata) return false;
	if (metadata.interactive === false) return true;
	return typeof metadata.source === "string" && metadata.source.includes("zen");
}

/** Short id form for a message, since hub session ids are long. */
function shortId(sessionId: string): string {
	return sessionId.length > 12 ? `${sessionId.slice(0, 8)}…` : sessionId;
}

export async function runSendCommand(
	options: SendCommandOptions,
): Promise<number> {
	const message = options.message.trim();
	if (!message) {
		writeErr("send requires a non-empty message.");
		return 1;
	}

	let hubUrl: string;
	let hubAuthToken: string;
	try {
		const hub = await ensureCliHubServer(options.workspaceRoot);
		hubUrl = hub.url;
		hubAuthToken = hub.authToken;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		writeErr(`failed to reach the background hub: ${detail}`);
		return 1;
	}

	const sessionClient = new HubSessionClient({
		address: hubUrl,
		authToken: hubAuthToken,
		clientType: "cli-send",
		displayName: "Cline CLI (send)",
		workspaceRoot: options.workspaceRoot,
		cwd: options.cwd,
	});

	try {
		await sessionClient.connect();

		// Resolve the id before sending, so an unknown session fails with a list
		// the caller can act on rather than a hub-side "session not found".
		//
		// `session.list` is the session HISTORY, not a live-process list, so a
		// match here means the id is real — not that the session is still warm.
		// Sending to a cold one asks the hub to pick it back up, which is the
		// same thing `cline history` does when you resume from the TUI.
		const sessions = await sessionClient.listSessions({ limit: 200 });
		const target = sessions.find((row) => row.sessionId === options.sessionId);
		if (!target) {
			writeErr(`no session with id ${options.sessionId}.`);
			if (sessions.length > 0) {
				writeErr("most recent sessions:");
				for (const row of sessions.slice(0, 10)) {
					writeErr(`  ${row.sessionId}`);
				}
			} else {
				writeErr("the hub has no sessions recorded.");
			}
			return 1;
		}

		if (!options.force && !looksUnattended(target.metadata)) {
			writeErr(
				`session ${shortId(options.sessionId)} was not started with --zen, so it ` +
					"approves tool calls through an attached client.",
			);
			writeErr(
				"`send` does not attach, so the turn would stop at the first tool " +
					"call that needs approval and wait for an answer that never comes.",
			);
			writeErr("Pass --force to send anyway.");
			return 1;
		}

		const { result } = await sessionClient.sendSessionInput(options.sessionId, {
			prompt: message,
			delivery: options.steer ? "steer" : "queue",
		});

		if (options.outputMode === "json") {
			emitJsonLine("stdout", {
				type: "send_result",
				sessionId: options.sessionId,
				delivery: options.steer ? "steer" : "queue",
				text: result?.text,
				finishReason: result?.finishReason,
				usage: result?.usage,
			});
			return 0;
		}

		if (result?.text) {
			writeln(result.text);
		} else {
			// A queued prompt that the session has not reached yet answers with no
			// result. It is delivered, not lost.
			writeln(
				`${c.dim}[send]${c.reset} delivered to ${shortId(options.sessionId)}; ` +
					"no reply yet.",
			);
		}
		return 0;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		if (options.outputMode === "json") {
			emitJsonLine("stderr", {
				type: "send_error",
				sessionId: options.sessionId,
				message: detail,
			});
		} else {
			writeErr(`send failed: ${detail}`);
		}
		return 1;
	} finally {
		sessionClient.close();
	}
}
