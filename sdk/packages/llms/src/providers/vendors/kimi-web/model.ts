/**
 * The provider itself: build the prompt, drive one turn, parse what comes back.
 *
 * This is where the parse ladder lives — the order in which a reply is offered
 * to each parser — and that order is the part of a vendor that genuinely
 * differs from every other vendor. Everything it calls is either shared
 * (`../tool-pipeline/`) or one of this folder's own modules.
 */

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
import { parseInvokeStyleToolCalls } from "../tool-pipeline/invoke-parser";
import { parseManagerBlocks } from "../tool-pipeline/manager-block";
import {
	parsePatchBlocks,
	unappliedPatchNotice,
} from "../tool-pipeline/patch-block";
import { stripPreviousUserBlock } from "../tool-pipeline/previous-user-dedupe";
import { validateToolCalls } from "../tool-pipeline/tool-dispatcher";
import type { ProviderFactoryResult } from "../types";
import { connectBrowser, waitForComposerReady } from "./browser";
import { sendAndCapture } from "./capture";
import {
	chatKeyFromPrompt,
	extractKimiSessionId,
	lastUserText,
	lookupKimiChatSession,
	recordKimiChatSession,
} from "./chat-registry";
import {
	consumeKimiThrottleRecoveryReload,
	Kimi_WEB_URL,
	resolveKimiWebV2Config,
	sleep,
} from "./config";
import { navigateKimiChat, readPageUrl } from "./navigation";

// ── Main provider ─────────────────────────────────────────────────────────────

export interface KimiCompletionResult {
	text: string;
	toolCalls: { name: string; arguments: Record<string, unknown> }[];
	usage: { inputTokens: number; outputTokens: number; totalTokens: number };
	/** Kimi's own subscription usage, when the page reported it this turn. */
	subscription?: KimiSubscriptionBalance;
}

interface KimiSubscriptionBalance {
	amountUsedRatio: number;
	usedPercent: number;
	expireTime: string;
}

/**
 * What the status bar reads off `providerMetadata["kimi-web"]`.
 *
 * Kimi meters a web session as a share of the subscription spent, which its
 * own UI shows as a percentage with an expiry date. That is the same shape
 * claude-web reports, so publish it the same way and the status bar renders
 * it with no extra case.
 */
function subscriptionProviderMetadata(
	subscription: KimiSubscriptionBalance | undefined,
) {
	if (!subscription || !Number.isFinite(subscription.usedPercent)) return {};
	const resetsAt = Number.isNaN(Date.parse(subscription.expireTime))
		? undefined
		: new Date(subscription.expireTime).toISOString();
	return {
		providerMetadata: {
			"kimi-web": {
				sessionPercent: Math.max(0, Math.min(subscription.usedPercent, 100)),
				...(resetsAt ? { sessionResetsAt: resetsAt } : {}),
			},
		},
	};
}

/**
 * Build the flat prompt sent to www.kimi.ai, mirroring deepseek-web-v2's
 * `buildPrompt`: the real web client keeps its own server-side conversation
 * state, so the system prompt is sent verbatim on the conversation's first
 * turn (via `buildLeanConversation`'s own first-turn passthrough) and dropped
 * on every follow-up turn in the SAME Kimi chat — re-added only when
 * `reInjectSystem` is true (a brand-new Kimi chat, e.g. right after a
 * compaction opens a fresh one).
 */
