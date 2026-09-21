import type { BasicLogger } from "@cline/shared";
import {
	consumeDeepSeekSse,
	type DeepSeekSseDiagnostics,
	describeEmptyDeepSeekStream,
	isRateLimitDiagnostic,
	waitWithAbort,
} from "../deepseek-web";
import { isAbortError } from "../tool-pipeline/abort";
import { confirmChatLocation } from "../tool-pipeline/confirm-chat-location";
import {
	type CdpClient,
	connectBrowser,
	ensureDeepSeekPage,
	navigateDeepSeekChat,
	readPageUrl,
	waitForComposerReady,
	withTimeout,
} from "./browser";
import {
	lookupChatSession,
	parseSessionIdFromUrl,
	recordChatSession,
} from "./chat-registry";
import {
	computeSendDelay,
	consumeThrottleRecoveryReload,
	createPushSink,
	type DeepSeekWebV2RuntimeConfig,
	isRateLimitText,
	requestThrottleRecoveryReload,
	resolveDeepSeekWebV2Config,
	sleep,
} from "./config";
import { buildSendScript, resolveV2ModelOptions } from "./send-script";
// ── Completion capture (Network domain — mirrors browser.py page.on("response")) ─

/**
 * Send `prompt` through the real chat.deepseek.com UI and stream the
 * `chat/completion` SSE body back through `onText` / `onReasoning`.
 *
 * The response is observed with the CDP Network domain, exactly like
 * `browser.py`'s `page.on("response")` listener: the request is NOT paused or
 * interfered with, and the body is only read after `Network.loadingFinished`
 * confirms it is fully written (`Network.getResponseBody`).
 */
