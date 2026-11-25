import type { LanguageModelV2FinishReason } from "@ai-sdk/provider";
import type { BasicLogger } from "@cline/shared";
import { computeSendDelay, isRateLimitText } from "../deepseek-web-v2";
import { abortableSleep, abortRace } from "../tool-pipeline/abort";
import { estimateWebUsage } from "../tool-pipeline/estimate-usage";
import type { CdpClient } from "./browser";
import {
	COPILOT_CHATHUB_RE,
	type CopilotRateLimitInfo,
	type CopilotWebV2RuntimeConfig,
	requestCopilotThrottleRecoveryReload,
} from "./config";

// ── Send and capture ──────────────────────────────────────────────────────────
//
// copilot.com answers over a SignalR websocket (`/m365Copilot/Chathub/`), one
// per turn. Records are JSON separated by \x1e:
//
//   {"type":1,"target":"update","arguments":[{"messages":[{"author":"bot",
//     "text":"<the reply so far, markdown>", ...}], "throttling": {...}}]}
//   ...                                  (each update repeats the whole text)
//   {"type":1,"target":"update","arguments":[{..., "isLastUpdate":true}]}
//   {"type":3,"invocationId":"0"}         (the turn is over)
//
// The reply text is read off those frames with the Network domain, so it keeps
// its markdown (code fences, line breaks), which the rendered page loses.
// Progress lines ("Looking into it…") carry a `contentType` or `messageType`
// and are skipped. The message is typed into the real composer, because the
// page attaches a Cloudflare Turnstile proof to every send.

const RECORD_SEPARATOR = "\u001e";
const EDITOR_SELECTOR =
	'#m365-chat-editor-target-element, [contenteditable="true"][aria-label*="Copilot" i]';

interface HubMessage {
	author?: string;
	text?: unknown;
	messageType?: unknown;
	contentType?: unknown;
	messageId?: string;
}

interface HubUpdate {
	messages?: HubMessage[];
	throttling?: Partial<CopilotRateLimitInfo>;
	isLastUpdate?: boolean;
}

/** What one websocket frame says about the turn. */
export interface ChathubFrameInfo {
	/** Reply text from this frame (the whole reply so far), if any. */
	text?: string;
	throttling?: CopilotRateLimitInfo;
	/** The last update, or the invocation finished. */
	done: boolean;
	/** A `type: 3` completion that carried an error. */
	error?: string;
}

/** Parse one websocket payload from the chat hub. Exported for tests. */
export function parseChathubFrame(payload: string): ChathubFrameInfo {
	const info: ChathubFrameInfo = { done: false };
	for (const record of payload.split(RECORD_SEPARATOR)) {
		if (!record.trim()) continue;
		let msg: {
			type?: number;
			target?: string;
			arguments?: HubUpdate[];
			error?: string;
			item?: {
				result?: { value?: string; message?: string };
				turnState?: string;
				messages?: HubMessage[];
			};
		};
		try {
			msg = JSON.parse(record);
		} catch {
			continue;
		}
		if (msg.type === 1 && msg.target === "update") {
			for (const arg of msg.arguments ?? []) {
				for (const m of arg.messages ?? []) {
					if (m.author !== "bot" || typeof m.text !== "string") continue;
					if (m.messageType || m.contentType) continue;
					info.text = m.text;
				}
				const t = arg.throttling;
				if (
					t &&
					typeof t.maxNumUserMessagesInConversation === "number" &&
					typeof t.numUserMessagesInConversation === "number"
				) {
					info.throttling = {
						maxNumUserMessagesInConversation:
							t.maxNumUserMessagesInConversation,
						numUserMessagesInConversation: t.numUserMessagesInConversation,
					};
				}
				if (arg.isLastUpdate) info.done = true;
			}
		} else if (msg.type === 2) {
			// The invocation's result: a refusal or a throttle notice arrives here.
			const r = msg.item?.result;
			if (r && r.value && r.value !== "Success") {
				info.error = r.message || r.value;
			}
			// A turn Copilot refuses outright (the daily limit) has no update
			// frame with text: its notice is only in the result's messages.
			if (msg.item?.turnState === "Failed") {
				for (const m of msg.item.messages ?? []) {
					if (m.author !== "bot" || typeof m.text !== "string") continue;
					if (m.messageType || m.contentType) continue;
					info.text = m.text;
				}
			}
		} else if (msg.type === 3) {
			info.done = true;
			if (msg.error) info.error = msg.error;
		} else if (msg.type === 7) {
			info.done = true;
			info.error = msg.error || "the chat hub closed the connection";
		}
	}
	return info;
}

