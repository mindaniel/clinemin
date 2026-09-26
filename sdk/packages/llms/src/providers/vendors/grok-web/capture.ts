import type { LanguageModelV2FinishReason } from "@ai-sdk/provider";
import type { BasicLogger } from "@cline/shared";
import { computeSendDelay, isRateLimitText } from "../deepseek-web-v2";
import { abortableSleep, abortRace } from "../tool-pipeline/abort";
import { estimateWebUsage } from "../tool-pipeline/estimate-usage";
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

/**
 * The newest assistant reply in the open chat, as raw markdown, from the
 * endpoints grok.com's own page uses to load a conversation.
 */
const FETCH_LATEST_REPLY_EXPRESSION = `(async () => {
	try {
		const id = (location.pathname.match(/\\/c\\/([0-9a-f-]{36})/i) || [])[1];
		if (!id) return '';
		const nodesRes = await fetch('/rest/app-chat/conversations/' + id + '/response-node?includeThreads=true', { credentials: 'include' });
		if (!nodesRes.ok) return '';
		const nodes = ((await nodesRes.json()).responseNodes || []).filter((n) => n.sender === 'assistant' || n.sender === 'ASSISTANT');
		const last = nodes[nodes.length - 1];
		if (!last) return '';
		const res = await fetch('/rest/app-chat/conversations/' + id + '/load-responses', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ responseIds: [last.responseId] }),
		});
		if (!res.ok) return '';
		const reply = ((await res.json()).responses || []).find((r) => r.responseId === last.responseId);
		return (reply && typeof reply.message === 'string') ? reply.message : '';
	} catch {
		return '';
	}
})()`;

/**
 * Grok's query allowance, asked for directly.
 *
 * The page used to call `/rest/rate-limits` around every send and the network
 * listener below read the answer off the wire. It no longer does -- the call
 * never appears in the page's network log -- so the status bar sat on
 * "queries left: —" for good. Ask the same endpoint ourselves.
 *
 * Grok Auto spends from two buckets: `fast` (what an ordinary reply uses) and
 * `expert` (the harder-thinking one, with a much smaller allowance). Show
 * whichever has the smaller share left, since that is the one that stops the
 * session first.
 */
const FETCH_RATE_LIMIT_EXPRESSION = `(async () => {
	let best = null;
	for (const modelName of ['fast', 'expert']) {
		try {
			const res = await fetch('${Grok_RATE_LIMIT_ENDPOINT}', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ requestKind: 'DEFAULT', modelName }),
			});
			if (!res.ok) continue;
			const info = await res.json();
			if (!info || !(info.totalQueries > 0) || typeof info.remainingQueries !== 'number') continue;
			if (!best || info.remainingQueries / info.totalQueries < best.remainingQueries / best.totalQueries) best = info;
		} catch {}
	}
	return best ? JSON.stringify(best) : '';
})()`;

async function fetchGrokRateLimit(
	cdp: CdpClient,
	cdpSessionId: string,
): Promise<GrokRateLimitInfo | undefined> {
	try {
		const result = await cdp.send(
			"Runtime.evaluate",
			{
				expression: FETCH_RATE_LIMIT_EXPRESSION,
				returnByValue: true,
				awaitPromise: true,
			},
			cdpSessionId,
		);
		const value = result?.result?.value;
		return typeof value === "string" && value
			? (JSON.parse(value) as GrokRateLimitInfo)
			: undefined;
	} catch {
		return undefined;
	}
}

async function fetchLatestGrokReply(
	cdp: CdpClient,
	cdpSessionId: string,
): Promise<string | undefined> {
	try {
		const result = await cdp.send(
			"Runtime.evaluate",
			{
				expression: FETCH_LATEST_REPLY_EXPRESSION,
				returnByValue: true,
				awaitPromise: true,
			},
			cdpSessionId,
		);
		const value = result?.result?.value;
		return typeof value === "string" ? value : undefined;
	} catch {
		return undefined;
	}
}

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
	/** Grok's own query allowance, read off /rest/rate-limits during the turn. */
	rateLimit?: GrokRateLimitInfo;
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
	let capturedRateLimit: GrokRateLimitInfo | undefined;

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
				capturedRateLimit = rateLimitInfo;
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
	// Grok renders each reply as `[data-testid="assistant-message"]`. The
	// monitor used to take the FIRST match on the page and compared it with an
	// empty string, so in any chat with an earlier reply it "captured" that old
	// reply 1.2s after injection -- before this turn's message was even sent.
	// It now reads the LAST reply and ignores it until it differs from what was
	// on screen before sending.
	const monitorScript = `(() => {
		const replyNodes = () => document.querySelectorAll('[data-testid="assistant-message"]');
		const lastReply = () => { const n = replyNodes(); return n.length ? n[n.length - 1] : null; };
		const baselineCount = replyNodes().length;
		const baselineText = (lastReply() && lastReply().innerText) || '';
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
			const reply = lastReply();
			if (reply) {
				const text = reply.innerText || '';
				if (replyNodes().length <= baselineCount && text === baselineText) return null;
				if (text.includes('Working for') || text.includes('Thinking for') || text.trim() === '') return null;
				return text;
			}
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
			rateLimit: capturedRateLimit,
			rawBody: "",
		};
	}

	// The page only has the rendered reply: code fences are gone and line
	// breaks are whatever the renderer kept, so a ```powershell command or a
	// patch block read off the DOM does not parse. Grok's own conversation API
	// returns the reply as written; prefer it whenever it answers.
	const rawReply = await fetchLatestGrokReply(cdp, cdpSessionId);
	if (rawReply?.trim()) {
		fullText = rawReply;
	}
	capturedRateLimit ??= await fetchGrokRateLimit(cdp, cdpSessionId);

	// Parse tool calls from the full text (reuse existing parsing logic later)
	const finishReason: LanguageModelV2FinishReason = "stop";
	// Grok's page reports no token counts, so estimate them from the prompt
	// sent and the reply read back -- the same chars/3 rule gemini-web and
	// deepseek-web-v2 use. Without this the context bar sits at zero for the
	// whole session.
	const usage = estimateWebUsage(prompt, fullText);

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
		rateLimit: capturedRateLimit,
		rawBody: fullText, // raw body not available via DOM, but we have the text
	};
}
