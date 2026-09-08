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
	computeSendDelay,
	continuationLabel,
	isRateLimitText,
	parseFallbackToolUses,
} from "../deepseek-web-v2";
import { abortableSleep, throwIfAborted } from "../tool-pipeline/abort";
import { withBrowserLock } from "../tool-pipeline/browser-lock";
import { getBoundChatKey, resolveChatKey } from "../tool-pipeline/chat-target";
import { logConversationTurn } from "../tool-pipeline/conversation-logger";
import { consumePendingInjectedReply } from "../tool-pipeline/injected-reply";
import { parseInvokeStyleToolCalls } from "../tool-pipeline/invoke-parser";
import { parseManagerBlocks } from "../tool-pipeline/manager-block";
import {
	parsePatchBlocks,
	unappliedPatchNotice,
} from "../tool-pipeline/patch-block";
import {
	realUserMessageKey,
	stripPreviousUserBlock,
} from "../tool-pipeline/previous-user-dedupe";
import { applySimpleWebSystemPrompt } from "../tool-pipeline/simple-system-prompt";
import { validateToolCalls } from "../tool-pipeline/tool-dispatcher";
import type { ProviderFactoryResult } from "../types";
import {
	claudeNetworkEnabledSessions,
	connectBrowser,
	consumeClaudeThrottleRecoveryReload,
	getActiveClaudeCdpSessionId,
	getActiveClaudeTargetId,
	setActiveClaudeCdpSessionId,
	setActiveClaudeTargetId,
} from "./browser";
import { sendAndCapture } from "./capture";
import {
	chatKeyFromPrompt,
	extractClaudeSessionId,
	lookupClaudeChatSession,
	recordClaudeChatSession,
} from "./chat-registry";
import { CLAUDE_WEB_URL, resolveClaudeWebV2Config, sleep } from "./config";
import {
	navigateClaudeChat,
	readPageUrl,
	waitForComposerReady,
} from "./navigation";
import { parseAskUserInputToolCalls, renderAskUserInputAsText } from "./sse";

// ── Main provider ──────────────────────────────────────────────────────────────

interface ClaudeCompletionResult {
	text: string;
	toolCalls: { name: string; arguments: Record<string, unknown> }[];
	usage: { inputTokens: number; outputTokens: number; totalTokens: number };
	retryPrompt?: string;
}

function lastUserText(prompt: LanguageModelV2Prompt): string {
	for (let i = prompt.length - 1; i >= 0; i--) {
		const message = prompt[i];
		if (message.role !== "user") continue;
		const content = Array.isArray(message.content)
			? message.content
					.map((block) =>
						"text" in block ? (block as { text: string }).text : "",
					)
					.join("\n")
			: message.content;
		return typeof content === "string" ? content.trim() : "";
	}
	return "";
}