async function evaluate(
	cdp: CdpClient,
	cdpSessionId: string,
	expression: string,
): Promise<unknown> {
	const res = await cdp.send(
		"Runtime.evaluate",
		{ expression, returnByValue: true, awaitPromise: true },
		cdpSessionId,
	);
	return res?.result?.value;
}

async function pressKey(
	cdp: CdpClient,
	cdpSessionId: string,
	key: { key: string; code: string; keyCode: number; modifiers?: number },
	text?: string,
): Promise<void> {
	const base = {
		key: key.key,
		code: key.code,
		windowsVirtualKeyCode: key.keyCode,
		modifiers: key.modifiers ?? 0,
	};
	await cdp.send(
		"Input.dispatchKeyEvent",
		{ type: "keyDown", ...base, ...(text ? { text } : {}) },
		cdpSessionId,
	);
	await cdp.send(
		"Input.dispatchKeyEvent",
		{ type: "keyUp", ...base },
		cdpSessionId,
	);
}

/** Type `prompt` into the composer (replacing anything there) and press Enter. */
async function typeAndSend(
	cdp: CdpClient,
	cdpSessionId: string,
	prompt: string,
): Promise<void> {
	const focused = await evaluate(
		cdp,
		cdpSessionId,
		`(() => { const e = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}); if (!e) return false; e.focus(); return true; })()`,
	);
	if (focused !== true) {
		throw new Error("Copilot Web: the message box was not found on the page.");
	}
	// Clear a draft left in the box (Ctrl+A, Delete).
	await pressKey(cdp, cdpSessionId, {
		key: "a",
		code: "KeyA",
		keyCode: 65,
		modifiers: 2,
	});
	await pressKey(cdp, cdpSessionId, {
		key: "Delete",
		code: "Delete",
		keyCode: 46,
	});
	await cdp.send("Input.insertText", { text: prompt }, cdpSessionId);
	// Let the editor take a long paste in before sending it.
	await abortableSleep(Math.min(3000, 300 + prompt.length / 50));
	const typed = await evaluate(
		cdp,
		cdpSessionId,
		`(() => { const e = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}); return e ? e.innerText.length : -1; })()`,
	);
	if (typeof typed === "number" && typed < Math.min(prompt.length, 20) / 2) {
		throw new Error("Copilot Web: the message did not reach the message box.");
	}
	await pressKey(
		cdp,
		cdpSessionId,
		{ key: "Enter", code: "Enter", keyCode: 13 },
		"\r",
	);
}

/** How long a sent message may go without the chat hub connecting. */
const HUB_CONNECT_TIMEOUT_MS = 30_000;

/**
 * Copilot opens the chat hub socket within a second or two of a send. When it
 * does not, something on the page took the Enter instead, usually a one-time
 * dialog (the ads consent on a new chat, a sign-in prompt). Fail with what the
 * dialog says instead of waiting out the 20-minute reply timeout.
 */
async function waitForHubSocket(
	cdp: CdpClient,
	cdpSessionId: string,
	connected: () => boolean,
	signal?: AbortSignal,
): Promise<void> {
	const deadline = Date.now() + HUB_CONNECT_TIMEOUT_MS;
	while (!connected() && Date.now() < deadline) {
		await abortableSleep(500, signal);
	}
	if (connected()) return;
	const dialog = await evaluate(
		cdp,
		cdpSessionId,
		`(() => { const d = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')].find((e) => e.offsetWidth > 0 && e.innerText.trim()); return d ? d.innerText.trim().split("\\n")[0].slice(0, 120) : ""; })()`,
	).catch(() => "");
	throw new Error(
		dialog
			? `Copilot Web: a dialog in the browser window is blocking the send ("${dialog}"). Answer it there, then resend.`
			: "Copilot Web: the message was not sent (no reply connection opened). Check the browser window, then resend.",
	);
}

