/**
 * Sending one message and capturing the response body off the network.
 */

import type { LanguageModelV2FinishReason } from "@ai-sdk/provider";
import type { BasicLogger } from "@cline/shared";
import { computeSendDelay, isRateLimitText } from "../deepseek-web-v2";
import { abortableSleep, abortRace } from "../tool-pipeline/abort";
import type { CdpClient } from "../tool-pipeline/cdp-client";
import {
	KIMI_SUBSCRIPTION_STATS_ENDPOINT,
	Kimi_API_ENDPOINTS,
	type KimiWebV2RuntimeConfig,
	requestKimiThrottleRecoveryReload,
} from "./config";
import { buildSendScript } from "./send-script";
import { consumeKimiSse } from "./sse";

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

export async function sendAndCapture(
	cdp: CdpClient,
	cdpSessionId: string,
	prompt: string,
	config: KimiWebV2RuntimeConfig,
	logger?: BasicLogger,
	sendOptions?: { model?: string; thinkingMode?: string },
	isToolTurn = false,
	signal?: AbortSignal,
): Promise<{
	text: string;
	finishReason: LanguageModelV2FinishReason;
	usage: { inputTokens: number; outputTokens: number; totalTokens: number };
	rateLimited?: boolean;
	rawBody: string;
	subscriptionBalance?: {
		amountUsedRatio: number;
		usedPercent: number;
		expireTime: string;
	};
}> {
	const debugLog = (msg: string) => {
		if (config.debug) logger?.debug(`[kimi-web] ${msg}`);
	};

	let completionRequestId: string | undefined;
	let capturedBody = "";
	let subscriptionRequestId: string | undefined;
	let subscriptionBody = "";
	let bodyResolve: (() => void) | undefined;
	const bodyCaptured = new Promise<void>((resolve) => {
		bodyResolve = resolve;
	});

	// Every 200 the page received, for the error message when none of them was
	// the completion. Without this a changed endpoint path is indistinguishable
	// from "the model said nothing", and both surfaced as an empty reply.
	const seenResponses: string[] = [];

	const onResponseReceived = (event: any, eventSessionId?: string) => {
		if (eventSessionId !== cdpSessionId) return;
		const url: string = event.response?.url ?? "";
		if (event.response?.status !== 200) return;
		seenResponses.push(url);

		if (url.includes(KIMI_SUBSCRIPTION_STATS_ENDPOINT)) {
			subscriptionRequestId = event.requestId;
			debugLog(`subscription stats response received (${url})`);
			return;
		}

		// The answer arrives as a server-sent event stream. Matching the known
		// path first keeps the common case exact; falling back to the content
		// type means a kimi.ai that moves or versions its endpoint still works,
		// instead of every turn coming back blank with nothing to point at.
		const mimeType: string = event.response?.mimeType ?? "";
		const isCompletion =
			Kimi_API_ENDPOINTS.some((endpoint) => url.includes(endpoint)) ||
			(mimeType.includes("text/event-stream") && url.includes("kimi.ai"));
		if (!isCompletion) return;
		completionRequestId = event.requestId;
		debugLog(`completion response received (${url})`);
	};
	const onLoadingFinished = async (event: any, eventSessionId?: string) => {
		if (eventSessionId !== cdpSessionId) return;

		if (event.requestId === subscriptionRequestId) {
			try {
				const { body, base64Encoded } = await cdp.send(
					"Network.getResponseBody",
					{ requestId: event.requestId },
					cdpSessionId,
				);
				subscriptionBody = base64Encoded
					? Buffer.from(body, "base64").toString("utf-8")
					: body;
				debugLog(
					`subscription stats body captured (${subscriptionBody.length} chars)`,
				);
			} catch (err) {
				debugLog(
					`failed to read subscription stats body: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
			return;
		}

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
				`[kimi-web] failed to read response body: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			bodyResolve?.();
		}
	};

	cdp.on("Network.responseReceived", onResponseReceived);
	cdp.on("Network.loadingFinished", onLoadingFinished);

	try {
		await cdp.send("Network.enable", {}, cdpSessionId);

		// Randomized human-like pacing before sending, plus an extra random
		// amount on tool-request turns (the fastest back-to-back pattern in an
		// agent run) — dodges www.kimi.ai's own anti-abuse frequency throttle
		// the same way deepseek-web-v2 dodges DeepSeek's.
		const sendDelay = computeSendDelay(config, { isToolTurn });
		debugLog(
			`pacing: waiting ${sendDelay}ms before send (toolTurn=${String(isToolTurn)})`,
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
			// Returning empty text here is what made this so hard to diagnose: a
			// missed capture and a model that genuinely said nothing looked
			// identical, and the failure surfaced several layers up as "Model
			// returned empty response" with no mention of Kimi at all. Say which
			// of the two it was, and show what the page did fetch.
			const tail = seenResponses.slice(-8);
			throw new Error(
				`[kimi-web] no completion response captured for the last message. ` +
					(completionRequestId
						? "A response was seen but its body could not be read."
						: "No Kimi completion stream was observed.") +
					(tail.length
						? ` Responses seen: ${tail.join(", ")}.`
						: " The page made no requests at all.") +
					" Check that www.kimi.ai is logged in and not rate-limited in the browser profile.",
			);
		}

		let fullText = "";
		const finishReason: LanguageModelV2FinishReason = "stop";
		let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
		consumeKimiSse(
			capturedBody,
			(chunk) => {
				fullText += chunk;
			},
			() => {},
			(err) => {
				logger?.error?.(`[kimi-web] SSE parse error: ${err.message}`);
			},
			(nextUsage) => {
				usage = nextUsage;
			},
		);

		// Flag a throttled reply so the caller can back off / report it, and
		// arm a one-shot recovery reload so the next turn forces a page
		// refresh to clear the temporarily-blocked composer.
		const rateLimited = isRateLimitText(fullText);
		if (rateLimited) {
			requestKimiThrottleRecoveryReload();
			logger?.log?.(
				"[kimi-web] Kimi throttled the request (rate-limit reply detected). " +
					"Next message will reload the page to recover, and sending is paced. " +
					"Consider raising Kimi_WEB_MIN/MAX_SEND_DELAY_MS.",
			);
		}

		let subscriptionBalance:
			| {
					amountUsedRatio: number;
					usedPercent: number;
					expireTime: string;
			  }
			| undefined;

		if (subscriptionBody) {
			try {
				const parsed = JSON.parse(subscriptionBody);
				const balance = parsed?.subscriptionBalance;

				if (
					typeof balance?.amountUsedRatio === "number" &&
					typeof balance?.expireTime === "string"
				) {
					subscriptionBalance = {
						amountUsedRatio: balance.amountUsedRatio,
						usedPercent: balance.amountUsedRatio * 100,
						expireTime: balance.expireTime,
					};
				}
			} catch {
				debugLog("failed to parse subscription stats response");
			}
		}

		return {
			text: fullText,
			finishReason,
			usage,
			rateLimited,
			rawBody: capturedBody,
			subscriptionBalance,
		};
	} finally {
		cdp.off("Network.responseReceived", onResponseReceived);
		cdp.off("Network.loadingFinished", onLoadingFinished);
		await cdp.send("Network.disable", {}, cdpSessionId).catch(() => {});
	}
}
