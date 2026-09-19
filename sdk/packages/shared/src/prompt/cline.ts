import type { WorkspaceContext } from "../extensions/context";
import { isClineProvider } from "../providers/utils";
import type { WorkspaceInfo } from "../session/workspace";
import type { ManagerWorkerSummary } from "./manager";
import { buildManagerSystemPrompt } from "./manager";
import {
	DEFAULT_CLINE_SYSTEM_PROMPT,
	YOLO_CLINE_SYSTEM_PROMPT,
} from "./system";

const WORKSPACE_CONFIGURATION_MARKER = "# Workspace Configuration";

/**
 * Explains the <user_input mode="..."> wrapper and <mode_notice> elements the
 * runtime stamps on user messages (prepareTurnInput / formatUserInputBlock).
 * Every host that sends through the SDK runtime produces those tags, so every
 * host's system prompt must explain them: without this section the model has
 * no idea what the attribute means, and a mid-conversation mode switch is an
 * invisible system-prompt swap it cannot diff. Included for BOTH modes, since
 * after a switch the transcript still contains messages tagged with the other
 * mode.
 */
export const MODE_TAG_INSTRUCTIONS = `# Plan / Act Modes

User messages arrive wrapped in a <user_input mode="..."> tag. The mode attribute is the interaction mode the user was in when they sent that message: "plan" means plan-mode constraints applied (explore, analyze, and align on a plan -- no edits or state-changing commands), while "act" (or "yolo") means implementation was allowed. If the mode attribute changes between messages, the user switched modes -- the newest message's mode is what governs right now, regardless of what earlier messages allowed. A <mode_notice> block inside a message marks exactly when such a switch happened.`;

/**
 * Plan-mode behavioral contract, appended when the session mode is "plan".
 * run_commands intentionally stays available in plan mode -- it is essential
 * for read-only investigation -- so the contract must spell out that it is
 * inspection-only there; the mitigation for plan-mode mutations is prompting
 * plus mode-switch notices, not tool removal.
 */
export const PLAN_MODE_INSTRUCTIONS = `# Plan Mode

You are in Plan mode. Your role is to explore, analyze, and plan -- not to execute.

- Read files, search the codebase, and gather context to understand the problem
- Ask clarifying questions when requirements are ambiguous
- Present your plan as a structured outline with clear steps
- Explain tradeoffs between different approaches when they exist
- Do NOT edit files, write code, run destructive commands, or make any changes
- Do NOT implement anything -- focus on understanding and alignment first

The run_commands tool remains available in plan mode strictly for read-only inspection -- listing files, searching (grep), reading configs, inspecting git history and diffs, checking tool versions, and the like. Never use it to change anything: no creating, modifying, or deleting files, no writing scripts that make changes, and no state-changing commands (installs, migrations, database or schema changes, container commands that mutate state, etc.). If the task requires a mutation, put it in the plan; it happens only after the user switches to act mode.

Once the user has reviewed your plan and explicitly approved it in a follow-up message, use the switch_to_act_mode tool to switch to act mode and begin implementation. Calling switch_to_act_mode immediately starts execution, so never call it in the same turn you present a plan and never treat the original task request as approval -- end your turn after presenting the plan and wait for the user's response.`;

export function processWorkspaceInfo(info: WorkspaceInfo): string {
	return JSON.stringify(
		{
			workspaces: {
				[info.rootPath]: {
					hint: info.hint,
					associatedRemoteUrls: info.associatedRemoteUrls,
					latestGitCommitHash: info.latestGitCommitHash,
					latestGitBranchName: info.latestGitBranchName,
				},
			},
		},
		null,
		2,
	);
}

function buildWorkspaceMetadata(
	rootPath: string,
	workspaceName?: string,
	metadata?: string,
): string {
	if (metadata?.trim()?.includes(WORKSPACE_CONFIGURATION_MARKER)) {
		return metadata.trim();
	}
	const body =
		metadata ||
		JSON.stringify(
			{
				workspaces: {
					[rootPath]: {
						hint: workspaceName || rootPath.split("/").at(-1) || rootPath,
					},
				},
			},
			null,
			2,
		);
	return `\n${WORKSPACE_CONFIGURATION_MARKER}\n${body}`;
}

/**
 * Options for building the Cline system prompt.
 *
 * Extends WorkspaceContext so callers can spread an ExtensionContext.workspace
 * directly. `workspaceRoot` is accepted as an alias for `rootPath` to support
 * existing call sites that set it explicitly.
 */
