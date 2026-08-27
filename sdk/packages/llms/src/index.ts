export { CLINE_DEFAULT_MODEL_ID } from "@cline/shared";
export type {
	ModelCollection,
	ModelIdAliasRule,
	ModelInfo,
	ModelInfo as CatalogModelInfo,
	ProviderCapability as CatalogProviderCapability,
	ProviderClient,
	ProviderInfo,
	ProviderProtocol,
} from "./models";
export {
	CODEX_EFFECTIVE_CONTEXT_WINDOW_PERCENT,
	fetchLiveProviderModels,
	fetchModelsDevProviderModels,
	filterOpenAICodexModels,
	getAllProviders,
	getGeneratedModelsForProvider,
	getGeneratedProviderModels,
	getModelsForProvider,
	getProvider,
	getProviderCollection,
	getProviderCollectionSync,
	getProviderIds,
	hasProvider,
	isCanonicalModelIdForAliasRules,
	MODEL_COLLECTIONS_BY_PROVIDER_ID,
	preferCanonicalModelIds,
	providerSkipsLiveCatalog,
	registerModel,
	registerProvider,
	resetRegistry,
	sortModelsByReleaseDate,
	unregisterModel,
	unregisterProvider,
	VERCEL_OPENROUTER_MODEL_ID_ALIAS_RULES,
} from "./models";
export type {
	ApiHandler,
	ApiStreamChunk,
	BuiltInProviderId,
	ContentBlock,
	FileContent,
	HandlerFactory,
	HandlerModelInfo,
	ImageContent,
	LazyHandlerFactory,
	Message,
	MessageRole,
	MessageWithMetadata,
	ProviderCapability,
	ProviderConfig,
	ProviderId,
	RedactedThinkingContent,
	TextContent,
	ThinkingContent,
	ToolDefinition,
	ToolResultContent,
	ToolUseContent,
} from "./providers";
export {
	BUILT_IN_PROVIDER,
	BUILT_IN_PROVIDER_IDS,
	ClineFreeModelLimitError,
	ClineNotSubscribedError,
	ClineOrgIndividualInferenceSubscriptionError,
	ClinePassLimitError,
	createHandler,
	createHandlerAsync,
	extractClineFreeModelLimitResetTime,
	extractClinePassLimitMessage,
	getClineNotSubscribedMessage,
	getClineOrgIndividualInferenceSubscriptionMessage,
	getClinePassSubscriptionUrl,
	getRegisteredHandler,
	getRegisteredHandlerAsync,
	hasRegisteredHandler,
	isBuiltInProviderId,
	isClineFreeModelLimitError,
	isClineFreeModelLimitMessage,
	isClineModelNotFoundMessage,
	isClineNotSubscribedError,
	isClineNotSubscribedMessage,
	isClineOrgIndividualInferenceSubscriptionError,
	isClineOrgIndividualInferenceSubscriptionMessage,
	isClinePassLimitError,
	isClinePassLimitMessage,
	isProviderApiLine,
	isRegisteredHandlerAsync,
	normalizeProviderId,
	OLLAMA_DEFAULT_CONTEXT_WINDOW,
	type ProviderApiLine,
	registerAsyncHandler,
	registerHandler,
	resolveProviderApiLineBaseUrl,
} from "./providers";
export {
	type ProviderUsageCostDisplay,
	resolveProviderUsageCostDisplay,
	shouldShowProviderUsageCost,
} from "./providers/billing";
export type * from "./providers/gateway";
export { createGateway, DefaultGateway } from "./providers/gateway";
export { resolveProviderModelCatalogKeys } from "./providers/provider-keys";
export {
	type OpenAICodexRequestHeaderContext,
	type ProviderRequestHeaderClientContext,
	type ProviderRequestHeaderLayers,
	type ResolveProviderRequestHeadersInput,
	resolveProviderRequestHeaders,
} from "./providers/request-headers";
export {
	type ChatGPTWebChatEntry,
	deleteChatGPTChatSession,
	listChatGPTWebChats,
	openChatGPTWebChat,
	resolveChatGPTWebV2Config,
} from "./providers/vendors/chatgpt-web";
export {
	type ClaudeWebChatEntry,
	deleteClaudeChatSession,
	listClaudeWebChats,
	openClaudeWebChat,
	resolveClaudeWebV2Config,
} from "./providers/vendors/claude-web";
// Web chat-session helpers (used by the CLI `/findchat` command).
export {
	type DeepSeekWebV2ChatEntry,
	deleteChatSession,
	listDeepSeekWebV2Chats,
	openDeepSeekWebV2Chat,
	resolveDeepSeekWebV2Config,
} from "./providers/vendors/deepseek-web-v2";
export {
	deleteGeminiChatSession,
	type GeminiWebChatEntry,
	listGeminiWebChats,
	openGeminiWebChat,
	resolveGeminiWebV2Config,
} from "./providers/vendors/gemini-web";
export {
	defaultModelsDir as llamaCppDefaultModelsDir,
	ensureLlamaCppRunning,
	readGgufContextLength,
	scanLocalModels as scanLlamaCppModels,
} from "./providers/vendors/llamacpp-runtime";
export {
	deleteQwenChatSession,
	listQwenWebChats,
	openQwenWebChat,
	type QwenWebChatEntry,
	resolveQwenWebV2Config,
} from "./providers/vendors/qwen-web";
// Chrome instances the web providers launched. The CLI shuts these down on
// exit so they stop holding their debug ports; local model runtimes (llamacpp)
// are deliberately left running.
export {
	listLaunchedBrowsers,
	shutdownLaunchedBrowsers,
} from "./providers/vendors/tool-pipeline/browser-processes";
// Explicit chat routing (used by compaction to send its summarize request
// into the web chat that actually holds the conversation).
export {
	bindChatKey,
	clearChatKeyBinding,
	clearChatKeyOverride,
	getBoundChatKey,
	useLastChatForNextCall,
} from "./providers/vendors/tool-pipeline/chat-target";
// Post-tool continuation note (the agent runtime appends it; the CLI `/note`
// command customises it per project).
export {
	DEFAULT_CONTINUATION_NOTE,
	getContinuationNote,
	isContinuationNoteText,
	resetContinuationNote,
	setContinuationNote,
} from "./providers/vendors/tool-pipeline/continuation-note";
// Manual reply injection (used by the CLI `/paste` command to recover a web
// provider turn whose reply was lost to a network error).
export {
	clearPendingInjectedReply,
	hasPendingInjectedReply,
	setPendingInjectedReply,
} from "./providers/vendors/tool-pipeline/injected-reply";
export { disposeLangfuseTelemetry } from "./services/langfuse-telemetry";
