/**
 * Sending one message and capturing the response body off the network.
 */

import type { LanguageModelV2FinishReason } from "@ai-sdk/provider";
import type { BasicLogger } from "@cline/shared";
import { estimateTokens } from "@cline/shared";
import { computeSendDelay, isRateLimitText } from "../deepseek-web-v2";
import { abortableSleep, abortRace } from "../tool-pipeline/abort";
import type { CdpClient } from "./browser";
import { chatgptNetworkEnabledSessions } from "./browser";
import {
	CHATGPT_API_ENDPOINT,
	type ChatGPTWebV2RuntimeConfig,
	requestChatGPTThrottleRecoveryReload,
} from "./config";
import { buildSendScript } from "./send-script";
import { consumeChatGPTSse } from "./sse";

// CDP event types
interface NetworkResponseEvent {
	response?: {
		url?: string;
		status?: number;
		mimeType?: string;
	};
	requestId?: string;
}

interface LoadingFinishedEvent {
	requestId?: string;
}

// ── Send and capture (CDP Network domain — mirrors deepseek-web-v2) ────────────

export async function sendAndCapture(
	cdp: CdpClient,
	cdpSessionId: string,
	prompt: string,
	config: ChatGPTWebV2RuntimeConfig,
	logger?: BasicLogger,
	sendOptions?: { think?: boolean },
	isToolTurn = false,
	signal?: AbortSignal,
): Promise<{
	text: string;
	finishReason: LanguageModelV2FinishReason;
	usage: { inputTokens: number; outputTokens: number; totalTokens: number };
	rateLimited?: boolean;
	quota?: { featureName: string; remaining: number; resetAfter: string }[];
	rawBody: string;
}> {
	const debugLog = (msg: string) => {
		if (config.debug) logger?.debug(`[chatgpt-web] ${msg}`);
	};

	let completionRequestId: string | undefined;
	let capturedBody = "";
	let bodyResolve: (() => void) | undefined;
	const bodyCaptured = new Promise<void>((resolve) => {
		bodyResolve = resolve;
	});

	const onResponseReceived = (
		event: NetworkResponseEvent,
		eventSessionId?: string,
	) => {
		if (eventSessionId !== cdpSessionId) return;
		const url: string = event.response?.url ?? "";
		if (!url.includes(CHATGPT_API_ENDPOINT)) return;
		if (event.response?.status !== 200) return;
		// Only the SSE completion stream carries the answer. ChatGPT fires
		// several calls under /backend-api/f/conversation (create, fetch,
		// rename, ...) on the first message of a new chat, and capturing the
		// first of those — a plain JSON body that parses to no text — is what
		// surfaced as "Model returned empty response". Filter on the SSE
		// content type, exactly like the Python reference automation does.
		const mimeType: string = event.response?.mimeType ?? "";
		if (!mimeType.includes("text/event-stream")) return;
		completionRequestId = event.requestId;
		debugLog(`completion response received (${url})`);
	};
	const onLoadingFinished = async (
		event: LoadingFinishedEvent,
		eventSessionId?: string,
	) => {
		if (eventSessionId !== cdpSessionId) return;
		if (event.requestId !== completionRequestId) return;
		debugLog("completion body fully written — reading it");
		try {
			const { body, base64Encoded } = await cdp.send(
				"Network.getResponseBody",
				{ requestId: event.requestId },
				cdpSessionId,
			);
			capturedBody = base64Encoded
				? Buffer.from(body, "base64").toString("utf-8")
				: body;
			debugLog(`completion body captured (${capturedBody.length} chars)`);
		} catch (err) {
			logger?.error?.(
				`[chatgpt-web] failed to read response body: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			bodyResolve?.();
		}
	};

	cdp.on("Network.responseReceived", onResponseReceived);
	cdp.on("Network.loadingFinished", onLoadingFinished);

	try {
		// Enable the Network domain ONCE per CDP session and leave it on for
		// the session's lifetime. The old code re-enabled here and re-disabled
		// in `finally` every turn — that toggle churn (plus re-attaching) could
		// drop a completion response and surface as "Model returned empty
		// response". Keeping the domain enabled is stable and harmless: the
		// listeners are still scoped/unregistered per turn.
		if (!chatgptNetworkEnabledSessions.has(cdpSessionId)) {
			await cdp.send("Network.enable", {}, cdpSessionId);
			chatgptNetworkEnabledSessions.add(cdpSessionId);
		}

		// Randomized human-like pacing before sending, plus an extra random
		// amount on tool-request turns (the fastest back-to-back pattern in an
		// agent run) — dodges chatgpt.com's own anti-abuse frequency throttle
		// the same way deepseek-web-v2 dodges DeepSeek's.
		const sendDelay = computeSendDelay(config, { isToolTurn });
		debugLog(
			`pacing: waiting ${sendDelay}ms before send (toolTurn=${String(isToolTurn)})`,
		);
		await abortableSleep(sendDelay, signal);

		// The send script waits on the composer accepting the text and the
		// submit landing, which on a slow or busy chatgpt.com tab runs past the
		// 30s default and failed the turn with `CDP timeout: Runtime.evaluate`.
		// Give it the same budget as the reply itself, so the one knob a user
		// can turn (CHATGPT_WEB_RESPONSE_TIMEOUT_MS) covers both halves.
		await cdp.send(
			"Runtime.evaluate",
			{
				expression: buildSendScript(prompt, sendOptions),
				returnByValue: true,
				awaitPromise: true,
			},
			cdpSessionId,
			config.responseTimeoutMs,
		);

		// A cancelled turn has to stop waiting here. Until this returns the CLI
		// still counts the turn as running and refuses the next message, so
		// without the abort in this race Escape looked like it worked and then
		// the input stayed dead until the response timeout fired minutes later.
		const cancelled = abortRace(signal);
		const timeoutPromise = new Promise<void>((resolve) => {
			setTimeout(resolve, config.responseTimeoutMs);
		});
		try {
			await Promise.race([bodyCaptured, timeoutPromise, cancelled.promise]);
		} finally {
			cancelled.dispose();
		}

		if (!capturedBody) {
			// Distinguish a real timeout (the body never arrived) from a
			// listener gap. An empty captured body after the wait is exactly the
			// condition that used to be returned as empty text and then bubbled
			// up as the opaque "Model returned empty response".
			throw new Error(
				`[chatgpt-web] no completion response captured for the last message. ` +
					`${completionRequestId ? "A response was seen but its body could not be read." : "No ChatGPT completion response was observed."} ` +
					"Check that chatgpt.com is logged in and not rate-limited in the browser profile.",
			);
		}

		let fullText = "";
		const finishReason: LanguageModelV2FinishReason = "stop";
		let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
		let quota:
			| { featureName: string; remaining: number; resetAfter: string }[]
			| undefined;
		consumeChatGPTSse(
			capturedBody,
			(chunk) => {
				fullText += chunk;
			},
			() => {},
			(err) => {
				logger?.error?.(`[chatgpt-web] SSE parse error: ${err.message}`);
			},
			(nextUsage) => {
				usage = nextUsage;
			},
			(q) => {
				quota = q;
			},
		);

		if (quota) {
			const reasonQuota = quota.find((q) => q.featureName === "reason");
			if (reasonQuota) {
				logger?.log?.(
					`[chatgpt-web] Token quota: ${reasonQuota.remaining} remaining, resets at ${reasonQuota.resetAfter}`,
				);
			}
		}

		// ChatGPT's web SSE stream often omits a `usage` payload, leaving the
		// numbers at zero. The Python reference automation estimates tokens from
		// the captured text instead (tiktoken cl100k_base, falling back to
		// max(words, chars/4)), and deepseek-web-v2 uses the repo-wide
		// `estimateTokens` (chars / 3). Do the same here so the context bar,
		// per-turn metrics, and session totals show real numbers instead of zeros.
		if (usage.totalTokens === 0) {
			const inputTokens = estimateTokens(prompt.length);
			const outputTokens = estimateTokens(fullText.length);
			usage = {
				inputTokens,
				outputTokens,
				totalTokens: inputTokens + outputTokens,
			};
		}

		// Flag a throttled reply so the caller can back off / report it, and
		// arm a one-shot recovery reload so the next turn forces a page
		// refresh to clear the temporarily-blocked composer.
		const rateLimited = isRateLimitText(fullText);
		if (rateLimited) {
			requestChatGPTThrottleRecoveryReload();
			logger?.log?.(
				"[chatgpt-web] ChatGPT throttled the request (rate-limit reply detected). " +
					"Next message will reload the page to recover, and sending is paced. " +
					"Consider raising CHATGPT_WEB_MIN/MAX_SEND_DELAY_MS.",
			);
		}
		return {
			text: fullText,
			finishReason,
			usage,
			rateLimited,
			quota,
			rawBody: capturedBody,
		};
	} finally {
		// Unregister only this turn's listeners. Leave the Network domain
		// enabled for the session — disabling it here was the other half of the
		// per-turn toggle that made capture flaky.
		cdp.off("Network.responseReceived", onResponseReceived);
		cdp.off("Network.loadingFinished", onLoadingFinished);
	}
}

export async function waitForComposerReady(
	cdp: CdpClient,
	sessionId: string,
	config: ChatGPTWebV2RuntimeConfig,
	logger?: BasicLogger,
): Promise<void> {
	const pageFullyLoaded = `(() => {
		if (document.readyState !== 'complete') return false;
		// Prioritize the visible ProseMirror div over the hidden fallback textarea
		var ta = document.querySelector('div#prompt-textarea') || 
				 document.querySelector('div[contenteditable="true"][role="textbox"]') || 
				 document.querySelector('textarea:not([style*="display: none"])');
		if (!ta) return false;
		// For divs, ensure they are actually contenteditable
		if (ta.tagName === 'DIV' && !ta.isContentEditable) return false;
		var s = window.getComputedStyle(ta);
		if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
		return true;
	})()`;

	const deadline = Date.now() + config.loginTimeoutMs;
	let hintLogged = false;
	for (;;) {
		let ready = false;
		try {
			const r = await cdp.send(
				"Runtime.evaluate",
				{
					expression: pageFullyLoaded,
					returnByValue: true,
					awaitPromise: true,
				},
				sessionId,
			);
			ready = r.result?.value === true;
		} catch {
			/* ignore */
		}

		if (ready) {
			if (config.debug) logger?.debug("[chatgpt-web] page fully loaded");
			return;
		}

		if (Date.now() >= deadline) {
			throw new Error("Timeout waiting for ChatGPT composer to become ready");
		}

		// Log a hint after 5 seconds if not ready
		if (!hintLogged && Date.now() - (deadline - config.loginTimeoutMs) > 5000) {
			hintLogged = true;
			logger?.log?.(
				"[chatgpt-web] waiting for ChatGPT composer to become ready... " +
					"If the page is not loaded, check your login status or network.",
			);
		}

		await new Promise((resolve) => setTimeout(resolve, 500));
	}
}
