import type {
	LanguageModelV2,
	LanguageModelV2CallOptions,
	LanguageModelV2Content,
	LanguageModelV2FinishReason,
	LanguageModelV2FunctionTool,
	LanguageModelV2Prompt,
	LanguageModelV2StreamPart,
} from "@ai-sdk/provider";
import type {
	BasicLogger,
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
} from "@cline/shared";
import { extractRawWebMessage } from "@cline/shared";

import {
	messagesToPrompt,
	parseDeepSeekToolCalls,
	parseLooseDeepSeekToolCalls,
} from "../deepseek-web";
import {
	buildLeanConversation,
	currentUserLabel,
	parseFallbackToolUses,
} from "../deepseek-web-v2";
import { throwIfAborted } from "../tool-pipeline/abort";
import { withBrowserLock } from "../tool-pipeline/browser-lock";
import { getBoundChatKey, resolveChatKey } from "../tool-pipeline/chat-target";
import { confirmChatLocation } from "../tool-pipeline/confirm-chat-location";
import { logConversationTurn } from "../tool-pipeline/conversation-logger";
import { estimateWebUsage } from "../tool-pipeline/estimate-usage";
import { consumePendingInjectedReply } from "../tool-pipeline/injected-reply";
import { parseManagerBlocks } from "../tool-pipeline/manager-block";
import {
	parsePatchBlocks,
	unappliedPatchNotice,
} from "../tool-pipeline/patch-block";
import { stripPreviousUserBlock } from "../tool-pipeline/previous-user-dedupe";
import { validateToolCalls } from "../tool-pipeline/tool-dispatcher";
import type { ProviderFactoryResult } from "../types";
import { connectBrowser } from "./browser";
import { sendAndCapture } from "./capture";
import {
	chatKeyFromPrompt,
	copilotChatUrl,
	extractCopilotSessionId,
	lookupCopilotChatSession,
	recordCopilotChatSession,
} from "./chat-registry";
import {
	COPILOT_PAGE_RE,
	COPILOT_WEB_URL,
	type CopilotRateLimitInfo,
	consumeCopilotThrottleRecoveryReload,
	resolveCopilotWebV2Config,
	sleep,
} from "./config";
import {
	navigateCopilotChat,
	readPageUrl,
	waitForComposerReady,
} from "./navigation";
import {
	type CopilotDayUsage,
	copilotLimitActive,
	readCopilotUsage,
	recordCopilotTurn,
	usageFileFor,
} from "./usage";

// ── Main provider ──────────────────────────────────────────────────────────────

interface CopilotCompletionResult {
	text: string;
	toolCalls: { name: string; arguments: Record<string, unknown> }[];
	usage: { inputTokens: number; outputTokens: number; totalTokens: number };
	/** Copilot's own query allowance, when the page reported one this turn. */
	rateLimit?: CopilotRateLimitInfo;
	/** Today's messages and tokens on this profile, and the daily limit. */
	day?: CopilotDayUsage;
}

/**
 * What the status bar reads off `providerMetadata["copilot-web"]`.
 *
 * Copilot meters a chat in user messages (600 per chat on the free plan),
 * reported in the `throttling` field of the chat hub's updates. Shown the way
 * chatgpt-web's message count is shown. `lastRateLimit` holds the last
 * answer so the readout does not flip to "-" between turns.
 */
function rateLimitProviderMetadata(
	rateLimit: CopilotRateLimitInfo | undefined,
	day?: CopilotDayUsage,
) {
	const max = Number(rateLimit?.maxNumUserMessagesInConversation);
	const used = Number(rateLimit?.numUserMessagesInConversation);
	const meta: Record<string, number | boolean | string> = {};
	if (Number.isFinite(max) && max > 0 && Number.isFinite(used)) {
		meta.messagesRemaining = Math.max(0, Math.floor(max - used));
		meta.messagesTotal = Math.floor(max);
	}
	// The daily allowance is the one that actually stops a run; Copilot only
	// says so once it is spent, so the day's own count goes with it.
	if (day) {
		meta.messagesToday = day.messages;
		meta.tokensToday = day.tokensIn + day.tokensOut;
		meta.limitReached = copilotLimitActive(day);
		if (day.limitResetsAt && meta.limitReached) {
			meta.limitResetsAt = day.limitResetsAt;
		}
	}
	if (Object.keys(meta).length === 0) return {};
	return { providerMetadata: { "copilot-web": meta } };
}