export function buildKimiPrompt(
	prompt: LanguageModelV2Prompt,
	reInjectSystem: boolean,
	preserveCompactionContext: boolean,
): string {
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
		toolResultLabel: "Tool result",
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

export function createKimiWebModel(
	modelId: string,
	logger?: BasicLogger,
): LanguageModelV2 {
	// Re-resolved on every turn, not captured once: `/profile` can switch the
	// active browser profile between turns, which changes the user-data-dir,
	// the debug port and the chat registry. A model built before the switch
	// would otherwise keep driving the old profile's Chrome.
	let runtimeConfig = resolveKimiWebV2Config();

	// Kimi only reports subscription usage on some turns. Hold the last
	// answer so the status bar keeps showing a number in between.
	let lastSubscription: KimiSubscriptionBalance | undefined;

	const debugLog = (msg: string) => {
		if (runtimeConfig.debug) logger?.debug(`[kimi-web] ${msg}`);
	};

	// Shared by doGenerate/doStream (mirrors deepseek-web-v2's doCompletion):
	// drives the CDP session, sends the prompt, captures + parses the SSE
	// body, and recovers `<tool>` calls the model emitted — one code path so
	// both entry points behave identically instead of doStream being a thin,
	// divergent wrapper around doGenerate.
	async function runCompletion(
		options: LanguageModelV2CallOptions,
	): Promise<KimiCompletionResult> {
		runtimeConfig = resolveKimiWebV2Config();
		debugLog("runCompletion called");

		// A reply the user pasted back with `/paste` after a network error ate
		// the real one. Short-circuit before touching the browser: the text is
		// already the model's answer, it just needs the same tool parsing a
		// captured reply gets. No retry loop — a paste is a fixed string, so
		// re-sending a correction into the chat would be meaningless here.
		const injected = consumePendingInjectedReply("kimi-web");
		if (injected) {
			debugLog(`Using pasted reply (${injected.length} chars)`);
			return buildCompletionFromText(injected, options);
		}

		// Cancelled while queued — do not open a browser for a dead turn.
		throwIfAborted(options.abortSignal);

		const cdp = await connectBrowser(runtimeConfig);

		const targets = await cdp.send("Target.getTargets");
		let pageTarget = targets.targetInfos?.find(
			(t: any) => t.type === "page" && t.url?.startsWith("https://www.kimi.ai"),
		);

		if (!pageTarget) {
			const result = await cdp.send("Target.createTarget", {
				url: Kimi_WEB_URL,
			});
			await sleep(2000);
			const newTargets = await cdp.send("Target.getTargets");
			pageTarget = newTargets.targetInfos?.find(
				(t: any) => t.targetId === result.targetId,
			);
			if (!pageTarget) {
				throw new Error("Failed to create Kimi page");
			}
		}

		const attachResult = await cdp.send("Target.attachToTarget", {
			targetId: pageTarget.targetId,
			flatten: true,
		});
		const cdpSessionId = attachResult.sessionId;

		// Chat continuity: this CLI conversation is keyed by its first user
		// message. A fresh key (no mapped Kimi chat yet) means this call opens
		// a brand-new web chat, e.g. right after a compaction where the
		// compaction summary becomes the first user message.
		// Which web chat does this call go to? Normally the hash of the
		// conversation's first user message; during compaction, the chat the
		// last ordinary turn used, because the standalone summarize request
		// would otherwise hash to an empty chat of its own. See
		// `tool-pipeline/chat-target.ts` for the full /compact hand-off.
		const chatKey = resolveChatKey("kimi-web", () =>
			chatKeyFromPrompt(options.prompt),
		);
		let existingKimiSession = lookupKimiChatSession(
			runtimeConfig.chatsFile,
			chatKey,
		);
		// Only a sticky `/findchat` binding holds a real web conversation id; a
		// hash-derived key never does. This used to test `chatKey.length !== 16`,
		// but `chatKeyFromPrompt` returns 24 characters, so EVERY new chat took
		// this branch: the hash was navigated to as though it were a conversation
		// id (a 404 page), and then recorded, so the same dead chat came back on
		// every later turn. Ask where the key came from instead of guessing from
		// its shape.
		if (!existingKimiSession && getBoundChatKey("kimi-web") === chatKey) {
			existingKimiSession = chatKey;
			recordKimiChatSession(runtimeConfig.chatsFile, chatKey, chatKey);
		}
		const isNewChat = existingKimiSession === undefined;

		const forceReload = consumeKimiThrottleRecoveryReload();
		await navigateKimiChat(
			cdp,
			cdpSessionId,
			existingKimiSession
				? { sessionId: existingKimiSession, fresh: false }
				: { fresh: true },
			logger,
			forceReload,
		);

		await waitForComposerReady(cdp, cdpSessionId, runtimeConfig, logger);
		if (existingKimiSession) {
			await confirmChatLocation({
				cdp,
				cdpSessionId,
				provider: "kimi-web",
				chatId: existingKimiSession,
				chatUrl: `https://www.kimi.ai/chat/${existingKimiSession}`,
				waitReady: () =>
					waitForComposerReady(cdp, cdpSessionId, runtimeConfig, logger),
				logger,
			});
		}

		// Re-inject the system prompt only when this turn opens a brand-new
		// Kimi chat — every other turn in the SAME chat sends no system
		// prompt at all, since the web client already has it server-side.
		// (Unlike deepseek-web-v2 this has no token-threshold re-injection:
		// Kimi's SSE responses don't expose an equivalent cumulative
		// accumulated-context figure to gate that on.)
		let promptText = buildKimiPrompt(options.prompt, isNewChat, isNewChat);

		// The web chat is stateful: everything the user typed is already in it.
		// The current instruction still goes out — `messagesToPrompt` labels it
		// `User:` (or `Note:` on an iteration turn) — but every OLDER
		// `My last message:` block is dropped, so an instruction is sent
		// once and never re-sent on each round of a tool loop. Anything the user
		// wants restated goes through `/note`.
		promptText = stripPreviousUserBlock(promptText);

		const thinkingMode =
			(options as any).thinking === true
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
		// commentary on what the model typed — Kimi never sees it just because
		// we computed it locally, since it isn't part of its server-side chat
		// history. Resend it as a real follow-up message in the SAME chat so
		// the model actually sees the rejection and can self-correct, capped
		// so a persistently broken model can't loop forever.
		const MAX_TOOL_REJECTION_RETRIES = 2;
		const toolNames = functionTools.map((t) => t.name);
		let sendPrompt = promptText;
		let result: Awaited<ReturnType<typeof sendAndCapture>> | undefined;
		let finalText = "";
		let finalToolCalls: KimiCompletionResult["toolCalls"] = [];

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
						`[kimi-web] all tool calls rejected, resending correction into chat (attempt ${attempt + 1}/${MAX_TOOL_REJECTION_RETRIES})`,
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

			// Anthropic-style `<invoke>` bodies, which every big model reaches for
			// under load. See tool-pipeline/invoke-parser.ts.
			const invoked = parseInvokeStyleToolCalls(result.text, toolNames);
			if (invoked.toolCalls.length > 0) {
				const { tools: validatedInvoked, retryPrompt } = validateToolCalls(
					invoked.toolCalls,
				);
				if (
					validatedInvoked.length === 0 &&
					retryPrompt &&
					attempt < MAX_TOOL_REJECTION_RETRIES
				) {
					sendPrompt = retryPrompt;
					continue;
				}
				finalText = retryPrompt
					? `${invoked.cleanedContent}\n\n${retryPrompt}`.trim()
					: invoked.cleanedContent;
				finalToolCalls = validatedInvoked;
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
		// turn (or a resume) can reopen this same Kimi chat.
		const pageUrl = await readPageUrl(cdp, cdpSessionId);
		const KimiSession = extractKimiSessionId(pageUrl);
		if (KimiSession) {
			recordKimiChatSession(runtimeConfig.chatsFile, chatKey, KimiSession);
		}

		// Log raw and parsed response per conversation
		try {
			logConversationTurn("kimi-web", chatKey, result.rawBody, {
				text: finalText,
				toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
				usage: result.usage,
				finishReason: result.finishReason,
			});
		} catch (logErr) {
			// Ignore logging failures
		}

		if (result.subscriptionBalance) {
			lastSubscription = result.subscriptionBalance;
		}
		return {
			text: finalText,
			toolCalls: finalToolCalls,
			usage: result.usage,
			...(lastSubscription ? { subscription: lastSubscription } : {}),
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
	): KimiCompletionResult {
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

		// Anthropic-style `<invoke>` bodies, which every big model reaches for
		// under load. See tool-pipeline/invoke-parser.ts.
		const invoked = parseInvokeStyleToolCalls(text, toolNames);
		if (invoked.toolCalls.length > 0) {
			const { tools: validatedInvoked, retryPrompt } = validateToolCalls(
				invoked.toolCalls,
			);
			return {
				text: retryPrompt
					? `${invoked.cleanedContent}\n\n${retryPrompt}`.trim()
					: invoked.cleanedContent,
				toolCalls: validatedInvoked,
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
		toolCalls: KimiCompletionResult["toolCalls"],
	): LanguageModelV2FinishReason {
		return toolCalls.length > 0 ? "tool-calls" : text ? "stop" : "unknown";
	}

	const provider: LanguageModelV2 = {
		specificationVersion: "v2",
		provider: "kimi-web",
		modelId,
		supportedUrls: {} as Record<string, RegExp[]>,

		async doGenerate(options: LanguageModelV2CallOptions) {
			try {
				const { text, toolCalls, usage, subscription } = await withBrowserLock(
					"kimi-web",
					options.abortSignal,
					() => runCompletion(options),
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
					...subscriptionProviderMetadata(subscription),
					warnings: [],
				};
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));
				logger?.error?.(`[kimi-web] doGenerate error: ${err.message}`);
				throw err;
			}
		},

		async doStream(options: LanguageModelV2CallOptions) {
			const { text, toolCalls, usage, subscription } = await withBrowserLock(
				"kimi-web",
				options.abortSignal,
				() => runCompletion(options),
			);
			const id = `kimi-web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
				...subscriptionProviderMetadata(subscription),
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

export function createKimiWebProvider(
	_config: GatewayResolvedProviderConfig,
	context?: GatewayProviderContext,
): ProviderFactoryResult {
	const logger = context?.logger;
	return {
		model: (modelId: string) => createKimiWebModel(modelId, logger),
	};
}

export function createKimiWebProviderFactory() {
	return { id: "kimi-web", create: createKimiWebProvider };
}

// ── Module factory (used by ai-sdk.ts) ────────────────────────────────────────

export function createKimiWebProviderModule(
	config: GatewayResolvedProviderConfig,
	context?: GatewayProviderContext,
): ProviderFactoryResult {
	return createKimiWebProvider(config, context);
}
