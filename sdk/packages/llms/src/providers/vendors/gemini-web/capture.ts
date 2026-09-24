/**
 * Sending one message and capturing the response body off the network.
 */

import type { LanguageModelV2FinishReason } from "@ai-sdk/provider";
import type { BasicLogger } from "@cline/shared";
import { computeSendDelay, isRateLimitText } from "../deepseek-web-v2";
import { abortableSleep, abortRace } from "../tool-pipeline/abort";
import type { CdpClient } from "../tool-pipeline/cdp-client";
import { estimateWebUsage } from "../tool-pipeline/estimate-usage";
import {
	GEMINI_API_ENDPOINT,
	type GeminiWebV2RuntimeConfig,
	requestGeminiThrottleRecoveryReload,
} from "./config";
import { buildSendScript } from "./send-script";
import { consumeGeminiSse } from "./sse";

// ── Send and capture (CDP Network domain — mirrors deepseek-web-v2) ────────────
//
// Drives the SAME tab/session `doGenerate` already attached to over CDP,
// instead of launching a second, disconnected Playwright browser on the same
// profile dir (the previous approach — that second browser competed for the
// profile lock and its own "response" listener often never fired, which is
// what surfaced as "Model returned empty response").
//
// Network.responseReceived/loadingFinished listeners are scoped to this
// call's own cdpSessionId and unregistered in `finally`, so a listener left
// over from an earlier turn never intercepts a later turn's response.

const geminiNetworkEnabledSessions = new Set<string>();

export async function sendAndCapture(
	cdp: CdpClient,
	cdpSessionId: string,
	prompt: string,
	config: GeminiWebV2RuntimeConfig,
	logger?: BasicLogger,
	sendOptions?: { think?: boolean; model?: string | null },
	isToolTurn = false,
	signal?: AbortSignal,
): Promise<{
	text: string;
	finishReason: LanguageModelV2FinishReason;
	usage: { inputTokens: number; outputTokens: number; totalTokens: number };
	rateLimited?: boolean;
	rawBody: string;
}> {
	const debugLog = (msg: string) => {
		if (config.debug) logger?.debug(`[gemini-web] ${msg}`);
	};

	let completionRequestId: string | undefined;
	let capturedBody = "";
	let bodyResolve: (() => void) | undefined;
	const bodyCaptured = new Promise<void>((resolve) => {
		bodyResolve = resolve;
	});

	const onResponseReceived = (event: any, eventSessionId?: string) => {
		if (eventSessionId !== cdpSessionId) return;
		const url: string = event.response?.url ?? "";
		if (!url.toLowerCase().includes(GEMINI_API_ENDPOINT.toLowerCase())) return;
		if (event.response?.status !== 200) return;
		completionRequestId = event.requestId;
		debugLog(`completion response received (${url})`);
	};
	const onLoadingFinished = async (event: any, eventSessionId?: string) => {
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
				`[gemini-web] failed to read response body: ${err instanceof Error ? err.message : String(err)}`,
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
		if (!geminiNetworkEnabledSessions.has(cdpSessionId)) {
			await cdp.send("Network.enable", {}, cdpSessionId);
			geminiNetworkEnabledSessions.add(cdpSessionId);
		}

		// Randomized human-like pacing before sending, plus an extra random
		// amount on tool-request turns (the fastest back-to-back repeats are
		// what trigger the rate-limit most often).
		const sendDelay = computeSendDelay(
			{
				minSendDelayMs: config.minSendDelayMs,
				maxSendDelayMs: config.maxSendDelayMs,
				toolTurnExtraMinMs: config.toolTurnExtraMinMs,
				toolTurnExtraMaxMs: config.toolTurnExtraMaxMs,
			},
			{ isToolTurn },
		);
		debugLog(
			`sending after ${sendDelay}ms delay (toolTurn=${String(isToolTurn)})`,
		);
		await abortableSleep(sendDelay, signal);

		await cdp.send(
			"Runtime.evaluate",
			{
				expression: buildSendScript(prompt, sendOptions),
				returnByValue: true,
				awaitPromise: true,
			},
			cdpSessionId,
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
				`[gemini-web] no completion response captured for the last message. ` +
					`${completionRequestId ? "A response was seen but its body could not be read." : "No Gemini completion response was observed."} ` +
					"Check that gemini.google.com is logged in and not rate-limited in the browser profile.",
			);
		}

		let fullText = "";
		const finishReason: LanguageModelV2FinishReason = "stop";
		consumeGeminiSse(
			capturedBody,
			(chunk) => {
				fullText += chunk;
			},
			() => {},
			(err) => {
				logger?.error?.(`[gemini-web] SSE parse error: ${err.message}`);
			},
		);

		// The web endpoint does not report token counts, so estimate them from
		// the exact prompt sent and the buffered reply, mirroring the Python
		// reference automation (which estimates tokens from captured text) and
		// deepseek-web-v2's `estimateDeepSeekWebUsage`. Use the repo-wide
		// `estimateTokens` (chars / 3) so the context bar, per-turn metrics, and
		// session totals show real numbers instead of zeros.
		const usage = estimateWebUsage(prompt, fullText);

		// Flag a throttled reply so the caller can back off / report it, and
		// arm a one-shot recovery reload so the next turn forces a page
		// refresh to clear the temporarily-blocked composer.
		const rateLimited = isRateLimitText(fullText);
		if (rateLimited) {
			requestGeminiThrottleRecoveryReload();
			logger?.log?.(
				"[gemini-web] Gemini throttled the request (rate-limit reply detected). " +
					"Next message will reload the page to recover, and sending is paced. " +
					"Consider raising GEMINI_WEB_MIN/MAX_SEND_DELAY_MS.",
			);
		}
		return {
			text: fullText,
			finishReason,
			usage,
			rateLimited,
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
