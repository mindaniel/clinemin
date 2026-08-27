import { createHandlerAsync, useLastChatForNextCall } from "@cline/llms";
import type { BasicLogger, Message } from "@cline/shared";
import { countUserRunMessages } from "../../session/user-run-messages";
import type {
	CoreCompactionContext,
	CoreCompactionResult,
	CoreCompactionSummarizerConfig,
} from "../../types/config";
import type { ProviderConfig } from "../../types/provider-settings";
import {
	type BudgetProjectionResult,
	buildBudgetProjection,
} from "./budget-projection";
import {
	buildSummaryMessage,
	buildSummaryRequest,
	type EstimateMessageTokens,
	ensureFilesSection,
	estimateTokens,
	extractFileOps,
	type FileOperationSummary,
	findCutIndex,
	findLatestSummaryIndex,
	getCompactionSummaryMetadata,
	isLeanSummaryProvider,
	isStatefulWebChatProvider,
	resolveEffectiveMaxInputTokens,
	resolveSummarizerConfig,
	serializeConversation,
} from "./compaction-shared";

const MIN_AGENTIC_SUMMARY_INPUT_TOKENS = 1_024;

function resolveProviderMaxInputTokens(
	providerConfig: ProviderConfig,
): number | undefined {
	const modelInfoLimit = resolveEffectiveMaxInputTokens({
		maxInputTokens:
			providerConfig.maxInputTokens ?? providerConfig.modelInfo?.maxInputTokens,
		contextWindow: providerConfig.modelInfo?.contextWindow,
	});
	if (modelInfoLimit !== undefined) {
		return modelInfoLimit;
	}
	const knownModelInfo = providerConfig.knownModels?.[providerConfig.modelId];
	return resolveEffectiveMaxInputTokens({
		maxInputTokens: knownModelInfo?.maxInputTokens,
		contextWindow: knownModelInfo?.contextWindow,
	});
}

export function buildAgenticSummaryInputBudget(options: {
	messages: CoreCompactionContext["messages"];
	targetTokens: number;
	estimateMessageTokens: EstimateMessageTokens;
}): BudgetProjectionResult {
	return buildBudgetProjection({
		messages: options.messages,
		targetTokens: Math.max(1, options.targetTokens),
		policyIntent: "agentic_summary",
		estimateMessageTokens: options.estimateMessageTokens,
	});
}

async function generateSummary(options: {
	providerConfig: ProviderConfig;
	request: string;
	/**
	 * Send this request into the chat the last ordinary turn used, rather than
	 * letting the provider derive a chat from the request's own text. Only
	 * meaningful for stateful web-chat providers, where the history lives in
	 * the browser chat and a request routed anywhere else sees nothing to
	 * summarize.
	 */
	reuseActiveChat?: boolean;
	logger?: BasicLogger;
}): Promise<string> {
	const handler = await createHandlerAsync(options.providerConfig);
	const messages: Message[] = [{ role: "user", content: options.request }];
	if (options.reuseActiveChat) {
		useLastChatForNextCall();
	}
	let text = "";
	// The request itself already carries the summarize instruction; a system
	// prompt repeating it just makes the model read the same ask twice.
	for await (const chunk of handler.createMessage("", messages)) {
		if (chunk.type === "text") {
			text += chunk.text;
			continue;
		}
		if (chunk.type === "done" && !chunk.success && chunk.error) {
			throw new Error(chunk.error);
		}
	}
	options.logger?.debug("Generated compaction summary", {
		outputChars: text.length,
		modelId: options.providerConfig.modelId,
		providerId: options.providerConfig.providerId,
		reusedActiveChat: options.reuseActiveChat === true,
	});
	return text.trim();
}

function safeJsonSize(value: unknown): number {
	try {
		return JSON.stringify(value).length;
	} catch {
		return String(value).length;
	}
}

/**
 * Compaction path for providers whose web chat keeps its own server-side
 * conversation state (`isStatefulWebChatProvider`). Instead of reconstructing
 * the transcript and sending it to a fresh, unrelated chat, this asks for a
 * summary INSIDE the chat that already holds the real history: the request
 * carries only the summarize instruction, and `reuseActiveChat` tells the
 * provider to send it to the chat the last ordinary turn used rather than
 * deriving one from the request's own text.
 *
 * This is stage 1 of three. The CLI then stores the returned summary as a
 * `compaction_summary` message, and the next real turn opens a fresh chat
 * seeded with the system prompt + that summary. All three stages, and what to
 * do when adding another web provider, are documented in
 * `@cline/llms` -> providers/vendors/tool-pipeline/chat-target.ts.
 */