export interface ClineSystemPromptOptions
	extends Omit<WorkspaceContext, "rootPath"> {
	/**
	 * Workspace root path. Accepts either `rootPath` (from WorkspaceContext/WorkspaceInfo)
	 * or `workspaceRoot` (legacy alias) — whichever is provided will be used.
	 */
	rootPath?: string;
	/** Alias for rootPath — kept for backwards compatibility with existing call sites */
	workspaceRoot?: string;
	/** Per-request system prompt override */
	overridePrompt?: string;
	/** Provider ID — used to gate Cline-specific metadata injection */
	providerId?: string;
	/**
	 * Run this session as a team manager.
	 *
	 * The manager coordinates and delegates; it has no file or shell tools, so
	 * it gets a prompt that never mentions any (see `./manager`). An explicit
	 * `overridePrompt` still wins — that is the user typing their own prompt.
	 */
	managerMode?: boolean;
	/** Workers the manager can address, listed in its prompt. */
	managerWorkers?: ManagerWorkerSummary[];
	/**
	 * Tool names this agent actually has, when it is a restricted set.
	 *
	 * Omit for an unrestricted agent. Documenting a tool the agent cannot call
	 * is worse than documenting nothing: it will call it, and spend its turns
	 * on rejections it has no way to diagnose.
	 */
	tools?: string[];
	/**
	 * Per-provider prompt overrides for the three roles (default, worker, manager).
	 * When a slot is undefined, the shared prompt is used.
	 */
	prompts?: WebProviderPrompts;
	/**
	 * Role of the agent receiving this prompt. Used to select the correct slot
	 * from `prompts`.
	 */
	role?: "default" | "worker" | "manager";
}

/**
 * Three prompt slots a web provider can override.
 *
 * - `default` — a plain session. One human, one chat box.
 * - `worker` — a teammate a manager delegated to. Its tool list lives in this
 *   text and nowhere else, because there is no function-calling API behind a
 *   scraped chat.
 * - `manager` — a coordinator. No file or shell tools at all; it delegates and
 *   reads reports.
 *
 * A slot may be `undefined`, meaning the shared prompt for that role is used.
 */
export interface WebProviderPrompts {
	default?: string;
	worker?: string;
	manager?: string;
}

/**
 * System prompt for web providers (claude-web, deepseek-web, deepseek-web-v2, qwen-web, chatgpt-web, gemini-web).
 * These providers use the core tools (read_files, search_codebase, run_commands, editor, ask_question)
 * but do not use the team/agent collaboration tools (team_*), fetch_web_content, or spawn_agent.
 * This prompt keeps the core tools and workflow but removes the advanced collaboration and web fetching features.
 */
/**
 * Per-tool documentation for the web-provider prompt.
 *
 * Split out of one hardcoded block so the prompt can advertise exactly the
 * tools an agent actually has. A worker scoped to reading was still shown
 * `editor` and `run_commands` here, so it called them, and every call came
 * back rejected as unavailable — the scope was real but invisible.
 */
