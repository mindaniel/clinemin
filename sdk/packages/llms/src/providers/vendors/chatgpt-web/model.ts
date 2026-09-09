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
import { resolveChatKey } from "../tool-pipeline/chat-target";
import { logConversationTurn } from "../tool-pipeline/conversation-logger";
import { consumePendingInjectedReply } from "../tool-pipeline/injected-reply";
import { parseInvokeStyleToolCalls } from "../tool-pipeline/invoke-parser";
import { parseManagerBlocks } from "../tool-pipeline/manager-block";
import {
	parsePatchBlocks,
	unappliedPatchNotice,
} from "../tool-pipeline/patch-block";
import { validateToolCalls } from "../tool-pipeline/tool-dispatcher";
import type { ProviderFactoryResult } from "../types";
import { connectBrowser } from "./browser";
import { sendAndCapture, waitForComposerReady } from "./capture";
import {
	chatKeyFromPrompt,
	extractChatGPTSessionId,
	lookupChatGPTChatSession,
	recordChatGPTChatSession,
} from "./chat-registry";
import {
	CHATGPT_WEB_URL,
	consumeChatGPTThrottleRecoveryReload,
	resolveChatGPTWebV2Config,
} from "./config";
import { navigateChatGPTChat, readPageUrl } from "./navigation";
import type { ChatGPTWebCallOptions, TargetInfo } from "./types";

// ── Main provider ─────────────────────────────────────────────────────────────