async function runStatefulWebChatCompaction(options: {
	messages: CoreCompactionContext["messages"];
	messagesToSummarize: CoreCompactionContext["messages"];
	cutIndex: number;
	fileOps: FileOperationSummary;
	summarizerProviderConfig: ProviderConfig;
	estimateMessageTokens: EstimateMessageTokens;
	logger?: BasicLogger;
}): Promise<CoreCompactionResult | undefined> {
	const summaryRequest = buildSummaryRequest({
		conversationText: "",
		fileOps: options.fileOps,
		style: "session",
	});
	options.logger?.debug(
		"Agentic compaction summarizer diagnostics (stateful web chat)",
		{
			messagesToSummarize: options.messagesToSummarize.length,
			summarizerProviderId: options.summarizerProviderConfig.providerId,
			summarizerModelId: options.summarizerProviderConfig.modelId,
		},
	);
	const rawSummary = await generateSummary({
		providerConfig: options.summarizerProviderConfig,
		request: summaryRequest,
		reuseActiveChat: true,
		logger: options.logger,
	});
	if (!rawSummary.trim()) {
		return undefined;
	}

	const summary = ensureFilesSection(rawSummary, options.fileOps);
	const tokensBefore = options.messages.reduce(
		(total, message) => total + options.estimateMessageTokens(message),
		0,
	);
	const resultMessages = [
		buildSummaryMessage({
			summary,
			fileOps: options.fileOps,
			tokensBefore,
			userRunSpan: countUserRunMessages(options.messagesToSummarize),
		}),
		...options.messages.slice(options.cutIndex),
	];
	const tokensAfter = resultMessages.reduce(
		(total, message) => total + options.estimateMessageTokens(message),
		0,
	);
	options.logger?.debug("Performed agentic compaction (stateful web chat)", {
		messagesBefore: options.messages.length,
		messagesAfter: resultMessages.length,
		messagesSummarized: options.cutIndex,
		messagesPreserved: options.messages.length - options.cutIndex,
		tokensBefore,
		tokensAfter,
	});
	return {
		messages: resultMessages,
		budget: {
			policyIntent: "agentic_summary",
			actionCount: 0,
			warningCount: 0,
			liveTailHandling: "included_verbatim",
		},
	};
}

