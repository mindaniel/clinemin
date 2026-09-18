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

/** How often the watchdog looks at the page while waiting for a reply. */
const PAGE_POLL_MS = 2000;
/**
 * How long the page must show a finished reply, with no captured body, before
 * the watchdog stops trusting the network capture and rescues the reply.
 */
const SETTLED_GRACE_MS = 8000;
/** Consecutive unreadable page polls before the watchdog gives up on the tab. */
const MAX_UNREADABLE_POLLS = 30;

/**
 * Reads Claude's newest assistant message. claude.ai marks each reply with
 * `data-is-streaming`, which flips to "false" once the answer is complete.
 */
const PAGE_REPLY_STATE_EXPRESSION = `(() => {
	const nodes = document.querySelectorAll('[data-is-streaming]');
	const last = nodes[nodes.length - 1];
	return JSON.stringify({
		count: nodes.length,
		streaming: last ? last.getAttribute('data-is-streaming') === 'true' : false,
		text: last ? (last.innerText || '') : '',
	});
})()`;

/**
 * Fetches the newest assistant message as raw markdown from claude.ai's own
 * conversation API, using the page's logged-in session.
 *
 * This is the rescue path, and it must NOT use the rendered DOM: `innerText`
 * folds single newlines into one paragraph, so a `<manager>` block came back
 * as `<manager> TO: deepseek TOOLS: ...` on one line and never parsed. It
 * also carried the thinking summary. The API returns the text as written.
 */
const FETCH_LATEST_REPLY_EXPRESSION = `(async () => {
	try {
		const conv = (location.pathname.match(/\\/chat\\/([0-9a-f-]{36})/i) || [])[1];
		if (!conv) return JSON.stringify({ error: 'no conversation id in page URL' });
		let org = (document.cookie.match(/(?:^|;\\s*)lastActiveOrg=([^;]+)/) || [])[1];
		if (!org) {
			const orgs = await fetch('/api/organizations', { credentials: 'include' });
			if (orgs.ok) org = ((await orgs.json())[0] || {}).uuid;
		}
		if (!org) return JSON.stringify({ error: 'no organization id' });
		const res = await fetch('/api/organizations/' + org + '/chat_conversations/' + conv +
			'?tree=True&rendering_mode=messages&render_all_tools=true', { credentials: 'include' });
		if (!res.ok) return JSON.stringify({ error: 'conversation fetch HTTP ' + res.status });
		const data = await res.json();
		const messages = data.chat_messages || [];
		let msg = messages.find((m) => m.uuid === data.current_leaf_message_uuid);
		if (!msg || msg.sender !== 'assistant') {
			const assistants = messages.filter((m) => m.sender === 'assistant');
			msg = assistants[assistants.length - 1];
		}
		if (!msg) return JSON.stringify({ error: 'no assistant message' });
		const blocks = Array.isArray(msg.content) ? msg.content : [];
		const text = blocks.length
			? blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('')
			: (msg.text || '');
		return JSON.stringify({ text });
	} catch (err) {
		return JSON.stringify({ error: String(err) });
	}
})()`;

async function fetchLatestReplyMarkdown(
	cdp: CdpClient,
	cdpSessionId: string,
): Promise<{ text?: string; error?: string }> {
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
		const raw = result?.result?.value;
		if (typeof raw !== "string") return { error: "no result from page" };
		return JSON.parse(raw) as { text?: string; error?: string };
	} catch (err) {
		return { error: String(err) };
	}
}

export interface PageReplyState {
	count: number;
	streaming: boolean;
	text: string;
}

/**
 * Whether `state` is a finished reply that this turn produced.
 *
 * Node count alone is NOT a usable signal. claude.ai virtualises the
 * transcript: it keeps roughly the last three `[data-is-streaming]` nodes in
 * the DOM and drops the older ones as new replies arrive. Once a chat is long
 * enough for that window to be full, the count stops growing, so a
 * `count > baseline` gate is never satisfied again -- the watchdog stopped
 * rescuing replies in exactly the long manager-mode chats that need it, and
 * the turn hung for the whole `responseTimeoutMs` (20 minutes) with the answer
 * sitting finished on screen.
 *
 * So also accept a changed last-reply text. Only assistant messages carry the
 * attribute, so the text can only change once this turn's reply has rendered;
 * before that the last node is still the previous reply, matching the
 * baseline.
 */
export function isFinishedReply(
	state: PageReplyState | undefined,
	baseline: { count: number; text: string },
): boolean {
	if (!state || state.streaming) return false;
	const text = state.text.trim();
	if (!text) return false;
	return state.count > baseline.count || text !== baseline.text;
}