/** The text of the last user message in the prompt (for dedup + fallback filename hints). */
function lastUserText(prompt: LanguageModelV2Prompt): string {
	for (let i = prompt.length - 1; i >= 0; i--) {
		const message = prompt[i];
		if (message.role !== "user") continue;
		const content = Array.isArray(message.content)
			? message.content
					.map((block) => ("text" in block ? block.text : ""))
					.join("\n")
			: message.content;
		return typeof content === "string" ? content.trim() : "";
	}
	return "";
}

/**
 * Build the flat prompt sent to copilot.com, mirroring deepseek-web-v2's
 * `buildPrompt`: the real web client keeps its own server-side conversation
 * state, so the system prompt is sent verbatim on the conversation's first
 * turn (via `buildLeanConversation`'s own first-turn passthrough) and dropped
 * on every follow-up turn in the SAME Copilot chat — re-added only when
 * `reInjectSystem` is true (a brand-new Copilot chat, e.g. right after a
 * compaction opens a fresh one).
 */
function buildCopilotPrompt(
	prompt: LanguageModelV2Prompt,
	reInjectSystem: boolean,
	preserveCompactionContext: boolean,
): string {
	// `/runbatch`: a marked message goes to the chat exactly as written.
	const rawMessage = extractRawWebMessage(prompt);
	if (rawMessage !== undefined) return rawMessage;
	// The system prompt arrives already chosen: `buildClineSystemPrompt`
	// picks this provider's `default` / `worker` / `manager` wording from
	// its prompts file. This used to call `applySimpleWebSystemPrompt`,
	// which swapped the prompt here by testing it for a marker heading
	// that no web provider is ever sent — so it never once fired.
	const effectivePrompt = prompt;

	const conversation = buildLeanConversation(
		effectivePrompt,
		preserveCompactionContext,
	);
	const systemMessage = effectivePrompt.find((m) => m.role === "system");
	const alreadyHasSystem = conversation.some((m) => m.role === "system");
	const promptOptions = {
		historyWindow: 10,
		userLabel: "My last message",
		lastUserLabel: currentUserLabel(conversation),
	};
	if (
		reInjectSystem &&
		systemMessage &&
		!alreadyHasSystem &&
		conversation.length > 0
	) {
		return messagesToPrompt([systemMessage, ...conversation], promptOptions);
	}
	return messagesToPrompt(conversation, promptOptions);
}

