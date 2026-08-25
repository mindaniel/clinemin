import {
	createAgentModelFromConfig,
	createContextCompactionPrepareTurn,
	createSessionCompactionState,
	type AgentConfig,
	type ProviderConfig,
	type ProviderSettings,
	type ProviderSettingsManager,
	type ReasoningSettings,
	type SessionCompactionState,
	toProviderConfig,
} from "@cline/core";
import type { Message } from "@cline/shared";
import type { Config } from "../../utils/types";

const FALLBACK_MANUAL_COMPACTION_MAX_INPUT_TOKENS = 64_000;

function resolveCompactionReasoningSettings(
	config: Config,
	stored: ProviderSettings | undefined,
): ReasoningSettings | undefined {
	if (config.reasoningEffort) {
		return { enabled: true, effort: config.reasoningEffort };
	}
	return stored?.reasoning;
}

export function resolveCompactionProviderConfig(
	config: Config,
	providerSettingsManager: ProviderSettingsManager,
): ProviderConfig {
	const stored = providerSettingsManager.getProviderSettings(config.providerId);
	const providerConfig = toProviderConfig({
		...(stored ?? {}),
		provider: config.providerId,
		model: config.modelId,
		apiKey: config.apiKey || stored?.apiKey,
		baseUrl: config.baseUrl ?? stored?.baseUrl,
		headers: config.headers ?? stored?.headers,
		reasoning: resolveCompactionReasoningSettings(config, stored),
	} satisfies ProviderSettings);
	const base = {
		...providerConfig,
		...(config.providerConfig ?? {}),
	};
	return {
		...base,
		providerId: base.providerId ?? config.providerId,
		modelId: base.modelId ?? config.modelId,
		knownModels: base.knownModels ?? config.knownModels,
	};
}

export async function compactInteractiveMessages(input: {
	config: Config;
	providerSettingsManager: ProviderSettingsManager;
	sessionId: string;
	messages: Message[];
	abortSignal?: AbortSignal;
}): Promise<{
	compacted: boolean;
	canonicalMessages: Message[];
	compactionState?: SessionCompactionState;
	summary?: string;
}> {
	console.log('[compact] function called, providerId:', input.config.providerId, 'modelId:', input.config.modelId);
	console.log('[compact] messages count:', input.messages.length);
	const modelInfo = input.config.knownModels?.[input.config.modelId];
	const compactionModelInfo = modelInfo
		? {
				...modelInfo,
				id: modelInfo.id ?? input.config.modelId,
			}
		: {
				id: input.config.modelId,
				maxInputTokens: FALLBACK_MANUAL_COMPACTION_MAX_INPUT_TOKENS,
			};

	// Special handling for deepseek-web-v2: send a custom compaction prompt and use the response as summary.
	console.log('[compact] checking providerId:', input.config.providerId);
	if (input.config.providerId === 'deepseek-web-v2') {
		console.log('[compact] entering deepseek-web-v2 branch');
		try {
			const providerConfig = resolveCompactionProviderConfig(input.config, input.providerSettingsManager);
			// Build an AgentConfig from the ProviderConfig
			const agentConfig: AgentConfig = {
				provider: providerConfig.providerId,
				model: providerConfig.modelId,
				apiKey: providerConfig.apiKey,
				baseUrl: providerConfig.baseUrl,
				headers: providerConfig.headers,
				reasoning: providerConfig.reasoning,
				knownModels: providerConfig.knownModels,
			};
			const model = await createAgentModelFromConfig(agentConfig, input.config.logger);
			const compactionPrompt =
				"Give me a detailed prompt to continue in next chat. Make sure the next chat understand the context, what it should do and should not do, and any other information you think its necessary for it to fully understand.";
			const messages: Message[] = [...input.messages, { role: 'user', content: compactionPrompt }];
			const result = await model.doGenerate({
				prompt: messages,
				tools: [],
				abortSignal: input.abortSignal,
			});
			const summary = result.text;
			if (!summary) {
				return { compacted: false, canonicalMessages: input.messages };
			}
			const compactionState = createSessionCompactionState({
				sourceMessages: input.messages,
				compactedMessages: [{ role: 'user', content: summary }],
				conversationId: input.sessionId,
				systemPrompt: '',
			});
			return {
				compacted: true,
				canonicalMessages: input.messages,
				compactionState,
				summary,
			};
		} catch (error) {
			console.error('[compact] ERROR:', error);
			if (input.config.logger) {
				input.config.logger.log(
					`DeepSeek Web v2 custom compaction failed: ${error instanceof Error ? error.message : String(error)}`,
					{ severity: 'error' },
				);
			}
			return { compacted: false, canonicalMessages: input.messages };
		}
	}

	const compact = createContextCompactionPrepareTurn(
		{
			providerConfig: resolveCompactionProviderConfig(
				input.config,
				input.providerSettingsManager,
			),
			providerId: input.config.providerId,
			modelId: input.config.modelId,
			compaction: {
				...input.config.compaction,
				enabled: true,
			},
			logger: input.config.logger,
			// Forward telemetry + sessionId so manual compactions emit
			// `task.compaction_executed` / `task.compaction_skipped` events
			// alongside auto compactions.
			telemetry: input.config.telemetry,
			sessionId: input.sessionId,
		},
		{ mode: "manual" },
	);
	if (!compact) {
		return { compacted: false, canonicalMessages: input.messages };
	}
	// Manual compaction intentionally summarizes the full canonical transcript
	// instead of reusing a prior sidecar summary, which avoids summary-of-summary
	// drift across repeated `/compact` calls.
	const result = await compact({
		agentId: "cli",
		conversationId: input.sessionId,
		parentAgentId: null,
		iteration: 0,
		messages: input.messages,
		apiMessages: input.messages,
		abortSignal: input.abortSignal ?? new AbortController().signal,
		systemPrompt: "",
		tools: [],
		model: {
			id: input.config.modelId,
			provider: input.config.providerId,
			info: compactionModelInfo,
		},
	});
	if (!result?.messages) {
		return { compacted: false, canonicalMessages: input.messages };
	}

	// Extract compaction summary from the result messages
	let summary: string | undefined;
	for (const msg of result.messages) {
		if (msg.metadata?.kind === "compaction_summary") {
			summary = msg.metadata?.summary as string | undefined;
			break;
		}
	}

	return {
		compacted: true,
		canonicalMessages: input.messages,
		compactionState: createSessionCompactionState({
			sourceMessages: input.messages,
			compactedMessages: result.messages,
			conversationId: input.sessionId,
			systemPrompt: result.systemPrompt,
		}),
		summary,
	};
}
