import type {
	ChatMessage as CoreChatMessage,
	ProviderListItem,
} from "@cline/core";

export type WebviewUsage = {
	inputTokens?: number;
	outputTokens?: number;
	cacheCreationInputTokens?: number;
	cacheReadInputTokens?: number;
	totalCost?: number;
};

export type WebviewProviderModel = {
	id: string;
	name: string;
	supportsReasoning?: boolean;
	contextWindow?: number;
	maxInputTokens?: number;
	maxTokens?: number;
	supportsThinking?: boolean;
};

export type WebviewProviderCatalogItem = ProviderListItem;

export type WebviewReasonLevel = "none" | "low" | "medium" | "high";

export type WebviewToolEvent = {
	toolCallId?: string;
	toolName?: string;
	status: "running" | "completed" | "failed";
	input?: unknown;
	output?: unknown;
	error?: string;
};

export type WebviewChatMessageBlock =
	| { id: string; type: "text"; text: string }
	| { id: string; type: "reasoning"; text: string; redacted?: boolean }
	| {
			id: string;
			type: "tool";
			toolEvent: NonNullable<WebviewChatMessage["toolEvents"]>[number];
	  };

export type WebviewChatMessage = Omit<
	CoreChatMessage,
	"content" | "createdAt" | "meta" | "role" | "sessionId"
> & {
	role:
		| Extract<CoreChatMessage["role"], "user" | "assistant" | "error">
		| "meta";
	text: string;
	reasoning?: string;
	reasoningRedacted?: boolean;
	checkpoint?: NonNullable<CoreChatMessage["meta"]>["checkpoint"];
	toolEvents?: Array<{
		id: string;
		toolCallId?: string;
		name: string;
		text: string;
		state: "input-available" | "output-available" | "output-error";
		input?: unknown;
		output?: unknown;
		error?: string;
		/** When the call started, so a running tool can show how long it has been going. */
		startedAt?: number;
	}>;
	blocks?: WebviewChatMessageBlock[];
};

export type WebviewConfig = {
	provider?: string;
	model?: string;
	mode?: "act" | "plan";
	systemPrompt?: string;
	maxIterations?: number;
	reasonLevel?: WebviewReasonLevel;
	enableTools?: boolean;
	enableSpawn?: boolean;
	enableTeams?: boolean;
	/**
	 * Start this session as a team manager: manager system prompt, no file or
	 * shell tools, delegation only.
	 */
	managerMode?: boolean;
	autoApproveTools?: boolean;
};

export type WebviewChatAttachments = {
	userImages?: string[];
};

export type WebviewToolApprovalRequest = {
	approvalId: string;
	sessionId: string;
	agentId: string;
	conversationId: string;
	iteration: number;
	toolCallId: string;
	toolName: string;
	input: unknown;
	policy?: Record<string, unknown>;
};

export type WebviewDefaults = {
	provider?: string;
	model?: string;
	workspaceRoot: string;
	cwd: string;
};

export type WebviewSessionSummary = {
	sessionId: string;
	title?: string;
	status?: string;
	source?: string;
	providerId?: string;
	model?: string;
	workspaceRoot?: string;
	createdAt?: number;
	updatedAt?: number;
	inputTokens?: number;
	outputTokens?: number;
	totalCost?: number;
};

export type WebviewConnectedClient = {
	clientId: string;
	displayName?: string;
	clientType: string;
	connectedAt: number;
};

export type WebviewClientSummary = {
	label: string;
	name: string;
	sessionCount: number;
};

export type WebviewConnectorField = {
	flag: string;
	label: string;
	placeholder?: string;
	required?: boolean;
	help?: string[];
	initialValue?: string;
	options?: Array<{ value: string; label: string; hint?: string }>;
	includeWhen?: {
		flag: string;
		equals?: string;
		notEquals?: string;
	};
};

export type WebviewConnectorSecurityField = {
	key: string;
	label: string;
	placeholder?: string;
	help?: string[];
	requiredMessage: string;
};

export type WebviewConnectorChannel = {
	id: string;
	name: string;
	type: "polling" | "webhook" | "hybrid";
	hint: string;
	fields: WebviewConnectorField[];
	security?: {
		prompt: string;
		fields: WebviewConnectorSecurityField[];
	};
};

export type WebviewActiveConnector = {
	id: string;
	type: string;
	pid: number;
	hubUrl: string;
	startedAt?: string;
	applicationId?: string;
	botUsername?: string;
	userName?: string;
	phoneNumberId?: string;
	port?: number;
	baseUrl?: string;
	connectionMode?: string;
};

export type WebviewConnectorChannelsResponse = {
	available: WebviewConnectorChannel[];
	active: WebviewActiveConnector[];
};

export type WebviewActionSessionSummary = {
	sessionId: string;
	title: string;
	status: string;
	workspaceRoot: string;
	workspaceName: string;
	cwd?: string;
	model?: string;
	provider?: string;
	createdAt: number;
	updatedAt: number;
	createdByClientId?: string;
	prompt?: string;
	inputTokens?: number;
	outputTokens?: number;
	totalCost?: number;
	agentCount: number;
};

export type WebviewHubEvent = {
	id: string;
	title: string;
	body: string;
	severity: "info" | "success" | "warn" | "error";
	timestamp: number;
};

