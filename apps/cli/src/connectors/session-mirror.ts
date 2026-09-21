import type { HubSessionClient } from "@cline/core";
import type { Thread } from "chat";
import type { CliLoggerAdapter } from "../logging/adapter";
import {
	formatConnectorApprovalPrompt,
	formatConnectorToolStatus,
	type PendingConnectorApproval,
	parseToolApprovalInput,
} from "./runtime-turn";
import type { ConnectorThreadState } from "./thread-bindings";

/**
 * Live mirroring for an attached session.
 *
 * `/attach` alone makes a thread a one-way remote: it forwards a message and
 * prints what comes back. That is enough to steer a session, and not enough to
 * watch one — a turn started from the laptop TUI, or a tool call that stops to
 * ask permission, produces nothing on the phone at all. From there a session
 * that is waiting on an approval is indistinguishable from one that has
 * stopped replying.
 *
 * A mirror is a long-lived subscription to that session's hub events, running
 * independently of whether this thread started the turn. It is what turns
 * `/attach` from dispatch into remote control: assistant replies, tool
 * activity and approval requests all reach the thread, whoever caused them.
 *
 * ## One mirror per thread, not per session
 *
 * Keyed by thread id because that is the thing being written to. Two threads
 * may watch one session — a phone and a group chat — and each needs its own
 * subscription and its own pending-approval slot. The reverse cannot happen: a
 * thread attaches to one session at a time, so starting a mirror replaces any
 * mirror that thread already had.
 */

type MirrorEntry = {
	sessionId: string;
	unsubscribe: () => void;
};

/**
 * On the module rather than threaded through the call graph.
 *
 * A mirror outlives the turn that created it and has to be findable from
 * `/detach`, from the next inbound message, and from connector shutdown —
 * three call sites with no shared object between them. The connector process
 * owns one hub connection and one set of threads, so a module-level registry is
 * the same lifetime as the thing it tracks.
 */
const mirrors = new Map<string, MirrorEntry>();

export function isSessionMirrored(threadId: string): boolean {
	return mirrors.has(threadId);
}

export function mirroredSessionId(threadId: string): string | undefined {
	return mirrors.get(threadId)?.sessionId;
}

export function stopSessionMirror(threadId: string): boolean {
	const entry = mirrors.get(threadId);
	if (!entry) {
		return false;
	}
	mirrors.delete(threadId);
	try {
		entry.unsubscribe();
	} catch {
		// Best-effort: a stream that is already closed is the state we wanted.
	}
	return true;
}

/** Drop every mirror. Called when the connector shuts down. */
export function stopAllSessionMirrors(): void {
	for (const threadId of Array.from(mirrors.keys())) {
		stopSessionMirror(threadId);
	}
}