export async function streamCompletionFromPage(input: {
	cdp: CdpClient;
	sessionId: string;
	config: DeepSeekWebV2RuntimeConfig;
	prompt: string;
	modelType: string;
	deepThinking: boolean | null;
	thinkingEnabled: boolean;
	/**
	 * `true` when this turn is expected to request tool calls. Tool turns are
	 * the most rapid-fire pattern in an agent run, so they get an extra
	 * randomized delay before sending to dodge DeepSeek's frequency throttle.
	 */
	isToolTurn: boolean;
	onText?: (text: string) => void;
	onReasoning?: (text: string) => void;
	signal?: AbortSignal;
	logger?: BasicLogger;
}): Promise<{
	text: string;
	reasoning: string;
	accumulatedTokenUsage?: number;
	rateLimited?: boolean;
	rawBody: string;
	diagnostics?: DeepSeekSseDiagnostics;
}> {
	const {
		cdp,
		sessionId,
		config,
		prompt,
		modelType,
		deepThinking,
		thinkingEnabled,
		isToolTurn,
		onText,
		onReasoning,
		signal,
		logger,
	} = input;

	const debugLog = (message: string): void => {
		if (config.debug) logger?.debug(`[deepseek-web-v2] ${message}`);
	};

	let capturedRawBody = "";
	const sink = createPushSink();
	const sseDone = consumeDeepSeekSse(
		sink.stream,
		onText,
		onReasoning,
		thinkingEnabled,
	);

	const result: {
		text: string;
		reasoning: string;
		accumulatedTokenUsage?: number;
		rateLimited?: boolean;
		rawBody: string;
		diagnostics?: DeepSeekSseDiagnostics;
	} = { text: "", reasoning: "", rawBody: "" };
	// Request id of the chat/completion response, set when headers arrive.
	let completionRequestId: string | undefined;

	// Observe the completion response like browser.py's page.on("response") —
	// the Network domain watches without pausing the request, and the body is
	// only read after `loadingFinished` confirms it is fully written.
	// Scoped to this call's own CDP sessionId and unregistered in `finally` —
	// without both, a listener from an earlier turn stays registered on the
	// shared `activeCdp` (module-level singleton) forever, still fires on every
	// later turn's events, and races the current turn's own listener for
	// `Network.getResponseBody`. That's what made capture flaky "after a while".
	const onResponseReceived = (event: any, eventSessionId?: string) => {
		if (eventSessionId !== sessionId) return;
		const url: string = event.response?.url ?? "";
		if (!url.includes("chat/completion")) return;
		if (event.response?.status !== 200) return;
		completionRequestId = event.requestId;
		debugLog(`completion response received (${url})`);
	};
	const onLoadingFinished = async (event: any, eventSessionId?: string) => {
		if (eventSessionId !== sessionId) return;
		if (event.requestId !== completionRequestId) return;
		debugLog("completion body fully written — reading it");
		try {
			const { body, base64Encoded } = await cdp.send(
				"Network.getResponseBody",
				{ requestId: event.requestId },
				sessionId,
			);
			const rawBody = base64Encoded
				? Buffer.from(body, "base64").toString("utf-8")
				: body;
			capturedRawBody = rawBody;
			sink.push(
				base64Encoded
					? Buffer.from(body, "base64")
					: new TextEncoder().encode(body),
			);
			sink.close();
			debugLog(`completion body captured (${body.length} chars)`);
		} catch (err) {
			sink.error(err);
		}
	};
	cdp.on("Network.responseReceived", onResponseReceived);
	cdp.on("Network.loadingFinished", onLoadingFinished);

	try {
		await cdp.send("Network.enable", {}, sessionId);

		if (signal?.aborted) {
			throw new DOMException("Aborted", "AbortError");
		}

		// Randomized human-like pacing — the fix for DeepSeek's "Messages too
		// frequent" throttle. Wait a random `[min,max]` before firing, plus an
		// extra random amount on tool-request turns (the fastest back-to-back
		// pattern). Simply sleeping a fixed amount still looks machine-gunned.
		const sendDelay = computeSendDelay(config, { isToolTurn });
		debugLog(
			`pacing: waiting ${sendDelay}ms before send (toolTurn=${String(isToolTurn)})`,
		);
		await sleep(sendDelay);

		debugLog(
			`sending prompt (${prompt.length} chars, model=${modelType}, deepThinking=${String(deepThinking)})`,
		);
		// Fire-and-forget page script (mirrors the reference sendmessage.js) —
		// typing and the send click happen in setTimeout callbacks after this
		// evaluate returns, so we verify from the Node side below.
		await cdp.send(
			"Runtime.evaluate",
			{
				expression: buildSendScript(prompt, { modelType, deepThinking }),
				returnByValue: true,
				awaitPromise: true,
			},
			sessionId,
		);

		// The reference script types the message and the composer clears on
		// submit. Poll the DOM (without touching the page's React state) until
		// the prompt appears — that is the definitive "typed" signal, and it
		// turns the silent 120s hang into a clear error when it never happens.
		const readValue = `(document.querySelector('textarea[name="search"]')?.value ?? '')`;
		let sawTyped = false;
		const typedDeadline = Date.now() + 10_000;
		while (Date.now() < typedDeadline) {
			const r = await cdp.send(
				"Runtime.evaluate",
				{ expression: readValue, returnByValue: true },
				sessionId,
			);
			const value: string = r.result?.value ?? "";
			if (value === prompt) sawTyped = true;
			if (sawTyped && value === "") break; // typed, then submitted (cleared)
			await sleep(100);
		}
		if (!sawTyped) {
			// The poll can miss a fast send: the script types and submits between
			// two 100ms samples, so the textarea reads "" both times and we never
			// observe the typed state — even though the message IS in the chat.
			// Throwing here is what produced the "browser answered, terminal hung"
			// reports, so confirm against the page before giving up: if the prompt's
			// own tail is on screen, it was sent and the reply is on its way.
			const tail = prompt.trim().slice(-80).replace(/\s+/g, " ").trim();
			if (tail.length >= 16) {
				const onPage = await cdp.send(
					"Runtime.evaluate",
					{
						expression: `((document.body?.innerText ?? "").replace(/\\s+/g, " ").includes(${JSON.stringify(tail)}))`,
						returnByValue: true,
					},
					sessionId,
				);
				sawTyped = onPage.result?.value === true;
				if (sawTyped) {
					debugLog(
						"composer poll missed the send, but the prompt is on the page — treating as sent",
					);
				}
			}
		}
		if (!sawTyped) {
			throw new ComposerSendNotStartedError(
				"DeepSeek Web v2: the message was not typed into the composer within 10s. " +
					"If the Chrome window is showing a login, rate-limit or CAPTCHA page, resolve it and retry.",
			);
		}
		debugLog("prompt typed into the composer");

		const parsedResult = await withTimeout(
			sseDone,
			config.responseTimeoutMs,
			signal,
		);
		result.text = parsedResult.text;
		result.reasoning = parsedResult.reasoning;
		result.accumulatedTokenUsage = parsedResult.accumulatedTokenUsage;
		result.diagnostics = parsedResult.diagnostics;
		// Flag a throttled reply so the caller can back off / report it instead
		// of treating a shorter-context completion as a real context reset. Also
		// arm a one-shot recovery reload so the next turn forces a page refresh
		// to clear the temporarily-blocked composer ("Messages too frequent").
		if (isRateLimitText(result.text)) {
			result.rateLimited = true;
			requestThrottleRecoveryReload();
			logger?.log?.(
				'[deepseek-web-v2] DeepSeek throttled the request: "Messages too frequent" detected. ' +
					"Next message will reload the page to recover, and sending is paced. " +
					"Consider raising DEEPSEEK_WEB_V2_MIN/MAX_SEND_DELAY_MS.",
			);
		}
		debugLog(
			`completion done: ${result.text.length} chars text, ${result.reasoning.length} chars reasoning` +
				(result.accumulatedTokenUsage !== undefined
					? `, accumulated token usage=${result.accumulatedTokenUsage}`
					: ""),
		);
	} finally {
		cdp.off("Network.responseReceived", onResponseReceived);
		cdp.off("Network.loadingFinished", onLoadingFinished);
		await cdp.send("Network.disable", {}, sessionId).catch(() => {});
		sink.close();
	}

	result.rawBody = capturedRawBody;
	return result;
}