function parseCapturedReply(
	text: string,
	options: LanguageModelV2CallOptions,
	usage: ClaudeCompletionResult["usage"],
	askUserInput?: string,
): ClaudeCompletionResult {
	const functionTools = (options.tools ?? []).filter(
		(tool): tool is LanguageModelV2FunctionTool => tool.type === "function",
	);

	// Claude's native `ask_user_input_v0` widget
	if (askUserInput) {
		const askCalls = parseAskUserInputToolCalls(
			askUserInput,
			functionTools.map((t) => t.name),
		);
		if (askCalls.length > 0) {
			return { text, toolCalls: askCalls, usage };
		}
		const rendered = renderAskUserInputAsText(askUserInput);
		if (rendered) {
			return {
				text: text.trim() ? `${text.trim()}\n\n${rendered}` : rendered,
				toolCalls: [],
				usage,
			};
		}
	}

	if (functionTools.length === 0) {
		return { text, toolCalls: [], usage };
	}

	const toolNames = functionTools.map((t) => t.name);

	// `<manager>` blocks
	if (toolNames.includes("team_run_task")) {
		const manager = parseManagerBlocks(text, {
			allowCommands: toolNames.includes("run_commands"),
		});
		if (manager.delegations.length > 0 || manager.problems.length > 0) {
			const retryPrompt =
				manager.problems.length > 0 ? manager.problems.join("\n") : undefined;
			return {
				text: retryPrompt
					? `${manager.cleanedContent}\n\n${retryPrompt}`.trim()
					: manager.cleanedContent,
				toolCalls: manager.delegations.map((delegation) => ({
					name: delegation.name,
					arguments: delegation.arguments as Record<string, unknown>,
				})),
				usage,
				retryPrompt,
			};
		}
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
				? `${cleanedContent}\n\n${retryPrompt}`.trim()
				: cleanedContent,
			toolCalls: validatedCalls,
			usage,
			retryPrompt,
		};
	}

	// Invoke style
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
			retryPrompt,
		};
	}

	// Patch blocks
	const patched = parsePatchBlocks(cleanedContent, toolNames);
	const patchNotice = unappliedPatchNotice(cleanedContent, toolNames);
	if (patchNotice) {
		return {
			text: `${cleanedContent}\n\n${patchNotice}`.trim(),
			toolCalls: [],
			usage,
			retryPrompt: patchNotice,
		};
	}
	if (patched.toolCalls.length > 0) {
		return {
			text: patched.cleanedContent,
			toolCalls: patched.toolCalls,
			usage,
		};
	}

	// Fallback to parseFallbackToolUses
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
	toolCalls: ClaudeCompletionResult["toolCalls"],
): LanguageModelV2FinishReason {
	if (isRateLimitText(text)) return "error";
	return toolCalls.length > 0 ? "tool-calls" : text ? "stop" : "unknown";
}

function buildClaudePrompt(
	prompt: LanguageModelV2Prompt,
	reInjectSystem: boolean,
	preserveCompactionContext: boolean,
): string {
	const effectivePrompt = applySimpleWebSystemPrompt(prompt);
	const conversation = buildLeanConversation(
		effectivePrompt,
		preserveCompactionContext,
	);
	const systemMessage = effectivePrompt.find((m) => m.role === "system");
	const alreadyHasSystem = conversation.some((m) => m.role === "system");
	const promptOptions = {
		historyWindow: 10,
		userLabel: "Previous user message",
		lastUserLabel: continuationLabel(conversation),
		toolResultLabel: "Tool result",
	};

	let raw: string;
	if (
		reInjectSystem &&
		systemMessage &&
		!alreadyHasSystem &&
		conversation.length > 0
	) {
		raw = messagesToPrompt([systemMessage, ...conversation], promptOptions);
	} else {
		raw = messagesToPrompt(conversation, promptOptions);
	}

	// Rephrase tool results
	const segments = raw.split("\n\n");
	const rephrased = segments
		.filter((segment, index) => {
			const trimmed = segment.trim();
			const isLastPreviousUser =
				trimmed.startsWith("Previous user message:") &&
				index === segments.length - 1;
			return (
				isLastPreviousUser ||
				(!trimmed.startsWith("Previous user message:") &&
					!trimmed.startsWith("Note:"))
			);
		})
		.map((segment) => {
			const match = /^Tool result: \(([^)]+)\)\s*([\s\S]*)$/.exec(segment);
			if (!match) return segment;
			const toolName = match[1];
			const body = match[2].trim();
			const lines = body.split("\n");
			const capped =
				lines.length > 200
					? [
							...lines.slice(0, 200),
							`... [output truncated: ${lines.length - 200} more lines]`,
						].join("\n")
					: body;
			let formatted: string;
			switch (toolName) {
				case "read_files":
					formatted = `Here is the file content I just read:\n${capped}`;
					break;
				case "_codebase":
					formatted = `Here are the files/functions I found when searching:\n${capped}`;
					break;
				case "run_commands":
					formatted = `Here is the output of the command I just ran:\n${capped}`;
					break;
				case "editor":
					formatted = `I just edited the file. Here is the result:\n${capped}`;
					break;
				case "fetch_web_content":
					formatted = `Here is the content I fetched from the web:\n${capped}`;
					break;
				case "ask_question":
				case "ask_followup_question":
					formatted = capped;
					break;
				default:
					formatted = `Here is what I found:\n${capped}`;
			}
			return formatted;
		})
		.join("\n\n");
	return rephrased;
}

