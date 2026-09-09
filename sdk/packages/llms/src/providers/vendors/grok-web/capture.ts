import type { LanguageModelV2FinishReason } from "@ai-sdk/provider";
import type { BasicLogger } from "@cline/shared";
import { computeSendDelay, isRateLimitText } from "../deepseek-web-v2";
import { abortableSleep, abortRace } from "../tool-pipeline/abort";
import type { CdpClient } from "./browser";
import {
	Grok_RATE_LIMIT_ENDPOINT,
	type GrokRateLimitInfo,
	type GrokWebV2RuntimeConfig,
	requestGrokThrottleRecoveryReload,
} from "./config";
import { buildSendScript } from "./send-script";

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
	config: GrokWebV2RuntimeConfig,
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
}> {
	const debugLog = (msg: string) => {
		if (config.debug) logger?.debug(`[grok-web] ${msg}`);
	};

	// DOM-based response capture (similar to grok.py's approach) to reliably capture
	// streaming responses, especially for subsequent messages in the same chat.
	let fullText = "";
	let responseResolve: (() => void) | undefined;
	const responseReady = new Promise<void>((resolve) => {
		responseResolve = resolve;
	});

	// Rate limit monitoring (network-based) for token usage tracking
	let rateLimitRequestId: string | undefined;

	const onResponseReceived = (
		event: { response?: { url?: string; status?: number }; requestId?: string },
		eventSessionId?: string,
	) => {
		if (eventSessionId !== cdpSessionId) return;
		const url: string = event.response?.url ?? "";
		// Check for rate-limit endpoint
		if (url.includes(Grok_RATE_LIMIT_ENDPOINT)) {
			if (event.response?.status === 200) {
				rateLimitRequestId = event.requestId;
				debugLog(`rate limit response received (${url})`);
			}
		}
	};

	const onLoadingFinished = async (
		event: { requestId?: string },
		eventSessionId?: string,
	) => {
		if (eventSessionId !== cdpSessionId) return;
		// Handle rate-limit response
		if (event.requestId === rateLimitRequestId) {
			debugLog("rate limit body fully written — reading it");
			try {
				const { body, base64Encoded } = await cdp.send(
					"Network.getResponseBody",
					{ requestId: event.requestId },
					cdpSessionId,
				);
				const responseBody = base64Encoded
					? Buffer.from(body, "base64").toString("utf-8")
					: body;
				const rateLimitInfo: GrokRateLimitInfo = JSON.parse(responseBody);
				debugLog(
					`Rate limit info: remaining=${rateLimitInfo.remainingQueries}, total=${rateLimitInfo.totalQueries}`,
				);
				// Store the rate limit info globally for later retrieval
				(globalThis as Record<string, unknown>).__grok_rate_limit =
					rateLimitInfo;
				// Call the config callback if provided
				if (config.onRateLimitUpdate) {
					config.onRateLimitUpdate(rateLimitInfo);
				}
			} catch (err) {
				logger?.error?.(
					`[grok-web] failed to read rate limit body: ${err instanceof Error ? err.message : String(err)}`,
				);
			} finally {
				rateLimitRequestId = undefined;
			}
		}
	};

	cdp.on("Network.responseReceived", onResponseReceived);
	cdp.on("Network.loadingFinished", onLoadingFinished);
	await cdp.send("Network.enable", {}, cdpSessionId);

	// Inject a DOM monitor that watches for assistant message content.
	// It tracks text changes and resolves when the response stabilizes (no changes for 1.2s).
	const monitorScript = `(() => {
		let lastContent = '';
		let lastChangeTime = Date.now();
		let stableTimer = null;
		let resolved = false;

		const checkStability = () => {
			if (resolved) return;
			const now = Date.now();
			if (now - lastChangeTime > 1200) {
				resolved = true;
				// Send final content back via console.log
				console.log('__GROK_RESPONSE_COMPLETE__', lastContent);
			}
		};

		const getAssistantContent = () => {
			// Try common selectors for assistant message content
			const selectors = [
				'.message.assistant .ProseMirror',
				'.assistant-message .ProseMirror',
				'[data-testid="assistant-message"]',
				'.ProseMirror[contenteditable="false"]'
			];
			for (const sel of selectors) {
				const el = document.querySelector(sel);
				if (el) {
					const text = el.textContent || '';
					// Ignore transient status messages
					if (text.includes('Working for') || text.includes('Thinking for') || text.trim() === '') {
						return null;
					}
					return text;
				}
			}
			// Fallback: look for any assistant message
			const allMessages = document.querySelectorAll('[role="article"], .message');
			for (const msg of allMessages) {
				if (msg.classList.contains('assistant') || msg.getAttribute('data-role') === 'assistant') {
					const text = msg.textContent || '';
					if (!text.includes('Working for') && !text.includes('Thinking for') && text.trim() !== '') {
						return text;
					}
				}
			}
			return null;
		};

		const checkForResponse = () => {
			const content = getAssistantContent();
			if (content !== null && content !== lastContent) {
				lastContent = content;
				lastChangeTime = Date.now();
				if (stableTimer) clearTimeout(stableTimer);
				stableTimer = setTimeout(checkStability, 1200);
				return true;
			}
			return false;
		};

		const observer = new MutationObserver(() => {
			checkForResponse();
		});
		observer.observe(document.body, {
			childList: true,
			subtree: true,
			characterData: true,
		});

		const pollInterval = setInterval(() => {
			checkForResponse();
		}, 200);

		// Cleanup after 5 minutes
		setTimeout(() => {
			observer.disconnect();
			clearInterval(pollInterval);
			if (stableTimer) clearTimeout(stableTimer);
			if (!resolved) {
				const content = getAssistantContent();
				if (content !== null && content.trim() !== '') {
					console.log('__GROK_RESPONSE_COMPLETE__', content);
				}
			}
		}, 300000);

		return () => {
			observer.disconnect();
			clearInterval(pollInterval);
			if (stableTimer) clearTimeout(stableTimer);
		};
	})();`;

	debugLog("injecting DOM monitor script");
	const monitorHandle = await cdp.send(
		"Runtime.evaluate",
		{
			expression: monitorScript,
			returnByValue: false,
			awaitPromise: false,
		},
		cdpSessionId,
	);

	// Listen for console messages from the page to capture the response
	const onConsoleMessage = (
		event: { args?: { value?: unknown }[] },
		eventSessionId?: string,
	) => {
		if (eventSessionId !== cdpSessionId) return;
		const msg = event?.args?.[0]?.value;
		if (msg === "__GROK_RESPONSE_COMPLETE__") {
			const content = event?.args?.[1]?.value;
			if (content && typeof content === "string") {
				debugLog(`DOM monitor captured response (${content.length} chars)`);
				fullText = content;
				responseResolve?.();
			}
		}
	};

	cdp.on("Runtime.consoleAPICalled", onConsoleMessage);
	await cdp.send("Runtime.enable", {}, cdpSessionId);

	// Pace sends to avoid hitting Grok's rate limits.
	const sendDelay = computeSendDelay(config, { isToolTurn });
	debugLog(
		`pacing: waiting ${sendDelay}ms before send (toolTurn=${String(isToolTurn)})`,
	);
	await abortableSleep(sendDelay, signal);

	// Send the prompt using the existing send script
	const sendScript = buildSendScript(prompt, sendOptions);
	debugLog("sending prompt via CDP");
	await cdp.send(
		"Runtime.evaluate",
		{
			expression: sendScript,
			returnByValue: true,
			awaitPromise: true,
		},
		cdpSessionId,
	);

	// Wait for the response to be captured by the DOM monitor
	const cancelled = abortRace(signal);
	const timeoutPromise = new Promise<void>((resolve) => {
		setTimeout(resolve, config.responseTimeoutMs);
	});
	try {
		await Promise.race([responseReady, timeoutPromise, cancelled.promise]);
	} finally {
		cancelled.dispose();
		// Clean up the monitor script
		if (monitorHandle?.result?.objectId) {
			try {
				await cdp.send(
					"Runtime.callFunctionOn",
					{
						functionDeclaration:
							"() => { if (window.__grokMonitorCleanup) window.__grokMonitorCleanup(); }",
						objectId: monitorHandle.result.objectId,
						returnByValue: false,
						awaitPromise: false,
					},
					cdpSessionId,
				);
			} catch {}
		}
		cdp.off("Runtime.consoleAPICalled", onConsoleMessage);
		await cdp.send("Runtime.disable", {}, cdpSessionId).catch(() => {});
		// Clean up network listeners
		cdp.off("Network.responseReceived", onResponseReceived);
		cdp.off("Network.loadingFinished", onLoadingFinished);
		await cdp.send("Network.disable", {}, cdpSessionId).catch(() => {});
	}

	if (!fullText) {
		return {
			text: "",
			finishReason: "stop",
			usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
			rawBody: "",
		};
	}

	// Parse tool calls from the full text (reuse existing parsing logic later)
	const finishReason: LanguageModelV2FinishReason = "stop";
	const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

	// Flag a throttled reply so the caller can back off / report it
	const rateLimited = isRateLimitText(fullText);
	if (rateLimited) {
		requestGrokThrottleRecoveryReload();
		logger?.log?.(
			"[grok-web] Grok throttled the request (rate-limit reply detected). " +
				"Next message will reload the page to recover, and sending is paced. " +
				"Consider raising Grok_WEB_MIN/MAX_SEND_DELAY_MS.",
		);
	}
	return {
		text: fullText,
		finishReason,
		usage,
		rateLimited,
		rawBody: fullText, // raw body not available via DOM, but we have the text
	};
}