export async function sendAndCapture(
	cdp: CdpClient,
	cdpSessionId: string,
	prompt: string,
	config: CopilotWebV2RuntimeConfig,
	logger?: BasicLogger,
	_sendOptions?: { model?: string; thinkingMode?: string },
	isToolTurn = false,
	signal?: AbortSignal,
): Promise<{
	text: string;
	finishReason: LanguageModelV2FinishReason;
	usage: { inputTokens: number; outputTokens: number; totalTokens: number };
	rateLimited?: boolean;
	/** The chat's message allowance, from the hub's `throttling` field. */
	rateLimit?: CopilotRateLimitInfo;
	rawBody: string;
}> {
	const debugLog = (msg: string) => {
		if (config.debug) logger?.debug(`[copilot-web] ${msg}`);
	};

	const hubSockets = new Set<string>();
	const frames: string[] = [];
	let text = "";
	let error: string | undefined;
	let rateLimit: CopilotRateLimitInfo | undefined;
	let finish: (() => void) | undefined;
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});

	const onSocketCreated = (
		event: { requestId?: string; url?: string },
		eventSessionId?: string,
	) => {
		if (eventSessionId !== cdpSessionId || !event.requestId) return;
		if (COPILOT_CHATHUB_RE.test(event.url ?? "")) {
			hubSockets.add(event.requestId);
			debugLog(`chat hub socket opened (${event.requestId})`);
		}
	};
	const onFrame = (
		event: { requestId?: string; response?: { payloadData?: string } },
		eventSessionId?: string,
	) => {
		if (eventSessionId !== cdpSessionId) return;
		if (!event.requestId) return;
		const payload = event.response?.payloadData ?? "";
		// A hub socket opened before Network.enable was never announced: take
		// its frames by their shape.
		if (!hubSockets.has(event.requestId)) {
			if (!payload.includes('"target":"update"')) return;
			hubSockets.add(event.requestId);
		}
		frames.push(payload);
		const info = parseChathubFrame(payload);
		if (info.text !== undefined) text = info.text;
		if (info.throttling) {
			rateLimit = info.throttling;
			config.onRateLimitUpdate?.(info.throttling);
		}
		if (info.error) error = info.error;
		if (info.done) finish?.();
	};

	cdp.on("Network.webSocketCreated", onSocketCreated);
	cdp.on("Network.webSocketFrameReceived", onFrame);
	await cdp.send("Network.enable", {}, cdpSessionId);

	try {
		const sendDelay = computeSendDelay(config, { isToolTurn });
		debugLog(`pacing: waiting ${sendDelay}ms before send`);
		await abortableSleep(sendDelay, signal);

		debugLog(`typing the prompt (${prompt.length} chars)`);
		await typeAndSend(cdp, cdpSessionId, prompt);
		await waitForHubSocket(
			cdp,
			cdpSessionId,
			() => hubSockets.size > 0,
			signal,
		);

		const cancelled = abortRace(signal);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, config.responseTimeoutMs);
		});
		try {
			await Promise.race([finished, timeout, cancelled.promise]);
		} finally {
			cancelled.dispose();
			if (timer) clearTimeout(timer);
		}
	} finally {
		cdp.off("Network.webSocketCreated", onSocketCreated);
		cdp.off("Network.webSocketFrameReceived", onFrame);
		await cdp.send("Network.disable", {}, cdpSessionId).catch(() => {});
	}

	const rawBody = frames.join("\n");
	if (!text && error) {
		logger?.log?.(`[copilot-web] Copilot returned no reply: ${error}`, {
			severity: "warn",
		});
		text = `Copilot returned no reply: ${error}`;
	}
	if (!text && hubSockets.size === 0) {
		logger?.log?.(
			"[copilot-web] no chat hub connection was seen: the message may not have been sent (check the browser window).",
			{ severity: "warn" },
		);
	}

	const rateLimited = Boolean(text) && isRateLimitText(text);
	if (rateLimited) {
		requestCopilotThrottleRecoveryReload();
		logger?.log?.(
			"[copilot-web] Copilot throttled the request. The next message reloads the page.",
		);
	}
	return {
		text,
		finishReason: "stop",
		usage: text
			? estimateWebUsage(prompt, text)
			: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
		rateLimited,
		rateLimit,
		rawBody,
	};
}