const WEB_PROVIDER_TOOL_DOCS: Record<string, string> = {
	read_files: `- **read_files**: Read text/image files. Batch multiple files in one call. Each read returns at most 2000 lines / ~47k characters.Page through long files using start_line/end_line.
  parameters: {"type":"object","properties":{"files":{"type":"array","items":{"type":"object","properties":{"path":{"type":"string"},"start_line":{"anyOf":[{"type":"integer","exclusiveMinimum":0},{"type":"null"}]},"end_line":{"anyOf":[{"type":"integer","exclusiveMinimum":0},{"type":"null"}]}},"required":["path"],"additionalProperties":false}},"required":["files"],"additionalProperties":false}`,
	search_codebase: `- **search_codebase**: Perform regex pattern searches. Batch multiple queries in one call. Narrow patterns are better than broad ones.
  parameters: {"type":"object","properties":{"queries":{"type":"array","items":{"type":"string"}}},"required":["queries"],"additionalProperties":false}`,
	run_commands: `- **run_commands**: Run non-interactive shell commands (PowerShell). Use flags like \\\`--no-pager\\\` to avoid hanging. Batch independent commands.
  parameters: {"type":"object","properties":{"commands":{"type":"array","items":{"type":"string"}}},"required":["commands"],"additionalProperties":false}`,
	editor: `- **editor**: Precise file edits. Replace \\\`old_text\\\` with \\\`new_text\\\`, create file if missing, or insert at \\\`insert_line\\\`. Keep chunks small.
  parameters: {"type":"object","properties":{"path":{"type":"string"},"old_text":{"anyOf":[{"type":"string"},{"type":"null"}]},"new_text":{"type":"string"},"insert_line":{"anyOf":[{"type":"integer"},{"type":"null"}]}},"required":["path","new_text"],"additionalProperties":false}`,
	apply_patch: `- **apply_patch**: Edit, create, delete or move files. Write the patch as a bare block in your reply. Do NOT wrap it in a <tool> block, in JSON, or in a code fence — it is read as plain text, so nothing needs escaping:

*** Begin Patch
*** Update File: {absolute path}
@@ {nearest enclosing function or class line, optional}
 {unchanged context line, prefixed with one space}
-{line to remove}
+{line to add}
*** End Patch

  Rules: absolute paths only; context lines start with a single space and their indentation must match the file exactly; include 2-3 context lines around every change; use "*** Add File:" for a new file and "*** Delete File:" to remove one; several files and several @@ sections may share one block.`,
	ask_question: `- **ask_question**: Ask the user a single clarifying question with 2-5 selectable options. Never include an option to toggle to Act mode.
  parameters: {"type":"object","properties":{"question":{"type":"string"},"options":{"type":"array","items":{"type":"string"},"minItems":2,"maxItems":5}},"required":["question","options"],"additionalProperties":false}`,
};

/**
 * Tools that change something. Everything else only looks.
 */
const WRITE_TOOL_NAMES = new Set(["editor", "apply_patch", "run_commands"]);

export function hasWriteTools(tools: string[] | undefined): boolean {
	return (
		tools === undefined || tools.some((name) => WRITE_TOOL_NAMES.has(name))
	);
}

/**
 * The workflow section, minus the half that only applies to changing things.
 *
 * Half of it is about making edits and cleaning up afterwards. A worker scoped
 * to reading has to read past all of it to find the two lines that apply to it,
 * and the advice it cannot act on is the advice most likely to make it reach
 * for a tool it does not have.
 */
function renderWorkflow(tools: string[] | undefined): string {
	const lines = [
		"# WORKFLOW & BEST PRACTICES",
		"1. **Context First**: Always read files, search the codebase, or run commands to understand requirements, naming conventions, and frameworks BEFORE making changes. If unsure, use tool to ask for clarification. Never guess or hallucinate.",
		"2. Use 1 tool at a time only.",
	];
	if (hasWriteTools(tools)) {
		// Which edit tool a session gets is decided by tool routing, and only ever
		// one of them. Naming the wrong one here sends the model after a tool it
		// does not have.
		const usesApplyPatch = tools?.includes("apply_patch") === true;
		lines.push(
			usesApplyPatch
				? "3. **Precision Edits**: Use the `apply_patch` tool for file modifications. Use absolute paths. Keep each patch small (<25000 chars) to avoid timeouts."
				: "3. **Precision Edits**: Use the `editor` tool for file modifications. Use absolute paths. Keep `old_text` and `new_text` chunks small (<25000 chars) to avoid timeouts.",
			'4. **No Placeholders**: Provide complete, functional code. Never leave "TODO" or placeholder code.',
			"5. **Mandatory Validation**: After editing or creating files, always verify the changes by reading the file or running tests/commands to ensure it works as expected.",
		);
	}
	lines.push(
		`${hasWriteTools(tools) ? "6" : "3"}. **Simple Questions**: If the user asks a simple, non-coding question, answer directly without using tools.`,
	);
	if (hasWriteTools(tools)) {
		lines.push(
			"7. **Cleanup**: Clean up temporary files or artifacts after task completion.",
		);
	}
	return lines.join("\n");
}

/**
 * The per-tool documentation block for a given tool scope.
 *
 * Exported because `/guide-ai` re-sends it mid-conversation (see `./guide`).
 * Rebuilding it from the same table is the point: a reminder that lists a tool
 * the session does not have is worse than no reminder, and a second
 * hand-written copy would drift the first time a tool's schema changed.
 */