export type WebviewHubState = {
	type: "hub_state";
	connected: boolean;
	hubUrl?: string;
	hubStartedAt?: string;
	coreVersion?: string;
	hubUptime?: string;
	clients: WebviewConnectedClient[];
	connectors: WebviewActiveConnector[];
	sessions: WebviewActionSessionSummary[];
	clientSummaries: WebviewClientSummary[];
	sessionSummaries: WebviewActionSessionSummary[];
	events: WebviewHubEvent[];
	lastWorkspaceRoot?: string;
};

export type WebviewTeamWorker = {
	agentId: string;
	rolePrompt: string;
	providerId?: string;
	modelId?: string;
	maxIterations?: number;
	status?: "idle" | "running" | "stopped";
};

export type WebviewTeamRoster = {
	/** Absolute path of the roster file, or where one would be written. */
	path: string;
	exists: boolean;
	error?: string;
	workers: WebviewTeamWorker[];
};

export type WebviewTeamTask = {
	id: string;
	title: string;
	description: string;
	status: "pending" | "in_progress" | "blocked" | "completed";
	assignee?: string;
	dependsOn: string[];
	summary?: string;
	updatedAt?: string;
};

export type WebviewTeamRun = {
	id: string;
	agentId: string;
	taskId?: string;
	status:
		| "queued"
		| "running"
		| "completed"
		| "failed"
		| "cancelled"
		| "interrupted";
	startedAt?: string;
	endedAt?: string;
	currentActivity?: string;
	lastProgressMessage?: string;
	error?: string;
	finishReason?: string;
	textPreview?: string;
};

export type WebviewTeamMissionLogEntry = {
	id: string;
	ts: string;
	agentId: string;
	taskId?: string;
	kind: string;
	summary: string;
	nextAction?: string;
};

export type WebviewTeamState = {
	type: "team_state";
	teamKey: string;
	roster: WebviewTeamRoster;
	/** Workers the runtime actually knows about, as opposed to declared ones. */
	workers: WebviewTeamWorker[];
	tasks: WebviewTeamTask[];
	runs: WebviewTeamRun[];
	missionLog: WebviewTeamMissionLogEntry[];
	error?: string;
};

export type WebviewInboundMessage =
	| { type: "ready" }
	| { type: "loadTeamState"; teamKey: string }
	| {
			type: "saveTeamRoster";
			path: string;
			workers: WebviewTeamWorker[];
	  }
	| { type: "restart_hub" }
	| {
			type: "desktopCommand";
			id: string;
			command: string;
			args?: Record<string, unknown>;
	  }
	| {
			type: "send";
			prompt: string;
			config?: WebviewConfig;
			attachments?: WebviewChatAttachments;
	  }
	| { type: "abort" }
	| { type: "reset" }
	| {
			type: "approval_response";
			approvalId: string;
			approved: boolean;
			reason?: string;
	  }
	| { type: "loadModels"; providerId: string }
	/**
	 * Re-send the enabled-provider list.
	 *
	 * It is pushed once during `ready`, which every view after the first misses.
	 * A view that needs the list to build a picker asks for it on mount.
	 */
	| { type: "loadProviders" }
	| { type: "loadProviderCatalog" }
	| {
			type: "saveProviderSettings";
			providerId: string;
			enabled?: boolean;
			apiKey?: string;
			baseUrl?: string;
	  }
	| { type: "runProviderOAuthLogin"; providerId: string }
	| { type: "attachSession"; sessionId: string }
	| { type: "deleteSession"; sessionId: string }
	| {
			type: "updateSessionMetadata";
			sessionId: string;
			metadata: Record<string, unknown>;
	  }
	| { type: "restore"; checkpointRunCount: number }
	| { type: "forkSession" };

export type WebviewOutboundMessage =
	| { type: "status"; text: string }
	| { type: "error"; text: string }
	| {
			type: "desktopCommandResult";
			id: string;
			ok: true;
			result: unknown;
	  }
	| {
			type: "desktopCommandResult";
			id: string;
			ok: false;
			error: string;
	  }
	| { type: "session_started"; sessionId: string }
	| {
			type: "session_hydrated";
			sessionId: string;
			status?: string;
			providerId?: string;
			modelId?: string;
			messages: WebviewChatMessage[];
	  }
	| { type: "assistant_delta"; text: string }
	| { type: "reasoning_delta"; text: string; redacted?: boolean }
	| { type: "tool_event"; text: string; event?: WebviewToolEvent }
	| ({ type: "approval_request" } & WebviewToolApprovalRequest)
	| {
			type: "approval_resolved";
			approvalId: string;
			approved: boolean;
			reason?: string;
	  }
	| {
			type: "turn_done";
			finishReason: string;
			iterations: number;
			usage?: WebviewUsage;
	  }
	| {
			type: "providers";
			providers: Array<
				Pick<ProviderListItem, "defaultModelId" | "enabled" | "id" | "name">
			>;
	  }
	| {
			type: "provider_catalog";
			providers: WebviewProviderCatalogItem[];
			settingsPath: string;
	  }
	| {
			type: "provider_settings_saved";
			providerId: string;
			enabled: boolean;
	  }
	| {
			type: "provider_oauth_login_done";
			providerId: string;
			accessTokenPresent: boolean;
	  }
	| { type: "models"; providerId: string; models: WebviewProviderModel[] }
	| { type: "sessions"; sessions: WebviewSessionSummary[] }
	| WebviewHubState
	| WebviewTeamState
	| { type: "team_roster_saved"; path: string }
	| { type: "defaults"; defaults: WebviewDefaults }
	| { type: "reset_done" }
	| {
			type: "fork_done";
			forkedFromSessionId: string;
			newSessionId: string;
	  }
	| { type: "fork_error"; text: string };