function createCopilotWebModel(
	modelId: string,
	logger?: BasicLogger,
): LanguageModelV2 {
	// Re-resolved on every turn, not captured once: `/profile` can switch the
	// active browser profile between turns, which changes the user-data-dir,
	// the debug port and the chat registry. A model built before the switch
	// would otherwise keep driving the old profile's Chrome.
	let runtimeConfig = resolveCopilotWebV2Config();

	// Copilot reports its query allowance only on some turns. Hold the last
	// answer so the status bar keeps showing a number in between.
	let lastRateLimit: CopilotRateLimitInfo | undefined;
	// Today's count on the active profile, as of this turn (see usage.ts).
	let lastDay: CopilotDayUsage | undefined;

	const debugLog = (msg: string) => {
		if (runtimeConfig.debug) logger?.debug(`[copilot-web] ${msg}`);
	};

	// Shared by doGenerate/doStream (mirrors deepseek-web-v2's doCompletion):
	// drives the CDP session, sends the prompt, captures + parses the SSE
	// body, and recovers `<tool>` calls the model emitted — one code path so
	// both entry points behave identically instead of doStream being a thin,
	// divergent wrapper around doGenerate.
	async function runCompletion(
		options: LanguageModelV2CallOptions,
	): Promise<CopilotCompletionResult> {
		runtimeConfig = resolveCopilotWebV2Config();
		lastDay = undefined;
		debugLog("runCompletion called");

		// A reply the user pasted back with `/paste` after a network error ate
		// the real one. Short-circuit before touching the browser: the text is
		// already the model's answer, it just needs the same tool parsing a
		// captured reply gets. No retry loop — a paste is a fixed string, so
		// re-sending a correction into the chat would be meaningless here.
		const injected = consumePendingInjectedReply("copilot-web");
		if (injected) {
			debugLog(`Using pasted reply (${injected.length} chars)`);
			return buildCompletionFromText(injected, options);
		}

		// Cancelled while queued — do not open a browser for a dead turn.
		throwIfAborted(options.abortSignal);

		const cdp = await connectBrowser(runtimeConfig);

		const targets = await cdp.send("Target.getTargets");
		let pageTarget = targets.targetInfos?.find(
			(t: { type: string; url?: string }) =>
				t.type === "page" && COPILOT_PAGE_RE.test(t.url ?? ""),
		);

		if (!pageTarget) {
			const result = await cdp.send("Target.createTarget", {
				url: COPILOT_WEB_URL,
			});
			await sleep(2000);
			const newTargets = await cdp.send("Target.getTargets");
			pageTarget = newTargets.targetInfos?.find(
				(t: { targetId: string }) => t.targetId === result.targetId,
			);
			if (!pageTarget) {
				throw new Error("Failed to create Copilot page");
			}
		}

		const attachResult = await cdp.send("Target.attachToTarget", {
			targetId: pageTarget.targetId,
			flatten: true,
		});
		const cdpSessionId = attachResult.sessionId;

		// Chat continuity: this CLI conversation is keyed by its first user
		// message. A fresh key (no mapped Copilot chat yet) means this call opens
		// a brand-new web chat, e.g. right after a compaction where the
		// compaction summary becomes the first user message.
		// Which web chat does this call go to? Normally the hash of the
		// conversation's first user message; during compaction, the chat the
		// last ordinary turn used, because the standalone summarize request
		// would otherwise hash to an empty chat of its own. See
		// `tool-pipeline/chat-target.ts` for the full /compact hand-off.
		const chatKey = resolveChatKey("copilot-web", () =>
			chatKeyFromPrompt(options.prompt),
		);
		let existingCopilotSession = lookupCopilotChatSession(
			runtimeConfig.chatsFile,
			chatKey,
		);

		// If not found in the registry, try to recover the session ID to avoid
		// unnecessary page reloads.
		if (!existingCopilotSession) {
			// 1. Check for a sticky `/findchat` binding (holds the real session ID)
			const boundSessionId = getBoundChatKey("copilot-web");
			if (boundSessionId) {
				existingCopilotSession = boundSessionId;
				recordCopilotChatSession(
					runtimeConfig.chatsFile,
					chatKey,
					boundSessionId,
				);
			} else {
				// 2. Fallback: check the current page URL for a session ID.
				// This prevents reloads if the registry write was missed/delayed,
				// or if the user manually navigated to a chat.
				const currentUrl = await readPageUrl(cdp, cdpSessionId);
				const currentSessionId = extractCopilotSessionId(currentUrl);
				if (currentSessionId) {
					existingCopilotSession = currentSessionId;
					recordCopilotChatSession(
						runtimeConfig.chatsFile,
						chatKey,
						currentSessionId,
					);
				}
			}
		}

		const isNewChat = existingCopilotSession === undefined;

		const forceReload = consumeCopilotThrottleRecoveryReload();
		await navigateCopilotChat(
			cdp,
			cdpSessionId,
			existingCopilotSession
				? { sessionId: existingCopilotSession, fresh: false }
				: { fresh: true },
			logger,
			forceReload,
		);

		await waitForComposerReady(cdp, cdpSessionId, runtimeConfig, logger);
		if (existingCopilotSession) {
			await confirmChatLocation({
				cdp,
				cdpSessionId,
				provider: "copilot-web",
				chatId: existingCopilotSession,
				chatUrl: copilotChatUrl(existingCopilotSession),
				waitReady: () =>
					waitForComposerReady(cdp, cdpSessionId, runtimeConfig, logger),
				logger,
			});
		}

		// Re-inject the system prompt only when this turn opens a brand-new
		// Copilot chat — every other turn in the SAME chat sends no system
		// prompt at all, since the web client already has it server-side.
		// (Unlike deepseek-web-v2 this has no token-threshold re-injection:
		// Copilot's SSE responses don't expose an equivalent cumulative
		// accumulated-context figure to gate that on.)
		let promptText = buildCopilotPrompt(options.prompt, isNewChat, isNewChat);

		// The web chat is stateful: everything the user typed is already in it.
		// The current instruction still goes out — `messagesToPrompt` labels it
		// `User:` (or `Note:` on an iteration turn) — but every OLDER
		// `My last message:` block is dropped, so an instruction is sent
		// once and never re-sent on each round of a tool loop. Anything the user
		// wants restated goes through `/note`.
		// A fresh chat (e.g. after compaction) never saw it, so keep it there.
		if (!isNewChat) promptText = stripPreviousUserBlock(promptText);

		const thinkingMode =
			(options as Record<string, unknown>).thinking === true
				? "thinking"
				: modelId.includes("thinking") || modelId.includes("think")
					? "thinking"
					: "auto";
		const modelName = modelId;
		const functionTools = (options.tools ?? []).filter(
			(tool): tool is LanguageModelV2FunctionTool => tool.type === "function",
		);

		debugLog(
			`Sending prompt (${promptText.length} chars) with model=${modelName}, thinking=${thinkingMode}`,
		);

		// Bounded retry: when EVERY tool call in a reply gets rejected (e.g.
		// invalid Python in an `editor` call), the rejection note is OUR
		// commentary on what the model typed — Copilot never sees it just because
		// we computed it locally, since it isn't part of its server-side chat
		// history. Resend it as a real follow-up message in the SAME chat so
		// the model actually sees the rejection and can self-correct, capped
		// so a persistently broken model can't loop forever.
		const MAX_TOOL_REJECTION_RETRIES = 2;
		const toolNames = functionTools.map((t) => t.name);
		let sendPrompt = promptText;
		let result: Awaited<ReturnType<typeof sendAndCapture>> | undefined;
		let finalText = "";
		let finalToolCalls: CopilotCompletionResult["toolCalls"] = [];

		for (let attempt = 0; ; attempt++) {
			result = await sendAndCapture(
				cdp,
				cdpSessionId,
				sendPrompt,
				runtimeConfig,
				logger,
				{ model: modelName, thinkingMode: thinkingMode },
				functionTools.length > 0,
				options.abortSignal,
			);

			debugLog(`Received response (${result.text.length} chars)`);
			if (result.text) {
				lastDay = recordCopilotTurn(usageFileFor(runtimeConfig.chatsFile), {
					tokensIn: result.usage.inputTokens,
					tokensOut: result.usage.outputTokens,
					replyText: result.text,
				});
			}

			if (functionTools.length === 0) {
				finalText = result.text;
				finalToolCalls = [];
				break;
			}

			// `<manager>` blocks come first, and only when the session actually has
			// the team tool to dispatch them with. A lead on a web provider is
			// prompted to write delegations as prose rather than tool calls — see
			// `tool-pipeline/manager-block.ts` for why that framing is what keeps
			// it out of tool machinery it cannot use.
			if (toolNames.includes("team_run_task")) {
				const manager = parseManagerBlocks(result.text, {
					// Only when the session actually has the shell tool to run it with.
					allowCommands: toolNames.includes("run_commands"),
					toolNames,
				});
				if (manager.delegations.length > 0) {
					finalText = manager.cleanedContent;
					finalToolCalls = manager.delegations.map((delegation) => ({
						name: delegation.name,
						arguments: delegation.arguments as Record<string, unknown>,
					}));
					break;
				}
				if (manager.problems.length > 0) {
					// Malformed blocks go back into the same chat as a correction, the
					// same way a rejected tool call does.
					if (attempt < MAX_TOOL_REJECTION_RETRIES) {
						sendPrompt = manager.problems.join("\n");
						continue;
					}
					finalText =
						`${manager.cleanedContent}\n\n${manager.problems.join("\n")}`.trim();
					finalToolCalls = [];
					break;
				}
			}

			const { cleanedContent, toolCalls } = parseDeepSeekToolCalls(
				result.text,
				toolNames,
			);
			const looseCalls =
				toolCalls.length === 0
					? parseLooseDeepSeekToolCalls(result.text, toolNames)
					: toolCalls;
			if (looseCalls.length > 0) {
				const { tools: validatedCalls, retryPrompt } =
					validateToolCalls(looseCalls);
				if (
					validatedCalls.length === 0 &&
					retryPrompt &&
					attempt < MAX_TOOL_REJECTION_RETRIES
				) {
					logger?.log(
						`[copilot-web] all tool calls rejected, resending correction into chat (attempt ${attempt + 1}/${MAX_TOOL_REJECTION_RETRIES})`,
						{ severity: "warn" },
					);
					sendPrompt = retryPrompt;
					continue;
				}
				finalText = retryPrompt
					? `${cleanedContent}\n\n${retryPrompt}`.trim()
					: cleanedContent;
				finalToolCalls = validatedCalls;
				break;
			}

			// A bare `*** Begin Patch` block is `apply_patch` written as text, which
			// is the only way to send a patch body through a chat box — and exactly
			// what SIMPLE_WEB_SYSTEM_PROMPT asks this provider for. It must run
			// BEFORE the fallback below, which reads any code fence as a file write.
			// Gated on the session actually having the tool, so a provider still on
			// `editor` is untouched. See tool-pipeline/patch-block.ts.
			const patched = parsePatchBlocks(cleanedContent, toolNames);
			const patchNotice = unappliedPatchNotice(cleanedContent, toolNames);
			if (patchNotice) {
				if (attempt < MAX_TOOL_REJECTION_RETRIES) {
					sendPrompt = patchNotice;
					continue;
				}
				finalText = `${cleanedContent}

${patchNotice}`.trim();
				finalToolCalls = [];
				break;
			}
			if (patched.toolCalls.length > 0) {
				finalText = patched.cleanedContent;
				finalToolCalls = patched.toolCalls;
				break;
			}

			// The web model often ignores the `<tool>` contract and answers with
			// plain text (a plan, code fences, install commands). Convert the
			// visible structure of the reply into real tool calls so the agent
			// actually executes them, same as deepseek-web-v2's fallback.
			const fallback = parseFallbackToolUses(
				cleanedContent,
				lastUserText(options.prompt),
				toolNames,
			);
			finalText = fallback.cleanedText;
			finalToolCalls = fallback.toolUses;
			break;
		}

		// After sending, the SPA routes to `/c/<id>`; capture it so the next
		// turn (or a resume) can reopen this same Copilot chat.
		const pageUrl = await readPageUrl(cdp, cdpSessionId);
		const copilotSession = extractCopilotSessionId(pageUrl);
		if (copilotSession) {
			recordCopilotChatSession(
				runtimeConfig.chatsFile,
				chatKey,
				copilotSession,
			);
		}

		// Log raw and parsed response per conversation
		try {
			logConversationTurn("copilot-web", chatKey, result.rawBody, {
				text: finalText,
				toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
				usage: result.usage,
				finishReason: result.finishReason,
			});
		} catch (_logErr) {
			// Ignore logging failures
		}

		if (result.rateLimit) {
			lastRateLimit = result.rateLimit;
		}
		return {
			text: finalText,
			toolCalls: finalToolCalls,
			usage: result.usage,
			...(lastRateLimit ? { rateLimit: lastRateLimit } : {}),
			day: lastDay ?? readCopilotUsage(usageFileFor(runtimeConfig.chatsFile)),
		};
	}

	/**
	 * Turn a raw reply body into a completion result, running the same tool
	 * recovery ladder a live capture goes through: strict `<tool>` blocks,
	 * then loose ones, then the plain-prose fallback.
	 */
	function buildCompletionFromText(
		text: string,
		options: LanguageModelV2CallOptions,
	): CopilotCompletionResult {
		// Replaying a captured body: there is no prompt to measure here, so
		// count the reply alone rather than reporting a turn as free.
		const usage = estimateWebUsage("", text);
		const toolNames = (options.tools ?? [])
			.filter(
				(tool): tool is LanguageModelV2FunctionTool => tool.type === "function",
			)
			.map((tool) => tool.name);
		if (toolNames.length === 0) {
			return { text, toolCalls: [], usage };
		}

		const { cleanedContent, toolCalls } = parseDeepSeekToolCalls(
			text,
			toolNames,
		);
		const looseCalls =
			toolCalls.length === 0
				? parseLooseDeepSeekToolCalls(text, toolNames)
				: toolCalls;
		if (looseCalls.length > 0) {
			const { tools: validatedCalls, retryPrompt } =
				validateToolCalls(looseCalls);
			return {
				text: retryPrompt
					? `${cleanedContent}\n\n${retryPrompt}`.trim()
					: cleanedContent,
				toolCalls: validatedCalls,
				usage,
			};
		}

		// A bare `*** Begin Patch` block is `apply_patch` written as text, which
		// is the only way to send a patch body through a chat box — and exactly
		// what SIMPLE_WEB_SYSTEM_PROMPT asks this provider for. It must run
		// BEFORE the fallback below, which reads any code fence as a file write.
		// Gated on the session actually having the tool, so a provider still on
		// `editor` is untouched. See tool-pipeline/patch-block.ts.
		const patched = parsePatchBlocks(cleanedContent, toolNames);
		const patchNotice = unappliedPatchNotice(cleanedContent, toolNames);
		if (patchNotice) {
			return {
				text: `${cleanedContent}

${patchNotice}`.trim(),
				toolCalls: [],
				usage,
			};
		}
		if (patched.toolCalls.length > 0) {
			return {
				text: patched.cleanedContent,
				toolCalls: patched.toolCalls,
				usage,
			};
		}

		const fallback = parseFallbackToolUses(
			cleanedContent,
			lastUserText(options.prompt),
			toolNames,
		);
		return { text: fallback.cleanedText, toolCalls: fallback.toolUses, usage };
	}

	function finishReasonFor(
		text: string,
		toolCalls: CopilotCompletionResult["toolCalls"],
	): LanguageModelV2FinishReason {
		return toolCalls.length > 0 ? "tool-calls" : text ? "stop" : "unknown";
	}

	const provider: LanguageModelV2 = {
		specificationVersion: "v2",
		provider: "copilot-web",
		modelId,
		supportedUrls: {} as Record<string, RegExp[]>,

		async doGenerate(options: LanguageModelV2CallOptions) {
			try {
				const { text, toolCalls, usage, rateLimit, day } =
					await withBrowserLock("copilot-web", options.abortSignal, () =>
						runCompletion(options),
					);

				const content: LanguageModelV2Content[] = [];
				if (text) content.push({ type: "text", text });
				for (let i = 0; i < toolCalls.length; i++) {
					content.push({
						type: "tool-call",
						toolCallId: `call-${Date.now()}-${i}`,
						toolName: toolCalls[i].name,
						input: JSON.stringify(toolCalls[i].arguments),
					});
				}

				return {
					content,
					finishReason: finishReasonFor(text, toolCalls),
					usage,
					...rateLimitProviderMetadata(rateLimit, day),
					warnings: [],
				};
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));
				logger?.error?.(`[copilot-web] doGenerate error: ${err.message}`);
				throw err;
			}
		},

		async doStream(options: LanguageModelV2CallOptions) {
			const { text, toolCalls, usage, rateLimit, day } = await withBrowserLock(
				"copilot-web",
				options.abortSignal,
				() => runCompletion(options),
			);
			const id = `copilot-web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

			const parts: LanguageModelV2StreamPart[] = [
				{ type: "stream-start", warnings: [] },
				{ type: "response-metadata", id },
			];
			if (text) {
				parts.push({ type: "text-start", id });
				parts.push({ type: "text-delta", id, delta: text });
				parts.push({ type: "text-end", id });
			}
			for (let i = 0; i < toolCalls.length; i++) {
				const input = JSON.stringify(toolCalls[i].arguments);
				parts.push({
					type: "tool-input-start",
					id,
					toolName: toolCalls[i].name,
				});
				parts.push({ type: "tool-input-delta", id, delta: input });
				parts.push({ type: "tool-input-end", id });
				parts.push({
					type: "tool-call",
					toolCallId: `call-${Date.now()}-${i}`,
					toolName: toolCalls[i].name,
					input,
				});
			}
			parts.push({
				type: "finish",
				finishReason: finishReasonFor(text, toolCalls),
				usage,
				...rateLimitProviderMetadata(rateLimit, day),
			});

			const stream = new ReadableStream<LanguageModelV2StreamPart>({
				start(controller) {
					for (const part of parts) controller.enqueue(part);
					controller.close();
				},
			});
			return { stream, usage };
		},
	};

	return provider;
}

// ── Provider factory ──────────────────────────────────────────────────────────

export function createCopilotWebProvider(
	_config: GatewayResolvedProviderConfig,
	context?: GatewayProviderContext,
): ProviderFactoryResult {
	const logger = context?.logger;
	return {
		model: (modelId: string) => createCopilotWebModel(modelId, logger),
	};
}

export function createCopilotWebProviderFactory() {
	return { id: "copilot-web", create: createCopilotWebProvider };
}

// ── Module factory (used by ai-sdk.ts) ────────────────────────────────────────

export function createCopilotWebProviderModule(
	config: GatewayResolvedProviderConfig,
	context?: GatewayProviderContext,
): ProviderFactoryResult {
	return createCopilotWebProvider(config, context);
}