function createClaudeWebModel(
	modelId: string,
	logger?: BasicLogger,
	contextWindow?: number,
): LanguageModelV2 {
	let runtimeConfig = resolveClaudeWebV2Config();
	runtimeConfig.contextWindow = contextWindow;

	const debugLog = (msg: string) => {
		if (runtimeConfig.debug) logger?.debug(`[claude-web] ${msg}`);
	};

	let lastSentUserMessage = "";

	async function runCompletionWithOptions(
		options: LanguageModelV2CallOptions,
	): Promise<ClaudeCompletionResult> {
		runtimeConfig = resolveClaudeWebV2Config();
		debugLog("runCompletion called");

		const injected = consumePendingInjectedReply("claude-web");
		if (injected) {
			debugLog(`Using pasted reply (${injected.length} chars)`);
			return parseCapturedReply(injected, options, {
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
			});
		}

		throwIfAborted(options.abortSignal);

		const cdp = await connectBrowser(runtimeConfig);

		const targets = await cdp.send("Target.getTargets");
		let pageTarget = targets.targetInfos?.find(
			(t: { type: string; url?: string }) =>
				t.type === "page" && t.url?.startsWith("https://claude.ai"),
		);

		if (!pageTarget) {
			const result = await cdp.send("Target.createTarget", {
				url: CLAUDE_WEB_URL,
			});
			await sleep(2000);
			const newTargets = await cdp.send("Target.getTargets");
			pageTarget = newTargets.targetInfos?.find(
				(t: { targetId: string }) => t.targetId === result.targetId,
			);
			if (!pageTarget) {
				throw new Error("Failed to create Claude page");
			}
		}

		let cdpSessionId: string | null = getActiveClaudeCdpSessionId();
		if (
			!cdpSessionId ||
			getActiveClaudeTargetId() !== pageTarget.targetId ||
			!cdp.isOpen()
		) {
			const attachResult = await cdp.send("Target.attachToTarget", {
				targetId: pageTarget.targetId,
				flatten: true,
			});
			const newSessionId = attachResult.sessionId as string;
			cdpSessionId = newSessionId;
			setActiveClaudeTargetId(pageTarget.targetId);
			setActiveClaudeCdpSessionId(newSessionId);
			claudeNetworkEnabledSessions.delete(newSessionId);
		}
		if (!cdpSessionId) {
			throw new Error(
				"[claude-web] failed to attach a CDP session to the Claude page",
			);
		}

		if (!claudeNetworkEnabledSessions.has(cdpSessionId)) {
			await cdp.send("Network.enable", {}, cdpSessionId);
			claudeNetworkEnabledSessions.add(cdpSessionId);
		}

		const chatKey = resolveChatKey("claude-web", () =>
			chatKeyFromPrompt(options.prompt),
		);
		let existingClaudeSession = lookupClaudeChatSession(
			runtimeConfig.chatsFile,
			chatKey,
		);
		if (!existingClaudeSession && getBoundChatKey("claude-web") === chatKey) {
			existingClaudeSession = chatKey;
			recordClaudeChatSession(runtimeConfig.chatsFile, chatKey, chatKey);
		}
		const isNewChat = existingClaudeSession === undefined;

		const forceReload = consumeClaudeThrottleRecoveryReload();
		await navigateClaudeChat(
			cdp,
			cdpSessionId,
			existingClaudeSession
				? { sessionId: existingClaudeSession, fresh: false }
				: { fresh: true },
			logger,
			forceReload,
		);

		await waitForComposerReady(cdp, cdpSessionId, runtimeConfig, logger);

		let promptText = buildClaudePrompt(options.prompt, isNewChat, isNewChat);

		const currentUserText = realUserMessageKey(options.prompt);
		if (currentUserText && currentUserText === lastSentUserMessage) {
			promptText = stripPreviousUserBlock(promptText);
		}
		lastSentUserMessage = currentUserText;

		const functionTools = (options.tools ?? []).filter(
			(tool): tool is LanguageModelV2FunctionTool => tool.type === "function",
		);

		debugLog(`Sending prompt (${promptText.length} chars)`);

		const MAX_TOOL_REJECTION_RETRIES = 2;

		let sendPrompt = promptText;
		let result: Awaited<ReturnType<typeof sendAndCapture>>;
		let parsed: ClaudeCompletionResult;
		for (let attempt = 0; ; attempt++) {
			result = await sendAndCapture(
				cdp,
				cdpSessionId,
				sendPrompt,
				runtimeConfig,
				logger,
				{},
				functionTools.length > 0,
				options.abortSignal,
			);

			debugLog(`Received response (${result.text.length} chars)`);

			parsed = parseCapturedReply(
				result.text,
				options,
				result.usage,
				result.askUserInput,
			);

			try {
				logConversationTurn("claude-web", chatKey, result.rawBody, {
					text: parsed.text,
					toolCalls: parsed.toolCalls.length > 0 ? parsed.toolCalls : undefined,
					usage: result.usage,
					finishReason: result.finishReason,
				});
			} catch (_logErr) {
				// Ignore logging failures
			}

			if (
				parsed.toolCalls.length === 0 &&
				parsed.retryPrompt &&
				attempt < MAX_TOOL_REJECTION_RETRIES
			) {
				logger?.log(
					`[claude-web] all tool calls rejected, resending correction into chat (attempt ${attempt + 1}/${MAX_TOOL_REJECTION_RETRIES})`,
					{ severity: "warn" },
				);
				sendPrompt = parsed.retryPrompt;
				continue;
			}
			break;
		}

		const pageUrl = await readPageUrl(cdp, cdpSessionId);
		const sessionId = extractClaudeSessionId(pageUrl);
		if (sessionId && !existingClaudeSession) {
			recordClaudeChatSession(runtimeConfig.chatsFile, chatKey, sessionId);
		}

		const isToolTurn = parsed.toolCalls.length > 0;
		const sendDelay = computeSendDelay(
			{
				minSendDelayMs: runtimeConfig.minSendDelayMs,
				maxSendDelayMs: runtimeConfig.maxSendDelayMs,
				toolTurnExtraMinMs: runtimeConfig.toolTurnExtraMinMs,
				toolTurnExtraMaxMs: runtimeConfig.toolTurnExtraMaxMs,
			},
			{ isToolTurn },
		);
		if (sendDelay > 0) {
			await abortableSleep(sendDelay, options.abortSignal);
		}

		return parsed;
	}

	const provider: LanguageModelV2 = {
		specificationVersion: "v2",
		provider: "claude-web",
		modelId,
		supportedUrls: {} as Record<string, RegExp[]>,

		async doGenerate(options: LanguageModelV2CallOptions) {
			try {
				const { text, toolCalls, usage } = await withBrowserLock(
					"claude-web",
					options.abortSignal,
					() => runCompletionWithOptions(options),
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
				logger?.error?.(`[claude-web] doGenerate error: ${err.message}`);
				throw err;
			}
		},

		async doStream(options: LanguageModelV2CallOptions) {
			const { text, toolCalls, usage } = await withBrowserLock(
				"claude-web",
				options.abortSignal,
				() => runCompletionWithOptions(options),
			);
			const id = `claude-web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

export function createClaudeWebProvider(
	_config: GatewayResolvedProviderConfig,
	context?: GatewayProviderContext,
): ProviderFactoryResult {
	const logger = context?.logger;
	const contextWindow = context?.model?.contextWindow;
	return {
		model: (modelId: string) =>
			createClaudeWebModel(modelId, logger, contextWindow),
	};
}

export function createClaudeWebProviderFactory() {
	return { id: "claude-web", create: createClaudeWebProvider };
}

export function createClaudeWebProviderModule(
	config: GatewayResolvedProviderConfig,
	context?: GatewayProviderContext,
): ProviderFactoryResult {
	return createClaudeWebProvider(config, context);
}