export async function runAgenticCompaction(options: {
	context: CoreCompactionContext;
	providerConfig: ProviderConfig;
	summarizer?: CoreCompactionSummarizerConfig;
	preserveRecentTokens: number;
	estimateMessageTokens: EstimateMessageTokens;
	logger?: BasicLogger;
}): Promise<CoreCompactionResult | undefined> {
	const messages = options.context.messages;
	if (messages.length < 2) {
		return undefined;
	}

	const cutIndex = findCutIndex(
		messages,
		options.preserveRecentTokens,
		options.estimateMessageTokens,
	);
	if (cutIndex <= 0 || cutIndex >= messages.length) {
		return undefined;
	}

	const messagesToSummarize = messages.slice(0, cutIndex);
	const latestSummaryIndex = findLatestSummaryIndex(messagesToSummarize);
	const previousSummary =
		latestSummaryIndex >= 0
			? getCompactionSummaryMetadata(messagesToSummarize[latestSummaryIndex])
					?.summary
			: undefined;
	const newMessagesToFold =
		latestSummaryIndex >= 0
			? messagesToSummarize.slice(latestSummaryIndex + 1)
			: messagesToSummarize;
	if (newMessagesToFold.length === 0) {
		return undefined;
	}

	const preProjectionFileOps = extractFileOps(messagesToSummarize);
	const summarizerProviderConfig = resolveSummarizerConfig({
		activeProviderConfig: options.providerConfig,
		summarizer: options.summarizer,
	});

	if (isStatefulWebChatProvider(summarizerProviderConfig.providerId)) {
		return runStatefulWebChatCompaction({
			messages,
			messagesToSummarize,
			cutIndex,
			fileOps: preProjectionFileOps,
			summarizerProviderConfig,
			estimateMessageTokens: options.estimateMessageTokens,
			logger: options.logger,
		});
	}

	const resolvedSummarizerInputLimit = resolveProviderMaxInputTokens(
		summarizerProviderConfig,
	);
	const canUseActiveContextLimit = options.summarizer === undefined;
	const activeCompactionInputLimit = Math.max(
		options.context.budget.request.maxInputTokens,
		options.context.budget.request.triggerTokens,
		MIN_AGENTIC_SUMMARY_INPUT_TOKENS,
	);
	if (resolvedSummarizerInputLimit === undefined && !canUseActiveContextLimit) {
		options.logger?.log(
			"Agentic compaction summarizer has no known input limit; using conservative summary budget",
			{
				severity: "warn",
				summarizerProviderId: summarizerProviderConfig.providerId,
				summarizerModelId: summarizerProviderConfig.modelId,
				fallbackInputLimit: MIN_AGENTIC_SUMMARY_INPUT_TOKENS,
			},
		);
	}
	const summarizerInputLimit =
		resolvedSummarizerInputLimit ??
		(canUseActiveContextLimit
			? activeCompactionInputLimit
			: MIN_AGENTIC_SUMMARY_INPUT_TOKENS);
	const summaryRequestOverheadTokens = estimateTokens(
		buildSummaryRequest({
			previousSummary,
			conversationText: "",
			fileOps: preProjectionFileOps,
			style: isLeanSummaryProvider(summarizerProviderConfig.providerId)
				? "lean"
				: "full",
		}).length,
	);
	const availableSummaryInputTokens =
		summarizerInputLimit - summaryRequestOverheadTokens;
	if (availableSummaryInputTokens <= 0) {
		options.logger?.debug(
			"Skipped agentic compaction: summarizer budget exhausted",
			{
				summarizerProviderId: summarizerProviderConfig.providerId,
				summarizerModelId: summarizerProviderConfig.modelId,
				summarizerInputLimit,
				summaryRequestOverheadTokens,
			},
		);
		return undefined;
	}
	const summaryInputBudget = buildAgenticSummaryInputBudget({
		messages: newMessagesToFold,
		targetTokens: availableSummaryInputTokens,
		estimateMessageTokens: options.estimateMessageTokens,
	});
	if (summaryInputBudget.status === "failed") {
		options.logger?.log(
			"Skipped agentic compaction: summary input budget failed",
			{
				severity: "warn",
				budgetWarnings: summaryInputBudget.warnings.map(
					(warning) => warning.code,
				),
				summaryInputEstimatedTokens: summaryInputBudget.estimatedTokens,
				targetTokens: availableSummaryInputTokens,
				summarizerProviderId: summarizerProviderConfig.providerId,
				summarizerModelId: summarizerProviderConfig.modelId,
			},
		);
		return undefined;
	}
	const fileOps = extractFileOps(summaryInputBudget.messages);
	const conversationText = serializeConversation(summaryInputBudget.messages);
	const summaryRequest = buildSummaryRequest({
		previousSummary,
		conversationText,
		fileOps,
		style: isLeanSummaryProvider(summarizerProviderConfig.providerId)
			? "lean"
			: "full",
	});
	options.logger?.debug("Agentic compaction summarizer diagnostics", {
		messagesToSummarize: messagesToSummarize.length,
		newMessagesToFold: newMessagesToFold.length,
		preservedMessages: messages.length - cutIndex,
		previousSummaryChars: previousSummary?.length ?? 0,
		conversationTextChars: conversationText.length,
		summaryRequestChars: summaryRequest.length,
		summaryRequestEstimatedTokens: estimateTokens(summaryRequest.length),
		newMessagesJsonChars: safeJsonSize(newMessagesToFold),
		summaryInputEstimatedTokens: summaryInputBudget.estimatedTokens,
		summaryInputActions: summaryInputBudget.actions.length,
		summaryInputWarnings: summaryInputBudget.warnings.map(
			(warning) => warning.code,
		),
		summaryRequestOverheadTokens,
		summarizerProviderId: summarizerProviderConfig.providerId,
		summarizerModelId: summarizerProviderConfig.modelId,
		summarizerInputLimit,
		maxInputTokens: options.context.budget.request.maxInputTokens,
		triggerTokens: options.context.budget.request.triggerTokens,
	});
	const rawSummary = await generateSummary({
		providerConfig: summarizerProviderConfig,
		request: summaryRequest,
		logger: options.logger,
	});
	if (!rawSummary.trim()) {
		return undefined;
	}

	const summary = ensureFilesSection(rawSummary, fileOps);
	const tokensBefore = messages.reduce(
		(total, message) => total + options.estimateMessageTokens(message),
		0,
	);
	const resultMessages = [
		buildSummaryMessage({
			summary,
			fileOps,
			tokensBefore,
			userRunSpan: countUserRunMessages(messagesToSummarize),
		}),
		...messages.slice(cutIndex),
	];
	const tokensAfter = resultMessages.reduce(
		(total, message) => total + options.estimateMessageTokens(message),
		0,
	);
	options.logger?.debug("Performed agentic compaction", {
		messagesBefore: messages.length,
		messagesAfter: resultMessages.length,
		messagesSummarized: cutIndex,
		messagesPreserved: messages.length - cutIndex,
		tokensBefore,
		tokensAfter,
		maxInputTokens: options.context.budget.request.maxInputTokens,
	});
	const budgetActionCount = summaryInputBudget.actions.filter(
		(action) =>
			action.reason === "over_budget" || action.reason === "tool_pair_boundary",
	).length;
	return {
		messages: resultMessages,
		budget: {
			policyIntent: "agentic_summary",
			actionCount: budgetActionCount,
			warningCount: summaryInputBudget.warnings.length,
			liveTailHandling: summaryInputBudget.liveTailHandling,
		},
	};
}