export function renderWebProviderToolDocs(tools: string[] | undefined): string {
	const allowed = tools ? new Set(tools) : undefined;
	const rendered = WEB_PROVIDER_TOOL_ORDER.filter((name) =>
		allowed
			? allowed.has(name)
			: // `editor` and `apply_patch` are the same job, and tool routing gives a
				// session exactly one of them. An unrestricted session has no list to
				// check, so the default has to be the one nearly every web provider gets.
				name !== "apply_patch",
	)
		.map((name) => WEB_PROVIDER_TOOL_DOCS[name])
		.filter((doc): doc is string => Boolean(doc));
	if (rendered.length === 0) {
		return "(none — report what you find in plain text.)";
	}
	return rendered.join("\n\n");
}

const WEB_PROVIDER_TOOL_ORDER = [
	"read_files",
	"search_codebase",
	"run_commands",
	"editor",
	"apply_patch",
	"ask_question",
];

/**
 * The `<tool>` calling contract, on its own.
 *
 * Split out of the prompt template because `/guide-ai` re-sends exactly these
 * rules mid-conversation (see `./guide`), and the whole point of that command
 * is that the model is reminded of the contract it was actually given. A second
 * copy typed out in the reminder would drift the first time a rule changed
 * here, and the symptom — a model emitting a shape the parser rejects — reads
 * as a model problem rather than a stale constant.
 */
export const TOOL_CALL_PROTOCOL_RULES = `- **Syntax**: Output ONLY this exact block (NO space after <tool>, NO markdown fences):
<tool>{"name": "<tool_name>", "arguments": { ... }}</tool>
- **Rules**: 
  1. "name" must exactly match an available tool below. "arguments" must be valid JSON.
  2. Emit one <tool> block per call. You may place multiple blocks back-to-back in a single response.
  3. **State Machine**: A response WITHOUT any <tool> block signals that the task is 100% complete and you are providing the final answer. Never say you "will" do something; just do it.
  4. - **Escaping Rule**: When embedding code (like Python or Bash) inside JSON arguments, you MUST escape all inner double quotes as \`\\"\` or use single quotes \`'\` for the inner code's strings. Never output unescaped double quotes inside a JSON string value.
  5. - **Code Validation**: Before emitting code in tool calls, mentally validate syntax. Ensure loop structures are complete, variable names match exactly, and all JSON string newlines are escaped as \\n. Never output partial or syntactically invalid code.`;

export const WEB_PROVIDERS_SYSTEM_PROMPT = `# ROLE & OBJECTIVE
Your will help me complete coding tasks by gathering context, planning, executing precise edits, and validating the results. Finish the task meaning you completely resolve the user's request, including running tests or commands to verify correctness. When the task is complete, explain what you have done.

You must use the exact following syntax tool to help me read files, search the codebase, run commands, edit files, or ask me a question. I will use copy these tools, run it, and send you the output.
${TOOL_CALL_PROTOCOL_RULES}
{{WORKFLOW}}

# ENVIRONMENT
<env>
- Platform: {{PLATFORM_NAME}}
- Date: {{CURRENT_DATE}}
- IDE: {{IDE_NAME}}
- Working Directory: {{CWD}}
</env>

#WRITE TO USE EXACT TOOLS I TOLD YOU TO. DO NOT USE YOUR OWN TOOLS.
(Use exact JSON schema for arguments. Batch independent calls.)
{{AVAILABLE_TOOLS}}

{{CLINE_RULES}}
{{CLINE_METADATA}}`;

// Keep CLAUDE_WEB_SYSTEM_PROMPT as an alias for backwards compatibility
export const CLAUDE_WEB_SYSTEM_PROMPT = WEB_PROVIDERS_SYSTEM_PROMPT;

/**
 * Providers that are a scraped web chat rather than an API.
 *
 * The list lives here, next to the prompt these providers receive, because that
 * is the decision it exists to make. It was previously an inline chain of
 * `providerId === "..."` comparisons in one branch; callers elsewhere grew
 * their own copies and drifted, so kimi-web and grok-web were missing from some
 * of them.
 */
export function isWebChatProvider(providerId: string): boolean {
	return (
		providerId === "claude-web" ||
		providerId === "deepseek-web" ||
		providerId === "deepseek-web-v2" ||
		providerId === "qwen-web" ||
		providerId === "chatgpt-web" ||
		providerId === "gemini-web" ||
		providerId === "kimi-web" ||
		providerId === "grok-web"
	);
}