/**
 * The prompt never reached the composer, so nothing was submitted.
 *
 * Retrying this by editing the previous user message is wrong: that resends an
 * OLD turn on a new branch, which the page happily answers while our capture is
 * still waiting for a reply to a message we never sent — the "the browser keeps
 * sending, the terminal never gets a response" hang. The right recovery is to
 * reload the chat and send the same prompt again, which cannot duplicate
 * anything because nothing was submitted.
 */
export class ComposerSendNotStartedError extends Error {}

/**
 * Edit the last user message on the page by appending a period "." to the text.
 * Returns true if successful, false otherwise.
 */
export async function editLastUserMessage(
	cdp: CdpClient,
	sessionId: string,
	logger?: BasicLogger,
): Promise<boolean> {
	const script = `
        (async () => {
            // Find all user messages (exclude assistant/thinking blocks)
            const userMessages = Array.from(document.querySelectorAll('.ds-message')).filter(msg => {
                if (msg.textContent.includes('Thought for')) return false;
                if (msg.querySelector('.ds-markdown')) return false;
                return true;
            });

            if (userMessages.length === 0) return false;

            const targetMessage = userMessages[userMessages.length - 1];
            const oldText = targetMessage.textContent.trim();

            // Simulate hover to reveal edit button
            const rect = targetMessage.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;

            const hoverEvents = [
                new MouseEvent('mouseover', { bubbles: true, view: window, clientX: x, clientY: y }),
                new MouseEvent('mouseenter', { bubbles: false, view: window, clientX: x, clientY: y }),
                new MouseEvent('mousemove', { bubbles: true, view: window, clientX: x, clientY: y })
            ];

            let element = targetMessage;
            while (element) {
                hoverEvents.forEach(evt => element.dispatchEvent(evt));
                element = element.parentElement;
            }
            document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));

            // Wait for edit button (synchronous polling)
            const start = Date.now();
            let editBtn = null;
            while (Date.now() - start < 5000) {
                editBtn = targetMessage.querySelector('svg path[d*="M9.94076"]')?.closest('[role="button"]')
                    || targetMessage.querySelector('[class*="d4910adc"]');
                if (!editBtn) {
                    editBtn = document.querySelector('svg path[d*="M9.94076"]')?.closest('[role="button"]')
                        || document.querySelector('[class*="d4910adc"]');
                }
                if (!editBtn) {
                    const candidates = document.querySelectorAll('[role="button"], button');
                    for (const btn of candidates) {
                        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
                        const title = (btn.getAttribute('title') || '').toLowerCase();
                        if (label.includes('edit') || title.includes('edit')) {
                            editBtn = btn;
                            break;
                        }
                    }
                }
                if (editBtn) break;
                // Wait a bit before next check
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            if (!editBtn) return false;

            // Click edit
            editBtn.click();

            // Wait for edit textarea to appear
            return new Promise((resolve) => {
                setTimeout(() => {
                    // Find the visible textarea
                    const allTextareas = Array.from(document.querySelectorAll('textarea'));
                    let editTextarea = null;
                    for (const ta of allTextareas) {
                        const isVisible = ta.offsetWidth > 0 || ta.offsetHeight > 0 || ta.getClientRects().length > 0;
                        if (isVisible) {
                            editTextarea = ta;
                            break;
                        }
                    }
                    if (!editTextarea && allTextareas.length > 0) {
                        editTextarea = allTextareas[allTextareas.length - 1];
                    }
                    if (!editTextarea) {
                        resolve(false);
                        return;
                    }

                    // Append a period to the existing text
                    const newText = editTextarea.value + " .";
                    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
                    if (nativeSetter) {
                        nativeSetter.call(editTextarea, newText);
                    } else {
                        editTextarea.value = newText;
                    }
                    editTextarea.dispatchEvent(new Event('input', { bubbles: true }));
                    editTextarea.dispatchEvent(new Event('change', { bubbles: true }));

                    // Find and click submit button
                    const submitSelectors = [
                        '.ds-button--filled',
                        'button[type="submit"]',
                        '[role="button"][aria-label*="Send"]',
                        '[role="button"][aria-label*="Submit"]',
                        '[role="button"][aria-label*="Save"]',
                        '[role="button"][aria-label*="Update"]',
                        '.ds-button--primary'
                    ];
                    let submitBtn = null;
                    for (const sel of submitSelectors) {
                        const btn = document.querySelector(sel);
                        if (btn && !btn.classList.contains('ds-button--disabled')) {
                            submitBtn = btn;
                            break;
                        }
                    }
                    if (!submitBtn) {
                        // Fallback: look for visible button with text "Send", "Save", "Submit"
                        const allButtons = Array.from(document.querySelectorAll('[role="button"], button'));
                        const textLabels = ['send', 'save', 'submit', 'update'];
                        for (const btn of allButtons) {
                            const text = btn.textContent.trim().toLowerCase();
                            if (textLabels.some(label => text.includes(label)) && btn.offsetWidth > 0) {
                                submitBtn = btn;
                                break;
                            }
                        }
                    }
                    if (submitBtn) {
                        submitBtn.click();
                        resolve(true);
                    } else {
                        // Try Enter key
                        editTextarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                        resolve(true);
                    }
                }, 600);
            });
        })();
    `;

	try {
		const result = await cdp.send(
			"Runtime.evaluate",
			{
				expression: script,
				returnByValue: true,
				awaitPromise: true,
			},
			sessionId,
		);
		const success = result.result?.value === true;
		if (success) {
			logger?.debug?.(
				"[deepseek-web-v2] Edited last user message (appended ' .')",
			);
		} else {
			logger?.log("[deepseek-web-v2] Failed to edit last user message", {
				severity: "warn",
			});
		}
		return success;
	} catch (err) {
		logger?.log(`[deepseek-web-v2] Error editing last user message: ${err}`, {
			severity: "warn",
		});
		return false;
	}
}

