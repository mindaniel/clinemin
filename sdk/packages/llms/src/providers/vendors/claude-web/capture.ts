import type { LanguageModelV2FinishReason } from "@ai-sdk/provider";
import type { BasicLogger } from "@cline/shared";
import { isRateLimitText } from "../deepseek-web-v2";
import { abortableSleep } from "../tool-pipeline/abort";
import type { CdpClient } from "./browser";
import { requestClaudeThrottleRecoveryReload } from "./browser";
import type { ClaudeWebV2RuntimeConfig } from "./config";
import { CLAUDE_API_ENDPOINT, CLAUDE_COMPLETION_PATH } from "./config";
import { buildSendScript } from "./send-script";
import { consumeClaudeSse } from "./sse";

/**
 * Send a prompt to Claude and capture the response body via CDP Network domain.
 *
 * Drives the SAME tab/session `doGenerate` already attached to over CDP,
 * instead of launching a second, disconnected Playwright browser on the same
 * profile dir (the previous approach — that second browser competed for the
 * profile lock and its own "response" listener often never fired, which is
 * what surfaced as "Model returned empty response").
 *
 * Network.responseReceived/loadingFinished listeners are scoped to this
 * call's own cdpSessionId and unregistered in `finally`, so a listener left
 * over from an earlier turn never intercepts a later turn's response.
 */
export async function sendAndCapture(
	cdp: CdpClient,
	cdpSessionId: string,
	prompt: string,
	config: ClaudeWebV2RuntimeConfig,
	logger?: BasicLogger,
	sendOptions?: { think?: boolean },
	_isToolTurn = false,
	signal?: AbortSignal,
): Promise<{
	text: string;
	finishReason: LanguageModelV2FinishReason;
	usage: { inputTokens: number; outputTokens: number; totalTokens: number };
	rateLimited?: boolean;
	/** Raw JSON from a native `ask_user_input_v0` widget, when present. */
	askUserInput?: string;
	sessionStatus?: {
		percent: number;
		resetsAt?: string;
	};
	rawBody: string;
}> {
	const debugLog = (msg: string) => {
		if (config.debug) logger?.debug(`[claude-web] ${msg}`);
	};

	let completionRequestId: string | undefined;
	let capturedBody = "";
	let bodyResolve: (() => void) | undefined;
	const bodyCaptured = new Promise<void>((resolve) => {
		bodyResolve = resolve;
	});

	// Two ids, because not every `/chat_conversations/` response is the answer.
	//
	// Opening a brand-new chat mints the conversation as part of the first
	// send, so its create/fetch responses land inside this capture window and
	// hit the same prefix. Taking the first match read that JSON as though it
	// were the SSE stream: a body was captured, it parsed to no text at all,
	// and the turn surfaced as "Model returned empty response" — reliably, on
	// every first message of every new chat, while every later message in the
	// same chat worked.
	//
	// So prefer the completion stream, and fall back to a plain endpoint match
	// only if none was ever seen — that way a rename on Claude's side degrades
	// to the old behaviour instead of capturing nothing.
	const onResponseReceived = (event: unknown, eventSessionId?: string) => {
		if (eventSessionId !== cdpSessionId) return;
		const ev = event as {
			response?: { url?: string; status?: number };
			requestId?: string;
		};
		const url: string = ev.response?.url ?? "";
		if (!url.includes(CLAUDE_API_ENDPOINT)) return;
		if (ev.response?.status !== 200) return;
		if (url.includes(CLAUDE_COMPLETION_PATH)) {
			completionRequestId = ev.requestId;
			debugLog(`completion response received (${url})`);
			return;
		}
		debugLog(`non-completion conversation response ignored for now (${url})`);
	};
	const onLoadingFinished = async (event: unknown, eventSessionId?: string) => {
		if (eventSessionId !== cdpSessionId) return;
		const ev = event as { requestId?: string };
		if (!completionRequestId) return;
		if (ev.requestId !== completionRequestId) return;
		debugLog("completion body fully written — reading it");
		try {
			const { body, base64Encoded } = await cdp.send(
				"Network.getResponseBody",
				{ requestId: ev.requestId },
				cdpSessionId,
			);
			capturedBody = base64Encoded
				? Buffer.from(body, "base64").toString("utf-8")
				: body;
			if (bodyResolve) bodyResolve();
		} catch (err) {
			logger?.error?.(`[claude-web] failed to read response body: ${err}`);
		}
	};

	cdp.on("Network.responseReceived", onResponseReceived);
	cdp.on("Network.loadingFinished", onLoadingFinished);

	// Enable Network domain once per session, not per turn.
	// This is done in the caller (model.ts) to avoid repeated enable/disable.

	// Build the send script and inject it.
	const script = buildSendScript(prompt, sendOptions);
	try {
		await cdp.send(
			"Runtime.evaluate",
			{ expression: script, returnByValue: true },
			cdpSessionId,
		);
	} catch (err) {
		logger?.error?.(`[claude-web] failed to inject send script: ${err}`);
		throw err;
	}

	// Wait for the body to be captured, with timeout.
	const timeoutMs = config.responseTimeoutMs || 1200000;
	const timeoutPromise = abortableSleep(timeoutMs, signal);
	await Promise.race([bodyCaptured, timeoutPromise]);
	if (!capturedBody) {
		// Clean up listeners before throwing.
		cdp.off("Network.responseReceived", onResponseReceived);
		cdp.off("Network.loadingFinished", onLoadingFinished);
		throw new Error(
			`[claude-web] timeout waiting for completion response (${timeoutMs}ms)`,
		);
	}

	if (!capturedBody) {
		// Distinguish a real timeout (body never arrived) from a listener
		// gap. An empty captured body is exactly what used to silently
		// surface as "Model returned empty response" on the first message.
		throw new Error(
			`[claude-web] no completion response captured for the last message. ` +
				`${completionRequestId ? "A response was seen but its body could not be read." : "No Claude completion response was observed."} ` +
				"Check that claude.ai is logged in and not rate-limited in the browser profile.",
		);
	}

	let fullText = "";
	let askUserInput: string | undefined;
	let sessionStatus:
		| {
				percent: number;
				resetsAt?: string;
		  }
		| undefined;
	const finishReason: LanguageModelV2FinishReason = "stop";
	let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
	consumeClaudeSse(
		capturedBody,
		(chunk) => {
			fullText += chunk;
		},
		() => {},
		(err) => {
			logger?.error?.(`[claude-web] SSE parse error: ${err.message}`);
		},
		(nextUsage) => {
			usage = nextUsage;
		},
		(json) => {
			if (json) askUserInput = json;
		},
		(percent, resetsAt) => {
			sessionStatus = { percent, resetsAt };
			usage = {
				...usage,
				inputTokens: percent,
				totalTokens: percent,
			};
		},
	);

	// Flag a throttled reply so the caller can back off / report it, and
	// arm a one-shot recovery reload so the next turn forces a page
	// refresh to clear the temporarily-blocked composer.
	const rateLimited = isRateLimitText(fullText);
	if (rateLimited) {
		requestClaudeThrottleRecoveryReload();
		logger?.log?.(
			"[claude-web] Claude throttled the request (rate-limit reply detected). " +
				"Next message will reload the page to recover, and sending is paced. " +
				"Consider raising CLAUDE_WEB_MIN/MAX_SEND_DELAY_MS.",
		);
	}
	return {
		text: fullText,
		finishReason,
		usage,
		rateLimited,
		askUserInput,
		sessionStatus,
		rawBody: capturedBody,
	};
}