async function readPageReplyState(
	cdp: CdpClient,
	cdpSessionId: string,
): Promise<PageReplyState | undefined> {
	try {
		const result = await cdp.send(
			"Runtime.evaluate",
			{ expression: PAGE_REPLY_STATE_EXPRESSION, returnByValue: true },
			cdpSessionId,
		);
		const raw = result?.result?.value;
		if (typeof raw !== "string") return undefined;
		return JSON.parse(raw) as PageReplyState;
	} catch {
		return undefined;
	}
}

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
			response?: { url?: string; status?: number; mimeType?: string };
			requestId?: string;
		};
		const url: string = ev.response?.url ?? "";
		if (!url.includes(CLAUDE_API_ENDPOINT)) return;
		if (ev.response?.status !== 200) return;
		// An SSE stream on a conversation URL is the answer even if Claude
		// renames the path (e.g. `/retry_completion`).
		if (
			url.includes(CLAUDE_COMPLETION_PATH) ||
			ev.response?.mimeType === "text/event-stream"
		) {
			completionRequestId = ev.requestId;
			debugLog(`completion response received (${url})`);
			return;
		}
		debugLog(`non-completion conversation response ignored for now (${url})`);
	};
	let bodyReadError: string | undefined;
	const readBody = async (requestId: string): Promise<boolean> => {
		try {
			const { body, base64Encoded } = await cdp.send(
				"Network.getResponseBody",
				{ requestId },
				cdpSessionId,
			);
			const text = base64Encoded
				? Buffer.from(body, "base64").toString("utf-8")
				: body;
			if (!text) return false;
			capturedBody = text;
			bodyResolve?.();
			return true;
		} catch (err) {
			bodyReadError = String(err);
			return false;
		}
	};
	const onLoadingFinished = async (event: unknown, eventSessionId?: string) => {
		if (eventSessionId !== cdpSessionId) return;
		const ev = event as { requestId?: string };
		if (!completionRequestId) return;
		if (ev.requestId !== completionRequestId) return;
		debugLog("completion body fully written — reading it");
		if (!(await readBody(ev.requestId))) {
			// Not fatal: the page watchdog below retries, then reads the page.
			logger?.error?.(
				`[claude-web] failed to read response body: ${bodyReadError ?? "empty body"}`,
			);
		}
	};

	cdp.on("Network.responseReceived", onResponseReceived);
	cdp.on("Network.loadingFinished", onLoadingFinished);

	// Enable Network domain once per session, not per turn.
	// This is done in the caller (model.ts) to avoid repeated enable/disable.

	// Snapshot the page before sending, so the watchdog can tell this turn's
	// reply apart from the previous one.
	const before = await readPageReplyState(cdp, cdpSessionId);
	const baseline = {
		count: before?.count ?? 0,
		text: (before?.text ?? "").trim(),
	};

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
	//
	// The network capture alone could hang a turn for the whole timeout: the
	// reply was plainly finished in the browser, but no matching
	// `loadingFinished` arrived or its body could not be read, and nothing
	// else was watching. The watchdog polls the page; once the new reply has
	// stopped streaming for SETTLED_GRACE_MS it retries the body read, and
	// failing that takes the reply text straight from the page.
	const timeoutMs = config.responseTimeoutMs || 1200000;
	let domReplyText: string | undefined;
	let rescueError: string | undefined;
	let watchdogDone = false;
	void (async () => {
		let settledSince: number | undefined;
		let unreadablePolls = 0;
		while (!watchdogDone && !capturedBody) {
			await new Promise((resolve) => setTimeout(resolve, PAGE_POLL_MS));
			if (watchdogDone || capturedBody || signal?.aborted) return;
			const state = await readPageReplyState(cdp, cdpSessionId);
			// A page we cannot read at all is not "still streaming" -- it is a
			// dead CDP session, and waiting on it burns the full timeout. Give
			// it a minute, then fail the turn so `/paste` can recover the reply.
			if (state === undefined) {
				unreadablePolls += 1;
				if (unreadablePolls >= MAX_UNREADABLE_POLLS) {
					rescueError = `the page stopped responding to CDP for ${
						(MAX_UNREADABLE_POLLS * PAGE_POLL_MS) / 1000
					}s`;
					logger?.log?.(`[claude-web] ${rescueError}`, { severity: "warn" });
					bodyResolve?.();
					return;
				}
				settledSince = undefined;
				continue;
			}
			unreadablePolls = 0;
			if (!isFinishedReply(state, baseline)) {
				settledSince = undefined;
				continue;
			}
			settledSince ??= Date.now();
			if (Date.now() - settledSince < SETTLED_GRACE_MS) continue;
			if (completionRequestId && (await readBody(completionRequestId))) {
				logger?.log?.(
					"[claude-web] reply finished without a completion event; read the body on retry",
				);
				return;
			}
			if (capturedBody || watchdogDone) return;
			const reason = completionRequestId
				? `completion seen, body read failed: ${bodyReadError ?? "empty"}`
				: "no completion response seen";
			const fetched = await fetchLatestReplyMarkdown(cdp, cdpSessionId);
			if (capturedBody || watchdogDone) return;
			if (fetched.text?.trim()) {
				domReplyText = fetched.text;
				logger?.log?.(
					`[claude-web] reply finished in the browser but the network capture never delivered it (${reason}); fetched it from the conversation API`,
					{ severity: "warn" },
				);
			} else {
				rescueError = `${reason}; conversation API fallback failed: ${fetched.error ?? "empty text"}`;
				logger?.log?.(`[claude-web] ${rescueError}`, { severity: "warn" });
			}
			bodyResolve?.();
			return;
		}
	})();
	const timeoutPromise = abortableSleep(timeoutMs, signal);
	try {
		await Promise.race([bodyCaptured, timeoutPromise]);
	} finally {
		// Always unregister: a success used to leave both listeners attached.
		watchdogDone = true;
		cdp.off("Network.responseReceived", onResponseReceived);
		cdp.off("Network.loadingFinished", onLoadingFinished);
	}
	if (!capturedBody && domReplyText !== undefined) {
		const rateLimited = isRateLimitText(domReplyText);
		if (rateLimited) requestClaudeThrottleRecoveryReload();
		return {
			text: domReplyText,
			finishReason: "stop",
			usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
			rateLimited,
			rawBody: "",
		};
	}
	if (!capturedBody && rescueError) {
		// Fail the turn now instead of guessing at the reply. `/paste` recovers it.
		throw new Error(
			`[claude-web] could not read Claude's finished reply (${rescueError}). Copy it from the browser and use /paste.`,
		);
	}
	if (!capturedBody) {
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