export interface ChatGPTCompletionResult {
	text: string;
	toolCalls: { name: string; arguments: Record<string, unknown> }[];
	usage: { inputTokens: number; outputTokens: number; totalTokens: number };
	/**
	 * Set when every tool call in the reply was rejected (e.g. invalid Python
	 * in an `editor` call). It is OUR commentary on what the model typed, so
	 * the model never sees it unless we send it back into the chat — the web
	 * client's server-side history has no idea we rejected anything.
	 */
	retryPrompt?: string;
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
 * Build the flat prompt sent to chatgpt.com, mirroring deepseek-web-v2's
 * `buildPrompt`: the real web client keeps its own server-side conversation
 * state, so the system prompt is sent verbatim on the conversation's first
 * turn (via `buildLeanConversation`'s own first-turn passthrough) and dropped
 * on every follow-up turn in the SAME ChatGPT chat — re-added only when
 * `reInjectSystem` is true (a brand-new ChatGPT chat, e.g. right after a
 * compaction opens a fresh one).
 */
export function buildChatGPTPrompt(
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
		userLabel: "Previous user message",
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

/**
 * Turn a finished reply into visible text plus tool calls.
 *
 * Two callers hand us a reply string: the normal capture path, and `/paste`,
 * where the user copied the reply out of the browser because a network error
 * ate ours. Both need the same parse ladder, so they run the same code.
 */
function parseCapturedReply(
	text: string,
	options: LanguageModelV2CallOptions,
	usage: ChatGPTCompletionResult["usage"],
): ChatGPTCompletionResult {
	const functionTools = (options.tools ?? []).filter(
		(tool): tool is LanguageModelV2FunctionTool => tool.type === "function",
	);
	if (functionTools.length === 0) {
		return { text, toolCalls: [], usage };
	}

	const toolNames = functionTools.map((t) => t.name);

	// Patch blocks are read BEFORE `<manager>` blocks and their PowerShell
	// fences. A model that says "apply this patch, then run this to check it"
	// writes both in one reply, and the shell fence used to win: the manager
	// path returned the `run_commands` call and the turn ended, so the patch was
	// never parsed and only the verification command ran — against a file that
	// had not changed. Applying first and verifying second is also the order the
	// model asked for.
	const patched = parsePatchBlocks(text, toolNames);
	const patchCalls = patched.toolCalls.map((call) => ({
		name: call.name as string,
		arguments: call.arguments as unknown as Record<string, unknown>,
	}));
	const patchNotice = unappliedPatchNotice(text, toolNames);
	if (patchNotice) {
		return {
			text: `${text}\n\n${patchNotice}`.trim(),
			toolCalls: [],
			usage,
			retryPrompt: patchNotice,
		};
	}
	const remainingText = patched.cleanedContent;

	// `<manager>` blocks are read next, and only when the session actually has
	// the team tool to dispatch them with. A lead on a web provider is prompted to
	// write delegations as prose rather than tool calls - see
	// `tool-pipeline/manager-block.ts` for why that framing is what keeps it out
	// of tool machinery it cannot use.
	if (toolNames.includes("team_run_task")) {
		const manager = parseManagerBlocks(remainingText, {
			// Only when the session actually has the shell tool to run it with.
			allowCommands: toolNames.includes("run_commands"),
		});
		if (
			manager.delegations.length > 0 ||
			manager.problems.length > 0 ||
			patchCalls.length > 0
		) {
			const retryPrompt =
				manager.problems.length > 0 ? manager.problems.join("\n") : undefined;
			return {
				text: retryPrompt
					? `${manager.cleanedContent}\n\n${retryPrompt}`.trim()
					: manager.cleanedContent,
				toolCalls: [
					...patchCalls,
					...manager.delegations.map((delegation) => ({
						name: delegation.name,
						arguments: delegation.arguments as Record<string, unknown>,
					})),
				],
				usage,
				retryPrompt,
			};
		}
	}

	if (patchCalls.length > 0) {
		return { text: remainingText, toolCalls: patchCalls, usage };
	}

	const { cleanedContent, toolCalls } = parseDeepSeekToolCalls(text, toolNames);
	const looseCalls =
		toolCalls.length === 0
			? parseLooseDeepSeekToolCalls(text, toolNames)
			: toolCalls;
	if (looseCalls.length > 0) {
		const { tools: validatedCalls, retryPrompt } =
			validateToolCalls(looseCalls);
		return {
			text: retryPrompt
				? `${cleanedContent}

${retryPrompt}`.trim()
				: cleanedContent,
			toolCalls: validatedCalls,
			usage,
			retryPrompt,
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
				? `${invoked.cleanedContent}

${retryPrompt}`.trim()
				: invoked.cleanedContent,
			toolCalls: validatedInvoked,
			usage,
			retryPrompt,
		};
	}

	if (patched.toolCalls.length > 0) {
		return {
			text: patched.cleanedContent,
			toolCalls: patched.toolCalls,
			usage,
		};
	}

	// The web model often ignores the `<tool>` contract and answers with
	// plain text (a plan, code fences, install commands). Convert the visible
	// structure of the reply into real tool calls so the agent actually
	// executes them, same as deepseek-web-v2's fallback.
	const fallback = parseFallbackToolUses(
		cleanedContent,
		lastUserText(options.prompt),
		toolNames,
	);
	return {
		text: fallback.cleanedText,
		toolCalls: fallback.toolUses,
		usage,
	};
}

function finishReasonFor(
	text: string,
	toolCalls: ChatGPTCompletionResult["toolCalls"],
): LanguageModelV2FinishReason {
	return toolCalls.length > 0 ? "tool-calls" : text ? "stop" : "unknown";
}

export function createChatGPTWebModel(
	modelId: string,
	logger?: BasicLogger,
): LanguageModelV2 {
	// Re-resolved on every turn, not captured once: `/profile` can switch the
	// active browser profile between turns, which changes the user-data-dir,
	// the debug port and the chat registry. A model built before the switch
	// would otherwise keep driving the old profile's Chrome.
	let runtimeConfig = resolveChatGPTWebV2Config();

	const debugLog = (msg: string) => {
		if (runtimeConfig.debug) logger?.debug(`[chatgpt-web] ${msg}`);
	};

	// How long to wait for ChatGPT to put the chat id in the URL after a send.
	//
	// A brand-new chat is assigned its id server-side and the URL is rewritten
	// once the response starts, which is slower than a 5s budget under load or
	// on a long prompt. Missing it is permanent for the conversation (see the
	// capture loop below), so the wait is generous.
	const CHAT_ID_CAPTURE_TIMEOUT_MS = 20_000;

	// Cached across runs: the session ID of the chat we're currently in.
	// Used to skip navigation on the second turn of the same chat.
	let currentChatGPTSession: string | undefined;

	// Shared by doGenerate/doStream (mirrors deepseek-web-v2's doCompletion):
	// drives the CDP session, sends the prompt, captures + parses the SSE
	// body, and recovers `<tool>` calls the model emitted — one code path so
	// both entry points behave identically instead of doStream being a thin,
	// divergent wrapper around doGenerate.
	async function runCompletion(
		options: LanguageModelV2CallOptions,
	): Promise<ChatGPTCompletionResult> {
		runtimeConfig = resolveChatGPTWebV2Config();
		debugLog("runCompletion called");

		// A reply the user pasted back with `/paste` after a network error ate
		// the real one. Short-circuit before touching the browser: the text is
		// already the model's answer, it just needs the same tool parsing a
		// captured reply gets.
		const injected = consumePendingInjectedReply("chatgpt-web");
		if (injected) {
			debugLog(`Using pasted reply (${injected.length} chars)`);
			return parseCapturedReply(injected, options, {
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
			});
		}

		// Cancelled while queued — do not open a browser for a dead turn.
		throwIfAborted(options.abortSignal);

		const cdp = await connectBrowser(runtimeConfig);

		const targets = await cdp.send("Target.getTargets");
		let pageTarget = targets.targetInfos?.find(
			(t: TargetInfo) =>
				t.type === "page" && t.url?.startsWith("https://chatgpt.com"),
		);
		if (!pageTarget) {
			const result = await cdp.send("Target.createTarget", {
				url: CHATGPT_WEB_URL,
			});
			await new Promise((resolve) => setTimeout(resolve, 2000));
			const newTargets = await cdp.send("Target.getTargets");
			pageTarget = newTargets.targetInfos?.find(
				(t: TargetInfo) => t.targetId === result.targetId,
			);
			if (!pageTarget) {
				throw new Error("Failed to create ChatGPT page");
			}
		}
		const attachResult = await cdp.send("Target.attachToTarget", {
			targetId: pageTarget.targetId,
			flatten: true,
		});
		const cdpSessionId = attachResult.sessionId;

		// Decide which chat to use: look up the session from the registry,
		// or use the cached one, or start fresh.
		const chatKey = resolveChatKey("chatgpt-web", () =>
			chatKeyFromPrompt(options.prompt),
		);
		const savedSession = lookupChatGPTChatSession(
			runtimeConfig.chatsFile,
			chatKey,
		);
		const sessionId = savedSession ?? currentChatGPTSession;

		const reInjectSystem = !!(options as ChatGPTWebCallOptions)
			.experimental_context?.reInjectSystemPrompt;
		const preserveCompactionContext = !!(options as ChatGPTWebCallOptions)
			.experimental_context?.preserveCompactionContext;

		// Navigate to the right chat (or start a new one).
		// If we have a sessionId, navigate to it; otherwise start fresh.
		if (sessionId) {
			await navigateChatGPTChat(cdp, cdpSessionId, { sessionId });
		} else {
			await navigateChatGPTChat(cdp, cdpSessionId, { fresh: true });
		}

		// Wait for the composer to be ready.
		await waitForComposerReady(cdp, cdpSessionId, runtimeConfig, logger);

		// Build the prompt text.
		const promptText = buildChatGPTPrompt(
			options.prompt,
			reInjectSystem,
			preserveCompactionContext,
		);

		// Check if we need to reload to recover from throttle.
		if (consumeChatGPTThrottleRecoveryReload()) {
			debugLog("reloading page to recover from throttle");
			await cdp.send(
				"Runtime.evaluate",
				{
					expression: `window.location.reload();`,
					returnByValue: false,
				},
				cdpSessionId,
			);
			await new Promise((resolve) => setTimeout(resolve, 3000));
			await waitForComposerReady(cdp, cdpSessionId, runtimeConfig, logger);
		}

		// Send the message and capture the response.
		const isToolTurn = (options.tools?.length ?? 0) > 0;
		const sendOptions = {
			think: (options as ChatGPTWebCallOptions).experimental_context?.think,
		};
		const captured = await sendAndCapture(
			cdp,
			cdpSessionId,
			promptText,
			runtimeConfig,
			logger,
			sendOptions,
			isToolTurn,
			options.abortSignal,
		);

		// Read the chat id back out of the page URL, which is how the next turn
		// finds its way to this same conversation.
		//
		// Missing it is not a one-turn cosmetic problem: nothing is recorded, so
		// the next turn looks the chat up, misses, and opens a FRESH chat — and
		// so does every turn after that. A new chat per message loses all
		// context, which the model reports as not being able to see the repo at
		// all. So the poll runs whether or not we navigated to a known chat: a
		// fresh chat needs time for ChatGPT to rewrite the URL, and an existing
		// one answers on the first read.
		let chatGPTSession: string | undefined;
		const chatIdDeadline = Date.now() + CHAT_ID_CAPTURE_TIMEOUT_MS;
		for (;;) {
			const pageUrl = await readPageUrl(cdp, cdpSessionId, pageTarget.targetId);
			chatGPTSession = pageUrl ? extractChatGPTSessionId(pageUrl) : undefined;
			if (chatGPTSession || Date.now() >= chatIdDeadline) break;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		if (!chatGPTSession) {
			debugLog(
				"could not read a chat id from the page URL; the next turn will " +
					"start a new chat instead of continuing this one",
			);
		}

		if (chatGPTSession) {
			currentChatGPTSession = chatGPTSession;
			recordChatGPTChatSession(
				runtimeConfig.chatsFile,
				chatKey,
				chatGPTSession,
			);
		}

		// Parse the captured reply.
		const parsed = parseCapturedReply(captured.text, options, captured.usage);

		// Log the turn for debugging.
		if (runtimeConfig.debug) {
			logConversationTurn("chatgpt-web", chatKey, captured.rawBody, {
				text: parsed.text,
				toolCalls: parsed.toolCalls,
				usage: parsed.usage,
			});
		}

		return parsed;
	}

	const provider: LanguageModelV2 = {
		specificationVersion: "v2",
		provider: "chatgpt-web",
		modelId,
		supportedUrls: {} as Record<string, RegExp[]>,

		async doGenerate(options: LanguageModelV2CallOptions) {
			try {
				const { text, toolCalls, usage } = await withBrowserLock(
					"chatgpt-web",
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
					warnings: [],
				};
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));
				logger?.error?.(`[chatgpt-web] doGenerate error: ${err.message}`);
				throw err;
			}
		},

		async doStream(options: LanguageModelV2CallOptions) {
			const { text, toolCalls, usage } = await withBrowserLock(
				"chatgpt-web",
				options.abortSignal,
				() => runCompletion(options),
			);
			const id = `chatgpt-web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

export function createChatGPTWebProvider(
	_config: GatewayResolvedProviderConfig,
	context?: GatewayProviderContext,
): ProviderFactoryResult {
	const logger = context?.logger;
	return {
		model: (modelId: string) => createChatGPTWebModel(modelId, logger),
	};
}

export function createChatGPTWebProviderFactory() {
	return { id: "chatgpt-web", create: createChatGPTWebProvider };
}

// ── Module factory (used by ai-sdk.ts) ────────────────────────────────────────

export function createChatGPTWebProviderModule(
	config: GatewayResolvedProviderConfig,
	context?: GatewayProviderContext,
): ProviderFactoryResult {
	return createChatGPTWebProvider(config, context);
}