export async function runCompletion(input: {
	modelId: string;
	prompt: string;
	chatKey: string;
	/** `true` when this turn requests tool calls → extra pacing delay. */
	isToolTurn: boolean;
	onText?: (text: string) => void;
	onReasoning?: (text: string) => void;
	signal?: AbortSignal;
	logger?: BasicLogger;
}): Promise<{
	text: string;
	reasoning: string;
	accumulatedTokenUsage?: number;
	rateLimited?: boolean;
	rawBody: string;
	diagnostics?: DeepSeekSseDiagnostics;
}> {
	const {
		modelId,
		prompt,
		chatKey,
		isToolTurn,
		onText,
		onReasoning,
		signal,
		logger,
	} = input;
	const config = resolveDeepSeekWebV2Config();
	const { modelType, deepThinking } = resolveV2ModelOptions(modelId);

	if (signal?.aborted) {
		throw new DOMException("Aborted", "AbortError");
	}

	const cdp = await connectBrowser(config);
	const { sessionId } = await ensureDeepSeekPage(cdp);

	// Persist chat continuity (mirror start_continue_chat.py): a CLI conversation
	// that already has a mapped DeepSeek web chat reopens that chat; a brand-new
	// CLI conversation opens a fresh DeepSeek composer.
	//
	// If the previous turn was throttled ("Messages too frequent"), the page may
	// be temporarily blocked — force a real reload this once (consume the
	// flag) so the blocked page clears and the composer works normally again,
	// even if the URL already matches the target chat.
	const existingDeepSeekSession = lookupChatSession(config.chatsFile, chatKey);
	const forceReload = consumeThrottleRecoveryReload();
	const chatTarget = existingDeepSeekSession
		? { sessionId: existingDeepSeekSession, fresh: false }
		: { fresh: true };
	await navigateDeepSeekChat(cdp, sessionId, chatTarget, logger, forceReload);

	await waitForComposerReady(cdp, sessionId, config, logger);
	if (existingDeepSeekSession) {
		await confirmChatLocation({
			cdp,
			cdpSessionId: sessionId,
			provider: "deepseek-web-v2",
			chatId: existingDeepSeekSession,
			chatUrl: `https://chat.deepseek.com/a/chat/s/${existingDeepSeekSession}`,
			waitReady: () => waitForComposerReady(cdp, sessionId, config, logger),
			logger,
		});
	}

	// Retry logic: if the first attempt fails (empty response or error), edit the last user message and retry.
	let attempt = 0;
	const maxAttempts = 2;
	let lastError: Error | null = null;
	// Throttle retries are counted separately from the empty-response attempts
	// above: waiting out a server-side cooldown is not a failed attempt, and
	// spending the retry budget on it would leave none for a real empty reply.
	let rateLimitRetries = 0;
	let result: Awaited<ReturnType<typeof streamCompletionFromPage>> | null =
		null;

	while (attempt < maxAttempts) {
		attempt++;
		try {
			result = await streamCompletionFromPage({
				cdp,
				sessionId,
				config,
				prompt,
				modelType,
				deepThinking,
				thinkingEnabled: deepThinking === true,
				isToolTurn,
				onText,
				onReasoning,
				signal,
				logger,
			});

			// "Messages too frequent" is a cooldown, not a bad request — the
			// same prompt works once the window passes. Wait it out, reload the
			// (temporarily blocked) page, and send again.
			const throttled =
				result.rateLimited === true ||
				(!result.text.trim() &&
					!result.reasoning.trim() &&
					result.diagnostics !== undefined &&
					isRateLimitDiagnostic(result.diagnostics));
			if (throttled && rateLimitRetries < config.rateLimitMaxRetries) {
				rateLimitRetries++;
				logger?.log(
					`[deepseek-web-v2] throttled ("Messages too frequent") — waiting ${Math.round(
						config.rateLimitRetryDelayMs / 1000,
					)}s, then resending (retry ${rateLimitRetries}/${config.rateLimitMaxRetries})`,
					{ severity: "warn" },
				);
				await waitWithAbort(config.rateLimitRetryDelayMs, signal);
				// The reload the throttle armed is ours to perform now, so clear
				// the flag rather than leaving it to fire again next turn.
				consumeThrottleRecoveryReload();
				await navigateDeepSeekChat(cdp, sessionId, chatTarget, logger, true);
				await waitForComposerReady(cdp, sessionId, config, logger);
				// Edit the throttled turn in place when possible so the chat does
				// not accumulate a duplicate of the same prompt.
				await editLastUserMessage(cdp, sessionId, logger);
				// A cooldown is not one of the two content attempts.
				attempt--;
				continue;
			}

			// Check if the response is empty (no text and no reasoning)
			if (!result.text && !result.reasoning) {
				if (attempt < maxAttempts) {
					logger?.log(
						"[deepseek-web-v2] Empty response detected, attempting retry...",
						{ severity: "warn" },
					);
					const edited = await editLastUserMessage(cdp, sessionId, logger);
					if (!edited) {
						logger?.log("[deepseek-web-v2] Failed to edit message for retry", {
							severity: "warn",
						});
						break;
					}
					await sleep(2000);
					continue;
				}
			}
			// Success
			break;
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			// The user pressed Escape. Retrying would edit the last message and
			// send it again — the browser keeps answering a turn the CLI already
			// gave up on, and the CLI stays stuck as "running" until that reply
			// lands. A cancelled turn is done; hand the abort up.
			if (isAbortError(lastError) || signal?.aborted) {
				throw lastError;
			}
			if (attempt < maxAttempts) {
				logger?.log(
					`[deepseek-web-v2] Error during completion (attempt ${attempt}/${maxAttempts}): ${lastError.message}`,
					{ severity: "warn" },
				);
				if (lastError instanceof ComposerSendNotStartedError) {
					// Nothing was submitted, so there is no message to edit — and
					// editing the previous one would answer an old turn on a new
					// branch while we wait for a reply that never comes. Reload the
					// chat (the usual cause is a page left in a blocked or
					// half-hydrated state) and send the same prompt again.
					logger?.log(
						"[deepseek-web-v2] the prompt never reached the composer — reloading the chat and resending",
						{ severity: "warn" },
					);
					await navigateDeepSeekChat(cdp, sessionId, chatTarget, logger, true);
					await waitForComposerReady(cdp, sessionId, config, logger);
					continue;
				}
				const edited = await editLastUserMessage(cdp, sessionId, logger);
				if (!edited) {
					logger?.log("[deepseek-web-v2] Failed to edit message for retry", {
						severity: "warn",
					});
					break;
				}
				await sleep(2000);
				continue;
			}
			throw lastError;
		}
	}

	if (!result) {
		throw new Error("Failed to get completion after retries");
	}

	// Both attempts came back silent. Returning the empty result hands the
	// runtime a message with no content parts, which it reports as the opaque
	// "Model returned empty response" — with the server's own stated reason
	// sitting unused in the stream diagnostics. Say it instead.
	if (!result.text.trim() && !result.reasoning.trim()) {
		if (result.diagnostics && isRateLimitDiagnostic(result.diagnostics)) {
			throw new Error(
				'DeepSeek throttled the request: "Messages too frequent. Try again later." ' +
					`Still throttled after ${rateLimitRetries} retr${
						rateLimitRetries === 1 ? "y" : "ies"
					} ${Math.round(config.rateLimitRetryDelayMs / 1000)}s apart. Raise ` +
					"DEEPSEEK_WEB_V2_MIN_SEND_DELAY_MS / DEEPSEEK_WEB_V2_MAX_SEND_DELAY_MS " +
					"to slow sending further.",
			);
		}
		throw new Error(
			result.diagnostics
				? describeEmptyDeepSeekStream(result.diagnostics)
				: "DeepSeek returned no content and the completion stream was never captured.",
		);
	}

	// After sending, the SPA routes to `/a/chat/s/<session_id>`; capture it so
	// the next turn (or a resume) can reopen this same DeepSeek chat.
	const pageUrl = await readPageUrl(cdp, sessionId);
	const deepSeekSession = parseSessionIdFromUrl(pageUrl);
	if (deepSeekSession) {
		recordChatSession(config.chatsFile, chatKey, deepSeekSession);
		if (config.debug) {
			logger?.debug(
				`[deepseek-web-v2] mapped CLI chat ${chatKey} -> DeepSeek session ${deepSeekSession}`,
			);
		}
	}

	return result;
}
