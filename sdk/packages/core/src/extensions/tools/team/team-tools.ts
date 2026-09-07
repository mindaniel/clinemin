import type { AgentResult } from "@cline/shared";
import {
	type AgentTool,
	createTool,
	TEAM_AWAIT_TIMEOUT_MS,
	TEAM_RUN_MESSAGE_PREVIEW_LIMIT,
	TEAM_RUN_TEXT_PREVIEW_LIMIT,
	TEAM_TASK_IGNORED_FIELDS_BY_ACTION,
	type TeamAttachOutcomeFragmentInput,
	TeamAttachOutcomeFragmentInputSchema,
	type TeamAwaitRunsInput,
	TeamAwaitRunsInputSchema,
	type TeamBroadcastInput,
	TeamBroadcastInputSchema,
	TeamBroadcastToolResultSchema,
	type TeamCancelRunInput,
	TeamCancelRunInputSchema,
	TeamCancelRunToolResultSchema,
	type TeamCleanupInput,
	TeamCleanupInputSchema,
	TeamCleanupToolResultSchema,
	type TeamCreateOutcomeInput,
	TeamCreateOutcomeInputSchema,
	type TeamCreateOutcomeToolResult,
	TeamCreateOutcomeToolResultSchema,
	type TeamFinalizeOutcomeInput,
	TeamFinalizeOutcomeInputSchema,
	TeamFinalizeOutcomeToolResultSchema,
	type TeamListOutcomesInput,
	TeamListOutcomesInputSchema,
	type TeamListRunsInput,
	TeamListRunsInputSchema,
	type TeamMailboxMessageToolResult,
	TeamMailboxMessageToolResultSchema,
	type TeamMissionLogInput,
	TeamMissionLogInputSchema,
	TeamMissionLogToolResultSchema,
	TeamOutcomeFragmentToolResultSchema,
	type TeamOutcomeToolResult,
	TeamOutcomeToolResultSchema,
	type TeamReadMailboxInput,
	TeamReadMailboxInputSchema,
	type TeamReviewOutcomeFragmentInput,
	TeamReviewOutcomeFragmentInputSchema,
	type TeamRunRecord,
	type TeamRunResultSummary,
	type TeamRunTaskInput,
	TeamRunTaskInputSchema,
	type TeamRunTaskToolResult,
	TeamRunTaskToolResultSchema,
	type TeamRunToolSummary,
	TeamRunToolSummarySchema,
	type TeamRuntimeState,
	type TeamSendMessageInput,
	TeamSendMessageInputSchema,
	TeamSendMessageToolResultSchema,
	type TeamShutdownTeammateInput,
	TeamShutdownTeammateInputSchema,
	TeamSimpleAgentStatusToolResultSchema,
	type TeamSpawnTeammateInput,
	TeamSpawnTeammateInputSchema,
	type TeamStatusInput,
	TeamStatusInputSchema,
	type TeamStatusToolResult,
	TeamStatusToolResultSchema,
	type TeamTaskInput,
	TeamTaskInputSchema,
	type TeamTaskToolResult,
	TeamTaskToolResultSchema,
	type TeamTeammateSpec,
	validateWithZod,
	zodToJsonSchema,
} from "@cline/shared";
import { type AskQuestionInput, AskQuestionInputSchema } from "../schemas";
import {
	buildDelegatedAgentConfig,
	type DelegatedAgentConfigProvider,
	type DelegatedAgentRuntimeConfig,
} from "./delegated-agent";
import type { AgentTeamsRuntime } from "./multi-agent";