export function buildClineSystemPrompt(
	options: ClineSystemPromptOptions,
): string {
	const {
		ide = "Terminal Shell",
		mode,
		platform = "unknown",
		workspaceName,
		metadata,
		rules,
		overridePrompt,
		providerId,
	} = options;
	const workspaceRoot = options.workspaceRoot ?? options.rootPath ?? "";
	const isCline = isClineProvider(providerId || "");

	if (options.managerMode && !overridePrompt?.trim()) {
		const managerPrompt = options.prompts?.manager;
		if (managerPrompt) {
			return managerPrompt;
		}
		return buildManagerSystemPrompt({
			workers: options.managerWorkers,
			workspaceRoot,
			platform,
			// Project rules stay off the manager for the same reason they stay off
			// any lead: they describe how to edit this repo, and the manager never
			// does. The workers get them through `buildTeammateSystemPrompt`.
		});
	}

	if (overridePrompt?.trim()) {
		const trimmed = overridePrompt.trim();
		if (
			isCline &&
			metadata?.trim() &&
			!trimmed.includes(WORKSPACE_CONFIGURATION_MARKER)
		) {
			return `${trimmed}\n\n${buildWorkspaceMetadata(workspaceRoot, workspaceName, metadata)}`.trim();
		}
		return trimmed;
	}

	// Mode semantics ride in the rules slot so every host emits them without
	// composing its own copy. Order matches what the CLI historically built by
	// hand (caller rules, then the mode-tag explanation, then the plan-mode
	// contract), keeping CLI output byte-identical after the promotion.
	//
	// Project rules are dropped for web providers. They describe how to work in
	// this codebase — which package manager, when to rebuild, what not to grep —
	// and the agent that needs them is the one editing files. On a web provider
	// that agent is a teammate, which is prompted through
	// `buildTeammateSystemPrompt` and gets the rules there. The lead is a
	// coordinator that touches no files, so for it the same text is a wall of
	// irrelevant instruction in front of the actual job.
	//
	// Mode-tag and plan-mode instructions are also dropped for web providers.
	// They do not participate in the plan/act mode system and do not need to
	// understand the <user_input mode="..."> wrapper or <mode_notice> tags.
	const isWeb = isWebChatProvider(providerId || "");
	const effectiveRules = [
		isWeb ? undefined : rules,
		isWeb ? undefined : MODE_TAG_INSTRUCTIONS,
		isWeb || mode !== "plan" ? undefined : PLAN_MODE_INSTRUCTIONS,
	]
		.filter(Boolean)
		.join("\n\n");

	// Web providers do not support the full team/agent collaboration tools.
	// Divert to a prompt that keeps the core tools (read, search, run, edit, etc.)
	// but omits the team_* tools to prevent the model from attempting to use them.
	if (isWebChatProvider(providerId || "")) {
		let basePrompt = WEB_PROVIDERS_SYSTEM_PROMPT;
		const role = options.role || "default";
		const prompts = options.prompts;
		if (role === "default" && prompts?.default) {
			basePrompt = prompts.default;
		} else if (role === "worker" && prompts?.worker) {
			basePrompt = prompts.worker;
		}
		// manager is handled above; fallback to shared prompt.
		return basePrompt
			.replace("{{PLATFORM_NAME}}", platform)
			.replace("{{CWD}}", workspaceRoot)
			.replace("{{CURRENT_DATE}}", new Date().toLocaleDateString())
			.replace("{{IDE_NAME}}", ide)
			.replace(
				"{{CLINE_METADATA}}",
				isCline
					? buildWorkspaceMetadata(workspaceRoot, workspaceName, metadata)
					: "",
			)
			.replace("{{AVAILABLE_TOOLS}}", renderWebProviderToolDocs(options.tools))
			.replace("{{WORKFLOW}}", renderWorkflow(options.tools))
			.replace("{{CLINE_RULES}}", effectiveRules)
			.trim();
	}

	const basePrompt =
		mode === "yolo" ? YOLO_CLINE_SYSTEM_PROMPT : DEFAULT_CLINE_SYSTEM_PROMPT;

	return basePrompt
		.replace("{{PLATFORM_NAME}}", platform)
		.replace("{{CWD}}", workspaceRoot)
		.replace("{{CURRENT_DATE}}", new Date().toLocaleDateString())
		.replace("{{IDE_NAME}}", ide)
		.replace(
			"{{CLINE_METADATA}}",
			isCline
				? buildWorkspaceMetadata(workspaceRoot, workspaceName, metadata)
				: "",
		)
		.replace("{{CLINE_RULES}}", effectiveRules)
		.trim();
}