function payloadString(
	payload: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = payload[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Accumulate `text_delta`, because the hub sends it either way.
 *
 * `accumulated` is the whole reply so far when the provider gives one, and
 * `text` is the increment when it does not. Preferring `accumulated` when it
 * extends what we have keeps a provider that re-sends its prefix from doubling
 * the reply.
 */
function applyTextDelta(
	payload: Record<string, unknown>,
	previous: string,
): string {
	const accumulated = payload.accumulated;
	if (typeof accumulated === "string") {
		if (accumulated.startsWith(previous)) {
			return accumulated;
		}
		if (previous.startsWith(accumulated)) {
			return previous;
		}
	}
	const text = typeof payload.text === "string" ? payload.text : "";
	return `${previous}${text}`;
}

export interface StartSessionMirrorOptions<
	TState extends ConnectorThreadState,
> {
	thread: Thread<TState>;
	sessionId: string;
	client: HubSessionClient;
	clientId: string;
	transport: string;
	logger: CliLoggerAdapter;
	pendingApprovals: Map<string, PendingConnectorApproval>;
	/** Post a line to the thread. Supplied so this file owns no formatting. */
	post: (text: string) => Promise<void>;
}

/**
 * Start mirroring `sessionId` into `thread`.
 *
 * Replaces any mirror the thread already had, and is a no-op when it is
 * already mirroring this same session — `/attach` to the session you are on
 * should not silently double every message from then on.
 */
export function startSessionMirror<TState extends ConnectorThreadState>(
	options: StartSessionMirrorOptions<TState>,
): void {
	const threadId = options.thread.id;
	const existing = mirrors.get(threadId);
	if (existing?.sessionId === options.sessionId) {
		return;
	}
	stopSessionMirror(threadId);

	let streamedText = "";
	let lastStatus = "";
	/** Whether any assistant text reached the thread during this turn. */
	let postedTextThisTurn = false;

	const post = (text: string): void => {
		if (!text.trim()) {
			return;
		}
		void options.post(text).catch((error) => {
			options.logger.core.log("Session mirror could not post to thread", {
				severity: "warn",
				transport: options.transport,
				threadId,
				sessionId: options.sessionId,
				error,
			});
		});
	};

	/**
	 * Post the assistant text collected so far and start collecting afresh.
	 *
	 * Called whenever the model finishes speaking — before a tool status, at
	 * the end of every iteration, at the end of the turn — rather than only on
	 * the turn's terminal event. That event carries no reply text, and a turn
	 * that ran from the hub's queue (every message sent from here while the
	 * session is busy or owned by a TUI) may not produce one this mirror sees.
	 * Waiting for it is how a whole answer never reached the phone.
	 */
	const flushText = (): void => {
		const text = streamedText;
		streamedText = "";
		if (text.trim()) {
			postedTextThisTurn = true;
			post(text);
		}
	};

	const unsubscribe = options.client.streamEvents(
		{ clientId: options.clientId, sessionIds: [options.sessionId] },
		{
			onEvent: (event) => {
				switch (event.eventType) {
					case "approval.requested": {
						const approvalId = payloadString(event.payload, "approvalId");
						const toolCallId = payloadString(event.payload, "toolCallId");
						const toolName = payloadString(event.payload, "toolName");
						if (!approvalId || !toolCallId || !toolName) {
							return;
						}
						const approval: PendingConnectorApproval = {
							approvalId,
							sessionId: options.sessionId,
							toolCallId,
							toolName,
							input: parseToolApprovalInput(event.payload.inputJson),
						};
						// The same slot the connector's own turns use, so the existing
						// Y/N reply handler answers this without knowing the difference.
						options.pendingApprovals.set(threadId, approval);
						post(formatConnectorApprovalPrompt(approval));
						return;
					}
					case "runtime.chat.tool_call_start": {
						// What the model said before calling the tool comes first.
						flushText();
						const status = formatConnectorToolStatus({
							toolName: payloadString(event.payload, "toolName"),
							status: "start",
							toolInput: event.payload.input,
						});
						// Deduped: a retried call repeats the identical line, and on a
						// phone that reads as the tool running twice.
						if (status && status !== lastStatus) {
							lastStatus = status;
							post(status);
						}
						return;
					}
					case "runtime.chat.text_delta": {
						streamedText = applyTextDelta(event.payload, streamedText);
						return;
					}
					case "runtime.chat.iteration_end": {
						flushText();
						return;
					}
					case "runtime.chat.completed": {
						flushText();
						// Nothing streamed at all: fall back to the result's own text.
						if (!postedTextThisTurn) {
							const result = event.payload.result;
							const resultText =
								result && typeof result === "object"
									? payloadString(result as Record<string, unknown>, "text")
									: undefined;
							const fallback =
								payloadString(event.payload, "text") || resultText;
							if (fallback) post(fallback);
						}
						postedTextThisTurn = false;
						lastStatus = "";
						return;
					}
					case "runtime.chat.aborted": {
						flushText();
						postedTextThisTurn = false;
						lastStatus = "";
						post("Task aborted.");
						return;
					}
					case "runtime.chat.failed": {
						flushText();
						const message =
							payloadString(event.payload, "error") || "Runtime turn failed";
						postedTextThisTurn = false;
						lastStatus = "";
						post(`Task failed: ${message}`);
						return;
					}
					default:
						return;
				}
			},
			onError: (error) => {
				options.logger.core.log("Session mirror event stream failed", {
					severity: "warn",
					transport: options.transport,
					threadId,
					sessionId: options.sessionId,
					error,
				});
			},
		},
	);

	mirrors.set(threadId, { sessionId: options.sessionId, unsubscribe });
}