function truncateText(value: string, maxLength: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function requireInputField<T>(value: T | undefined, field: string): T {
	if (value === undefined) {
		throw new Error(`Missing required field: ${field}`);
	}
	return value;
}

/**
 * Completion and context-budget signals a lead needs to judge one teammate run.
 *
 * `finishReason` alone cannot answer "did the teammate actually finish?". A run
 * that ends because the model emitted plain prose — "Let me continue the job" —
 * reports `completed`, exactly like a run that finished its work. The only
 * reliable difference is whether the teammate ever called a tool that *means*
 * done, so completion is treated as explicit: no completion tool call, no
 * completion. That also catches a teammate whose tool call was malformed and
 * silently dropped by the provider's parser — it stops with prose, and the lead
 * sees it here instead of accepting the half-finished run.
 *
 * Every field is also restated in `note`, because a lead only acts on what it
 * reads, and a boolean buried in a JSON tool result is easy to skim past.
 */
interface RunDiagnostics {
	stoppedWithoutCompletion?: boolean;
	contextUsedTokens?: number;
	contextWindow?: number;
	contextUsedPct?: number;
	note?: string;
}

const COMPLETION_TOOL_NAMES = new Set([
	"submit_and_exit",
	"attempt_completion",
]);

/** Exported for tests: the context figure here is what a manager acts on. */
export function diagnoseRun(
	result: AgentResult,
	agentId: string,
): RunDiagnostics {
	// `run.result` is `unknown` on the record and cast on the way in, so every
	// field here is treated as possibly absent. When `toolCalls` is missing there
	// is no evidence either way, and claiming a run stopped early on missing
	// evidence would send the lead chasing teammates that did finish.
	const toolCalls = result.toolCalls;
	const hasCompletionTool = toolCalls?.some(
		(call) =>
			!call.error &&
			(COMPLETION_TOOL_NAMES.has(call.name) ||
				(call.name === "team_task" &&
					(call.input as { action?: string } | null)?.action === "complete")),
	);

	// Asking is not stalling. A worker that ended its run on `ask_question` did
	// so deliberately and its reply IS the question, so reporting it as "stopped
	// by replying with text" would tell the manager to chase it instead of
	// answering it.
	const askedAQuestion =
		toolCalls?.some((call) => !call.error && call.name === "ask_question") ===
		true;

	const stoppedWithoutCompletion =
		result.finishReason === "completed" &&
		hasCompletionTool === false &&
		!askedAQuestion;
	const contextWindow = result.model?.info?.contextWindow;
	// `result.usage` is the run's AGGREGATE: every iteration's input tokens
	// summed. That is not context, and reporting it as context is off by a
	// factor of the iteration count — a worker 132 iterations into a 141k
	// window was reported at "14.3M tokens", so the manager read it as
	// catastrophically over budget and killed a healthy worker mid-task.
	//
	// Context is what the LAST turn actually sent, so read it off the final
	// assistant message's own metrics. When no message carries them, say
	// nothing: an absent number sends the manager looking, a wrong one sends it
	// acting.
	const contextUsedTokens = [...(result.messages ?? [])]
		.reverse()
		.find(
			(message) =>
				message.role === "assistant" &&
				typeof message.metrics?.inputTokens === "number",
		)?.metrics?.inputTokens;
	const contextUsedPct =
		contextWindow && contextUsedTokens !== undefined
			? (contextUsedTokens / contextWindow) * 100
			: undefined;

	const noteParts: string[] = [];
	if (askedAQuestion) {
		noteParts.push(
			`${agentId} asked a question and is waiting on your answer; the task is NOT done. ` +
				"Answer it with team_run_task (continueConversation=true) so it picks up where it left off.",
		);
	}
	if (stoppedWithoutCompletion) {
		noteParts.push(
			`${agentId} stopped by replying with text instead of calling a completion tool, so the task is NOT confirmed done. ` +
				"Read its text below, then either send the next instruction with team_run_task (continueConversation=true) " +
				"or mark the shared task complete yourself if the work is actually finished.",
		);
	}
	if (contextUsedPct !== undefined && contextUsedPct >= 70) {
		noteParts.push(
			`${agentId} has used ${contextUsedPct.toFixed(0)}% of its ${contextWindow} token context. ` +
				"Prefer a fresh run (continueConversation=false) with a self-contained prompt over continuing this conversation.",
		);
	}

	return {
		...(stoppedWithoutCompletion ? { stoppedWithoutCompletion } : {}),
		...(contextUsedTokens !== undefined ? { contextUsedTokens } : {}),
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(contextUsedPct !== undefined ? { contextUsedPct } : {}),
		...(noteParts.length > 0 ? { note: noteParts.join(" ") } : {}),
	};
}

function summarizeRunResult(
	run: TeamRunRecord,
): TeamRunResultSummary | undefined {
	const result = run.result as AgentResult | undefined;
	if (!result) {
		return undefined;
	}

	return {
		textPreview: truncateText(result.text, TEAM_RUN_TEXT_PREVIEW_LIMIT),
		iterations: result.iterations,
		finishReason: result.finishReason,
		durationMs: result.durationMs,
		usage: {
			inputTokens: result.usage.inputTokens,
			outputTokens: result.usage.outputTokens,
			cacheReadTokens: result.usage.cacheReadTokens,
			cacheWriteTokens: result.usage.cacheWriteTokens,
			totalCost: result.usage.totalCost,
		},
		...diagnoseRun(result, run.agentId),
	};
}

function dateToIso(value: Date | undefined): string | undefined {
	return value?.toISOString();
}

function summarizeRun(
	run: TeamRunRecord,
	options?: { includeFullText?: boolean },
): TeamRunToolSummary {
	const result = run.result as AgentResult | undefined;
	return {
		...(options?.includeFullText && result ? { text: result.text } : {}),
		id: run.id,
		agentId: run.agentId,
		taskId: run.taskId,
		status: run.status,
		messagePreview: truncateText(run.message, TEAM_RUN_MESSAGE_PREVIEW_LIMIT),
		priority: run.priority,
		retryCount: run.retryCount,
		maxRetries: run.maxRetries,
		nextAttemptAt: dateToIso(run.nextAttemptAt),
		continueConversation: run.continueConversation,
		startedAt: run.startedAt.toISOString(),
		endedAt: dateToIso(run.endedAt),
		leaseOwner: run.leaseOwner,
		heartbeatAt: dateToIso(run.heartbeatAt),
		lastProgressAt: dateToIso(run.lastProgressAt),
		lastProgressMessage: run.lastProgressMessage,
		currentActivity: run.currentActivity,
		error: run.error,
		resultSummary: summarizeRunResult(run),
	};
}

function assertAwaitedRunSucceeded(run: TeamRunRecord): void {
	if (run.status === "failed") {
		throw new Error(
			`Run "${run.id}" failed${run.error ? `: ${run.error}` : ""}`,
		);
	}
	if (run.status === "cancelled") {
		throw new Error(
			`Run "${run.id}" was cancelled${run.error ? `: ${run.error}` : ""}`,
		);
	}
	if (run.status === "interrupted") {
		throw new Error(
			`Run "${run.id}" was interrupted${run.error ? `: ${run.error}` : ""}`,
		);
	}
}

export type TeamTeammateRuntimeConfig = DelegatedAgentRuntimeConfig;

export interface CreateAgentTeamsToolsOptions {
	runtime: AgentTeamsRuntime;
	requesterId: string;
	teammateConfigProvider: DelegatedAgentConfigProvider;
	/**
	 * Build the non-team tools for an agent.
	 *
	 * Takes the agent's own provider and model, because tool construction reads
	 * both: command timeouts are raised for claude-web, and the edit tool is
	 * chosen by model id. Building every teammate's tools from the lead's
	 * provider gave a worker on one provider the budget and routing of another
	 * — a manager on claude-web silently handed all its workers a 20-minute
	 * command timeout, so one bad search ran for twenty minutes.
	 */
	createBaseTools?: (agent?: {
		providerId?: string;
		modelId?: string;
	}) => AgentTool[];
	allowSpawn?: boolean;
	includeSpawnTool?: boolean;
	includeManagementTools?: boolean;
	onLeadToolsUnlocked?: (tools: AgentTool[]) => void;
}

export interface BootstrapAgentTeamsOptions {
	runtime: AgentTeamsRuntime;
	teammateConfigProvider: DelegatedAgentConfigProvider;
	createBaseTools?: (agent?: {
		providerId?: string;
		modelId?: string;
	}) => AgentTool[];
	leadAgentId?: string;
	restoredTeammates?: TeamTeammateSpec[];
	restoredFromPersistence?: boolean;
	includeLeadSpawnTool?: boolean;
	includeLeadManagementTools?: boolean;
	onLeadToolsUnlocked?: (tools: AgentTool[]) => void;
}

export interface BootstrapAgentTeamsResult {
	tools: AgentTool[];
	restoredFromPersistence: boolean;
	restoredTeammates: string[];
}

export const TEAM_TOOL_NAMES = [
	"team_spawn_teammate",
	"team_shutdown_teammate",
	"team_status",
	"team_task",
	"team_run_task",
	"team_cancel_run",
	"team_list_runs",
	"team_await_runs",
	"team_send_message",
	"team_broadcast",
	"team_read_mailbox",
	"team_mission_log",
	"team_cleanup",
	"team_create_outcome",
	"team_attach_outcome_fragment",
	"team_review_outcome_fragment",
	"team_finalize_outcome",
	"team_list_outcomes",
] as const;

/**
 * A worker's `ask_question`, pointed at its manager instead of the user.
 *
 * A delegated worker has no user in front of it — its manager wrote the task,
 * and the manager is the one who knows the answer. Without this the worker
 * reaches for the host's `ask_question` (which asks a human who is not
 * watching) or, on a host that has no such tool, gets its call rejected as
 * unavailable and burns turns re-emitting it.
 *
 * Asking ends the run, because a sync `team_run_task` is holding the manager
 * still while the worker works: nobody can answer until the worker stops. The
 * question comes back as the run's result, the manager answers it, and its
 * next message continues the same worker conversation.
 */
function createTeammateAskQuestionTool(agentId: string): AgentTool {
	return createTool<AskQuestionInput, string>({
		name: "ask_question",
		description:
			"Ask your manager a question when the task is ambiguous and you cannot " +
			"safely pick for yourself. Provide 2-5 options. This ends your turn: " +
			"the manager answers and sends you the next instruction, so ask only " +
			"when you genuinely cannot continue without the answer.",
		inputSchema: zodToJsonSchema(AskQuestionInputSchema),
		lifecycle: {
			completesRun: true,
		},
		retryable: false,
		maxRetries: 0,
		execute: async (input) => {
			const validatedInput = validateWithZod(AskQuestionInputSchema, input);
			const lines = [
				`${agentId} needs an answer before it can continue.`,
				"",
				validatedInput.question,
			];
			for (const option of validatedInput.options ?? []) {
				lines.push(`- ${option}`);
			}
			return lines.join("\n");
		},
	}) as AgentTool;
}

/**
 * Aliases a manager is likely to write for a tool's real name.
 *
 * A manager is told what its workers can do in plain language, so it reaches
 * for "read" or "bash" rather than the exact registered name. Rejecting those
 * would make capability grants fail in a way that looks like the tool is
 * missing.
 */
const TEAMMATE_TOOL_ALIASES: Record<string, string> = {
	bash: "run_commands",
	edit: "editor",
	execute_command: "run_commands",
	grep: "search_codebase",
	read: "read_files",
	read_file: "read_files",
	run_command: "run_commands",
	search: "search_codebase",
	search_files: "search_codebase",
	shell: "run_commands",
	terminal: "run_commands",
	web: "fetch_web_content",
	write: "editor",
};

/**
 * Cut a teammate's tools down to what it was granted.
 *
 * Team tools always survive, because a worker that cannot report back or ask a
 * question is not scoped, it is mute. Everything else is opt-in: a worker whose
 * job is to read gets no `editor` and no `run_commands`, so "do not edit
 * anything" stops being a request the worker can talk itself out of.
 *
 * An empty list is a real grant meaning "team tools only". `undefined` means
 * the worker was never scoped and keeps everything.
 */
function applyTeammateToolScope(
	tools: AgentTool[],
	allowed: string[] | undefined,
): AgentTool[] {
	if (allowed === undefined) {
		return tools;
	}
	const allowedNames = new Set(
		allowed
			.map((name) => name.trim().toLowerCase())
			.filter((name) => name.length > 0)
			.map((name) => TEAMMATE_TOOL_ALIASES[name] ?? name),
	);
	// `editor` and `apply_patch` are one grant: "this worker may change files".
	// Which of them the session actually built is decided by tool routing from
	// the worker's own provider, which the roster does not know and should not
	// have to. Asking for the wrong name would otherwise scope the worker down
	// to no edit tool at all, silently.
	if (allowedNames.has("editor") || allowedNames.has("apply_patch")) {
		allowedNames.add("editor");
		allowedNames.add("apply_patch");
	}
	return tools.filter(
		(tool) =>
			tool.name.startsWith("team_") ||
			tool.name === "ask_question" ||
			allowedNames.has(tool.name),
	);
}

/**
 * The spec each teammate was last spawned with, keyed by its team runtime.
 *
 * Re-scoping a running worker means rebuilding its tools, and rebuilding needs
 * everything else about it — role prompt, provider, model — unchanged, so the
 * spec is kept rather than asking the manager to restate it.
 *
 * Keyed by runtime, not by agent id alone: the hub daemon serves many sessions
 * at once and "extractor" in one team is not "extractor" in another.
 */
const spawnedSpecsByRuntime = new WeakMap<
	object,
	Map<string, TeamTeammateSpec>
>();

function rememberSpawnedSpec(runtime: object, spec: TeamTeammateSpec): void {
	let specs = spawnedSpecsByRuntime.get(runtime);
	if (!specs) {
		specs = new Map();
		spawnedSpecsByRuntime.set(runtime, specs);
	}
	specs.set(spec.agentId, spec);
}

/**
 * The full tool set a teammate runs with: its scoped base tools, its own
 * `ask_question`, and the team tools it needs to report back.
 *
 * Shared by spawning and re-scoping so a re-scope cannot accidentally strip the
 * team tools and leave a worker unable to answer anyone.
 */
function buildTeammateTools(
	options: Omit<CreateAgentTeamsToolsOptions, "requesterId" | "allowSpawn">,
	spec: TeamTeammateSpec,
): AgentTool[] {
	const tools: AgentTool[] = [];
	if (options.createBaseTools) {
		tools.push(
			// The host's own `ask_question` asks a human. A worker's questions
			// belong to its manager, so that one is dropped in favour of the
			// escalating version below.
			...applyTeammateToolScope(
				options
					.createBaseTools({
						providerId: spec.providerId,
						modelId: spec.modelId,
					})
					.filter((tool) => tool.name !== "ask_question"),
				spec.tools,
			),
		);
	}
	tools.push(createTeammateAskQuestionTool(spec.agentId));
	tools.push(
		...createAgentTeamsTools({
			runtime: options.runtime,
			requesterId: spec.agentId,
			teammateConfigProvider: options.teammateConfigProvider,
			createBaseTools: options.createBaseTools,
			allowSpawn: false,
			// Spawning is lead-only; exposing the tool to teammates just
			// makes them burn turns on "Only the lead agent can manage
			// teammates." rejections.
			includeSpawnTool: false,
		}),
	);
	return tools;
}

/**
 * Apply a `tools` grant to a live teammate.
 *
 * Returns a line for the manager either way. A grant that quietly failed —
 * because the worker is not running, or the session builds no base tools — is
 * worse than one that was refused out loud: the manager would go on believing
 * a worker could edit, and the worker would keep saying it cannot.
 */
function rescopeTeammateTools(
	options: Omit<CreateAgentTeamsToolsOptions, "requesterId" | "allowSpawn">,
	agentId: string,
	tools: string[],
): string {
	const spec = spawnedSpecsByRuntime.get(options.runtime)?.get(agentId);
	if (!spec) {
		return `Could not re-scope ${agentId}: no such teammate is running.`;
	}
	const next: TeamTeammateSpec = { ...spec, tools };
	rememberSpawnedSpec(options.runtime, next);
	const rebuilt = buildTeammateTools(options, next);
	const applied = options.runtime.setTeammateTools(agentId, rebuilt);
	const granted = rebuilt
		.map((tool) => tool.name)
		.filter((name) => !name.startsWith("team_") && name !== "ask_question");
	if (!applied) {
		return `${agentId} is not running right now; the new scope applies the next time it starts.`;
	}
	return granted.length > 0
		? `${agentId} can now use: ${granted.join(", ")}.`
		: `${agentId} now has no tools beyond reporting back and asking questions.`;
}

function spawnTeamTeammate(
	options: Omit<CreateAgentTeamsToolsOptions, "requesterId" | "allowSpawn"> & {
		requesterId: string;
		spec: TeamTeammateSpec;
	},
): void {
	rememberSpawnedSpec(options.runtime, options.spec);
	const teammateTools = buildTeammateTools(options, options.spec);
	options.runtime.spawnTeammate({
		agentId: options.spec.agentId,
		tools: options.spec.tools,
		config: buildDelegatedAgentConfig({
			kind: "teammate",
			prompt: options.spec.rolePrompt,
			role: options.spec.rolePrompt,
			configProvider: options.teammateConfigProvider,
			tools: teammateTools,
			maxIterations: options.spec.maxIterations,
			cwd: options.teammateConfigProvider.getRuntimeConfig().cwd,
			// What the worker ended up holding, not what the roster asked for. The
			// two differ whenever routing swapped its edit tool, and the prompt
			// documenting the wrong name is the same failure as not granting it.
			toolScope: options.spec.tools
				? teammateTools.map((tool) => tool.name)
				: undefined,
			connectionOverrides: Object.fromEntries(
				Object.entries({
					providerId: options.spec.providerId,
					modelId: options.spec.modelId,
				}).filter(([, value]) => value !== undefined),
			),
		}),
	});
}

export function bootstrapAgentTeams(
	options: BootstrapAgentTeamsOptions,
): BootstrapAgentTeamsResult {
	const leadAgentId = options.leadAgentId ?? "lead";
	const restoredFromPersistence = options.restoredFromPersistence === true;

	const tools = createAgentTeamsTools({
		runtime: options.runtime,
		requesterId: leadAgentId,
		teammateConfigProvider: options.teammateConfigProvider,
		createBaseTools: options.createBaseTools,
		allowSpawn: true,
		includeSpawnTool: options.includeLeadSpawnTool,
		includeManagementTools: options.includeLeadManagementTools,
		onLeadToolsUnlocked: options.onLeadToolsUnlocked,
	});

	const restoredTeammates: string[] = [];
	for (const spec of options.restoredTeammates ?? []) {
		if (options.runtime.isTeammateActive(spec.agentId)) {
			continue;
		}
		spawnTeamTeammate({
			runtime: options.runtime,
			requesterId: leadAgentId,
			teammateConfigProvider: options.teammateConfigProvider,
			createBaseTools: options.createBaseTools,
			spec,
		});
		restoredTeammates.push(spec.agentId);
	}

	return {
		tools,
		restoredFromPersistence,
		restoredTeammates,
	};
}

export function createAgentTeamsTools(
	options: CreateAgentTeamsToolsOptions,
): AgentTool[] {
	const allowSpawn = options.allowSpawn ?? true;
	const includeSpawnTool = options.includeSpawnTool ?? true;
	const includeManagementTools = options.includeManagementTools ?? true;
	const tools: AgentTool[] = [];

	if (includeSpawnTool) {
		tools.push(
			createTool<TeamSpawnTeammateInput, { agentId: string; status: string }>({
				name: "team_spawn_teammate",
				description: "Spawn a teammate with a required agentId and rolePrompt.",
				inputSchema: zodToJsonSchema(TeamSpawnTeammateInputSchema),
				execute: async (input) => {
					const validatedInput = validateWithZod(
						TeamSpawnTeammateInputSchema,
						input,
					);
					if (options.runtime.getMemberRole(options.requesterId) !== "lead") {
						throw new Error("Only the lead agent can manage teammates.");
					}
					if (!allowSpawn) {
						throw new Error("Spawning teammates is disabled in this context.");
					}
					const spec: TeamTeammateSpec = {
						agentId: validatedInput.agentId,
						rolePrompt: validatedInput.rolePrompt,
						providerId: validatedInput.providerId,
						modelId: validatedInput.modelId,
						tools: validatedInput.tools,
					};
					spawnTeamTeammate({
						runtime: options.runtime,
						requesterId: options.requesterId,
						teammateConfigProvider: options.teammateConfigProvider,
						createBaseTools: options.createBaseTools,
						spec,
					});
					if (!includeManagementTools) {
						options.onLeadToolsUnlocked?.(
							createAgentTeamsTools({
								...options,
								includeSpawnTool: false,
								includeManagementTools: true,
								onLeadToolsUnlocked: undefined,
							}),
						);
					}
					return validateWithZod(TeamSimpleAgentStatusToolResultSchema, {
						agentId: validatedInput.agentId,
						status: "spawned",
					});
				},
			}) as AgentTool,
		);
	}

	if (!includeManagementTools) {
		return tools;
	}

	tools.push(
		createTool<TeamShutdownTeammateInput, { agentId: string; status: string }>({
			name: "team_shutdown_teammate",
			description: "Shutdown a teammate by agentId.",
			inputSchema: zodToJsonSchema(TeamShutdownTeammateInputSchema),
			execute: async (input) => {
				const validatedInput = validateWithZod(
					TeamShutdownTeammateInputSchema,
					input,
				);
				if (options.runtime.getMemberRole(options.requesterId) !== "lead") {
					throw new Error("Only the lead agent can manage teammates.");
				}
				options.runtime.shutdownTeammate(
					validatedInput.agentId,
					validatedInput.reason,
				);
				return validateWithZod(TeamSimpleAgentStatusToolResultSchema, {
					agentId: validatedInput.agentId,
					status: "stopped",
				});
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<TeamStatusInput, TeamStatusToolResult>({
			name: "team_status",
			description:
				"Return a snapshot of team members, task counts, mailbox, and mission log stats.",
			inputSchema: zodToJsonSchema(TeamStatusInputSchema),
			execute: async (input) => {
				validateWithZod(TeamStatusInputSchema, input);
				return validateWithZod(
					TeamStatusToolResultSchema,
					options.runtime.getSnapshot(),
				);
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<TeamTaskInput, TeamTaskToolResult>({
			name: "team_task",
			description:
				"Manage shared team tasks with action-specific payloads. " +
				"create requires title and description, with optional dependsOn and assignee. " +
				"list accepts optional status, assignee. " +
				"claim requires taskId. complete requires taskId and summary. block requires taskId and reason. " +
				"Do not include fields from other actions.",
			inputSchema: zodToJsonSchema(TeamTaskInputSchema),
			execute: async (input) => {
				const validatedInput = validateWithZod(TeamTaskInputSchema, input);
				switch (validatedInput.action) {
					case "create": {
						const ignoredFieldSet = new Set(
							TEAM_TASK_IGNORED_FIELDS_BY_ACTION.create ?? [],
						);
						const ignoredFields = Object.entries(
							input as Record<string, unknown>,
						)
							.filter(
								([field, value]) => ignoredFieldSet.has(field) && value != null,
							)
							.map(([field]) => field);
						const task = options.runtime.createTask({
							title: requireInputField(validatedInput.title, "title"),
							description: requireInputField(
								validatedInput.description,
								"description",
							),
							dependsOn: validatedInput.dependsOn,
							assignee: validatedInput.assignee,
							createdBy: options.requesterId,
						});
						return validateWithZod(TeamTaskToolResultSchema, {
							action: "create",
							taskId: task.id,
							status: task.status,
							...(ignoredFields.length > 0
								? {
										ignoredFields,
										note: `Ignored fields for action=create: ${ignoredFields.join(", ")}`,
									}
								: {}),
						});
					}
					case "list":
						return validateWithZod(TeamTaskToolResultSchema, {
							action: "list",
							tasks: options.runtime.listTaskItems({
								status: validatedInput.status,
								assignee: validatedInput.assignee,
							}),
						});
					case "claim": {
						const task = options.runtime.claimTask(
							requireInputField(validatedInput.taskId, "taskId"),
							options.requesterId,
						);
						return validateWithZod(TeamTaskToolResultSchema, {
							action: "claim",
							taskId: task.id,
							status: task.status,
							nextStep:
								"Task is now in_progress. Execute the work using team_run_task or your own tools, then call team_task with action=complete when done.",
						});
					}
					case "complete": {
						const task = options.runtime.completeTask(
							requireInputField(validatedInput.taskId, "taskId"),
							options.requesterId,
							requireInputField(validatedInput.summary, "summary"),
						);
						return validateWithZod(TeamTaskToolResultSchema, {
							action: "complete",
							taskId: task.id,
							status: task.status,
						});
					}
					case "block": {
						const task = options.runtime.blockTask(
							requireInputField(validatedInput.taskId, "taskId"),
							options.requesterId,
							requireInputField(validatedInput.reason, "reason"),
						);
						return validateWithZod(TeamTaskToolResultSchema, {
							action: "block",
							taskId: task.id,
							status: task.status,
						});
					}
				}
			},
		}) as AgentTool,
	);

	// Track in-flight sync runs per agent for dedup
	// (Claude sometimes emits duplicate tool_use blocks in a single response;
	//  duplicate sync calls should await the first dispatched run)
	const pendingSyncRuns = new Map<string, Promise<TeamRunTaskToolResult>>();

	tools.push(
		createTool<TeamRunTaskInput, TeamRunTaskToolResult>({
			name: "team_run_task",
			description:
				"Route a delegated task to a teammate. Choose sync (wait) or async (run in background).",
			inputSchema: zodToJsonSchema(TeamRunTaskInputSchema),
			execute: async (input) => {
				const validatedInput = validateWithZod(TeamRunTaskInputSchema, input);
				if (validatedInput.runMode === "async") {
					const run = options.runtime.startTeammateRun(
						validatedInput.agentId,
						validatedInput.task,
						{
							taskId: validatedInput.taskId || undefined,
							fromAgentId: options.requesterId,
							continueConversation:
								validatedInput.continueConversation || undefined,
						},
					);
					return validateWithZod(TeamRunTaskToolResultSchema, {
						agentId: validatedInput.agentId,
						mode: "async",
						status: "queued",
						dispatched: true,
						message: `Task dispatched to ${validatedInput.agentId} and queued as ${run.id}.`,
						runId: run.id,
					});
				}

				// A `tools` grant is applied before the run, so the worker starts
				// this task with exactly the capability the manager just gave it.
				const rescopeNote = validatedInput.tools
					? rescopeTeammateTools(
							options,
							validatedInput.agentId,
							validatedInput.tools,
						)
					: undefined;

				// Deduplication guard: collapse a duplicate sync call for the same
				// agent onto the first in-flight dispatch in this parallel tool-call batch.
				const pendingRun = pendingSyncRuns.get(validatedInput.agentId);
				if (pendingRun) {
					const result = await pendingRun;
					return validateWithZod(TeamRunTaskToolResultSchema, {
						...result,
						status: "joined",
						deduped: true,
						message: `Task for ${validatedInput.agentId} was already dispatched in this tool batch; joined the existing in-flight run.`,
					});
				}
				const runPromise = options.runtime
					.routeToTeammate(validatedInput.agentId, validatedInput.task, {
						taskId: validatedInput.taskId || undefined,
						fromAgentId: options.requesterId,
						continueConversation:
							validatedInput.continueConversation || undefined,
					})
					.then((result) => {
						const diagnostics = diagnoseRun(result, validatedInput.agentId);

						// `message` is the line the lead reads first, so it has to state
						// the outcome rather than the dispatch. Saying "completed" over a
						// run that stopped on prose is what let a half-done teammate pass
						// for a finished one.
						const outcome = diagnostics.stoppedWithoutCompletion
							? `${validatedInput.agentId} returned text without confirming completion. Evaluate its reply before treating the task as done.`
							: `Task dispatched to ${validatedInput.agentId} and completed in sync mode.`;
						const message = rescopeNote ? `${rescopeNote} ${outcome}` : outcome;

						return validateWithZod(TeamRunTaskToolResultSchema, {
							agentId: validatedInput.agentId,
							mode: "sync" as const,
							status: "running" as const,
							dispatched: true,
							message,
							text: result.text,
							iterations: result.iterations,
							...diagnostics,
						});
					})
					.finally(() => {
						pendingSyncRuns.delete(validatedInput.agentId);
					});
				pendingSyncRuns.set(validatedInput.agentId, runPromise);
				return await runPromise;
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<TeamCancelRunInput, { runId: string; status: string }>({
			name: "team_cancel_run",
			description: "Cancel one async teammate run.",
			inputSchema: zodToJsonSchema(TeamCancelRunInputSchema),
			execute: async (input) => {
				const validatedInput = validateWithZod(TeamCancelRunInputSchema, input);
				const run = options.runtime.cancelRun(
					validatedInput.runId,
					validatedInput.reason,
				);
				return validateWithZod(TeamCancelRunToolResultSchema, {
					runId: run.id,
					status: run.status,
				});
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<TeamListRunsInput, TeamRunToolSummary[]>({
			name: "team_list_runs",
			description:
				"List teammate runs started with team_run_task in async mode, including live activity/progress fields when available.",
			inputSchema: zodToJsonSchema(TeamListRunsInputSchema),
			execute: async (input) =>
				validateWithZod(
					TeamRunToolSummarySchema.array(),
					options.runtime
						.listRuns(validateWithZod(TeamListRunsInputSchema, input))
						// No full text here: listing is a status poll, and one call can
						// return every run in the team.
						.map((run) => summarizeRun(run)),
				),
		}) as AgentTool,
	);

	tools.push(
		createTool<TeamAwaitRunsInput, TeamRunToolSummary | TeamRunToolSummary[]>({
			name: "team_await_runs",
			description:
				"Wait for async teammate runs. Provide runId to wait for one run, or omit it to wait for all active async runs. Uses a long timeout for legitimate teammate work.",
			inputSchema: zodToJsonSchema(TeamAwaitRunsInputSchema),
			timeoutMs: TEAM_AWAIT_TIMEOUT_MS,
			execute: async (input) => {
				const validatedInput = validateWithZod(TeamAwaitRunsInputSchema, input);
				if (validatedInput.runId) {
					const run = await options.runtime.awaitRun(validatedInput.runId);
					assertAwaitedRunSucceeded(run);
					return validateWithZod(
						TeamRunToolSummarySchema,
						summarizeRun(run, { includeFullText: true }),
					);
				}
				const runs = await options.runtime.awaitAllRuns();
				const failedRuns = runs.filter((run) =>
					["failed", "cancelled", "interrupted"].includes(run.status),
				);
				if (failedRuns.length > 0) {
					const details = failedRuns
						.map(
							(run) =>
								`${run.id}:${run.status}${run.error ? `(${run.error})` : ""}`,
						)
						.join(", ");
					throw new Error(
						`One or more runs did not complete successfully: ${details}`,
					);
				}
				return validateWithZod(
					TeamRunToolSummarySchema.array(),
					runs.map((run) => summarizeRun(run, { includeFullText: true })),
				);
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<TeamSendMessageInput, { id: string; toAgentId: string }>({
			name: "team_send_message",
			description: "Send a mailbox message to a specific teammate.",
			inputSchema: zodToJsonSchema(TeamSendMessageInputSchema),
			execute: async (input) => {
				const validatedInput = validateWithZod(
					TeamSendMessageInputSchema,
					input,
				);
				const message = options.runtime.sendMessage(
					options.requesterId,
					validatedInput.toAgentId,
					validatedInput.subject,
					validatedInput.body,
					validatedInput.taskId ?? undefined,
				);
				return validateWithZod(TeamSendMessageToolResultSchema, {
					id: message.id,
					toAgentId: message.toAgentId,
				});
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<TeamBroadcastInput, { delivered: number }>({
			name: "team_broadcast",
			description: "Broadcast a message to all teammates.",
			inputSchema: zodToJsonSchema(TeamBroadcastInputSchema),
			execute: async (input) => {
				const validatedInput = validateWithZod(TeamBroadcastInputSchema, input);
				const messages = options.runtime.broadcast(
					options.requesterId,
					validatedInput.subject,
					validatedInput.body,
					{
						taskId: validatedInput.taskId ?? undefined,
					},
				);
				return validateWithZod(TeamBroadcastToolResultSchema, {
					delivered: messages.length,
				});
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<TeamReadMailboxInput, TeamMailboxMessageToolResult[]>({
			name: "team_read_mailbox",
			description: "Read the current agent mailbox.",
			inputSchema: zodToJsonSchema(TeamReadMailboxInputSchema),
			execute: async (input) => {
				const validatedInput = validateWithZod(
					TeamReadMailboxInputSchema,
					input,
				);
				return validateWithZod(
					TeamMailboxMessageToolResultSchema.array(),
					options.runtime.listMailbox(options.requesterId, {
						unreadOnly: validatedInput.unreadOnly,
						markRead: true,
					}),
				);
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<TeamMissionLogInput, { id: string }>({
			name: "team_mission_log",
			description: "Append a mission log update for your team.",
			inputSchema: zodToJsonSchema(TeamMissionLogInputSchema),
			execute: async (input) => {
				const validatedInput = validateWithZod(
					TeamMissionLogInputSchema,
					input,
				);
				const entry = options.runtime.appendMissionLog({
					agentId: options.requesterId,
					taskId: validatedInput.taskId || undefined,
					kind: validatedInput.kind,
					summary: validatedInput.summary,
					evidence: validatedInput.evidence?.length
						? validatedInput.evidence
						: undefined,
					nextAction: validatedInput.nextAction || undefined,
				});
				return validateWithZod(TeamMissionLogToolResultSchema, {
					id: entry.id,
				});
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<TeamCleanupInput, { status: string }>({
			name: "team_cleanup",
			description:
				"Clean up the team runtime. Fails if teammates are still running.",
			inputSchema: zodToJsonSchema(TeamCleanupInputSchema),
			execute: async (input) => {
				validateWithZod(TeamCleanupInputSchema, input);
				if (options.runtime.getMemberRole(options.requesterId) !== "lead") {
					throw new Error("Only the lead agent can run cleanup.");
				}
				options.runtime.cleanup();
				return validateWithZod(TeamCleanupToolResultSchema, {
					status: "cleaned",
				});
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<TeamCreateOutcomeInput, TeamCreateOutcomeToolResult>({
			name: "team_create_outcome",
			description: "Create a converged team outcome.",
			inputSchema: zodToJsonSchema(TeamCreateOutcomeInputSchema),
			execute: async (input) => {
				const validatedInput = validateWithZod(
					TeamCreateOutcomeInputSchema,
					input,
				);
				const outcome = options.runtime.createOutcome({
					title: validatedInput.title,
					requiredSections: validatedInput.requiredSections,
					createdBy: options.requesterId,
				});
				return validateWithZod(TeamCreateOutcomeToolResultSchema, {
					outcomeId: outcome.id,
					status: outcome.status,
					requiredSections: outcome.requiredSections,
				});
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			TeamAttachOutcomeFragmentInput,
			{ fragmentId: string; status: string }
		>({
			name: "team_attach_outcome_fragment",
			description: "Attach a fragment to an outcome section.",
			inputSchema: zodToJsonSchema(TeamAttachOutcomeFragmentInputSchema),
			execute: async (input) => {
				const validatedInput = validateWithZod(
					TeamAttachOutcomeFragmentInputSchema,
					input,
				);
				const fragment = options.runtime.attachOutcomeFragment({
					outcomeId: validatedInput.outcomeId,
					section: validatedInput.section,
					sourceAgentId: options.requesterId,
					sourceRunId: validatedInput.sourceRunId || undefined,
					content: validatedInput.content,
				});
				return validateWithZod(TeamOutcomeFragmentToolResultSchema, {
					fragmentId: fragment.id,
					status: fragment.status,
				});
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			TeamReviewOutcomeFragmentInput,
			{ fragmentId: string; status: string }
		>({
			name: "team_review_outcome_fragment",
			description: "Review one outcome fragment.",
			inputSchema: zodToJsonSchema(TeamReviewOutcomeFragmentInputSchema),
			execute: async (input) => {
				const validatedInput = validateWithZod(
					TeamReviewOutcomeFragmentInputSchema,
					input,
				);
				const fragment = options.runtime.reviewOutcomeFragment({
					fragmentId: validatedInput.fragmentId,
					reviewedBy: options.requesterId,
					approved: validatedInput.approved,
				});
				return validateWithZod(TeamOutcomeFragmentToolResultSchema, {
					fragmentId: fragment.id,
					status: fragment.status,
				});
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<TeamFinalizeOutcomeInput, { outcomeId: string; status: string }>(
			{
				name: "team_finalize_outcome",
				description: "Finalize one outcome.",
				inputSchema: zodToJsonSchema(TeamFinalizeOutcomeInputSchema),
				execute: async (input) => {
					const validatedInput = validateWithZod(
						TeamFinalizeOutcomeInputSchema,
						input,
					);
					const outcome = options.runtime.finalizeOutcome(
						validatedInput.outcomeId,
					);
					return validateWithZod(TeamFinalizeOutcomeToolResultSchema, {
						outcomeId: outcome.id,
						status: outcome.status,
					});
				},
			},
		) as AgentTool,
	);

	tools.push(
		createTool<TeamListOutcomesInput, TeamOutcomeToolResult[]>({
			name: "team_list_outcomes",
			description: "List team outcomes.",
			inputSchema: zodToJsonSchema(TeamListOutcomesInputSchema),
			execute: async (input) => {
				validateWithZod(TeamListOutcomesInputSchema, input);
				return validateWithZod(
					TeamOutcomeToolResultSchema.array(),
					options.runtime.listOutcomes(),
				);
			},
		}) as AgentTool,
	);

	return tools;
}

export function reviveTeamStateDates(
	state: TeamRuntimeState,
): TeamRuntimeState {
	return {
		...state,
		tasks: state.tasks.map((task) => ({
			...task,
			createdAt: new Date(task.createdAt),
			updatedAt: new Date(task.updatedAt),
		})),
		mailbox: state.mailbox.map((message) => ({
			...message,
			sentAt: new Date(message.sentAt),
			readAt: message.readAt ? new Date(message.readAt) : undefined,
		})),
		missionLog: state.missionLog.map((entry) => ({
			...entry,
			ts: new Date(entry.ts),
		})),
		runs: (state.runs ?? []).map((run) => ({
			...run,
			startedAt: new Date(run.startedAt),
			endedAt: run.endedAt ? new Date(run.endedAt) : undefined,
			nextAttemptAt: run.nextAttemptAt
				? new Date(run.nextAttemptAt)
				: undefined,
			heartbeatAt: run.heartbeatAt ? new Date(run.heartbeatAt) : undefined,
		})),
		outcomes: (state.outcomes ?? []).map((outcome) => ({
			...outcome,
			createdAt: new Date(outcome.createdAt),
			finalizedAt: outcome.finalizedAt
				? new Date(outcome.finalizedAt)
				: undefined,
		})),
		outcomeFragments: (state.outcomeFragments ?? []).map((fragment) => ({
			...fragment,
			createdAt: new Date(fragment.createdAt),
			reviewedAt: fragment.reviewedAt
				? new Date(fragment.reviewedAt)
				: undefined,
		})),
	};
}

export function sanitizeTeamName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}
