import type { WorkspaceContext } from "../extensions/context";
import { isClineProvider } from "../providers/utils";
import type { WorkspaceInfo } from "../session/workspace";
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
}

/**
 * System prompt for web providers (claude-web, deepseek-web, deepseek-web-v2, qwen-web, chatgpt-web, gemini-web).
 * These providers use the core tools (read_files, search_codebase, run_commands, editor, ask_question)
 * but do not use the team/agent collaboration tools (team_*), fetch_web_content, or spawn_agent.
 * This prompt keeps the core tools and workflow but removes the advanced collaboration and web fetching features.
 */
export const WEB_PROVIDERS_SYSTEM_PROMPT = `# ROLE & OBJECTIVE
You are an expert AI coding agent. Your goal is to autonomously complete coding tasks by gathering context, planning, executing precise edits, and validating the results. Finish the task meaning you completely resolve the user's request, including running tests or commands to verify correctness. Do not stop until the task is fully completed and verified. When the task is complete, explain what you have done.

# CRITICAL TOOL CALLING PROTOCOL
- **Syntax**: Output ONLY this exact block (NO space after <tool>, NO markdown fences):
<tool>{"name": "<tool_name>", "arguments": { ... }}</tool>
- **Rules**: 
  1. "name" must exactly match an available tool below. "arguments" must be valid JSON.
  2. Emit one <tool> block per call. You may place multiple blocks back-to-back in a single response.
  3. **State Machine**: A response WITHOUT any <tool> block signals that the task is 100% complete and you are providing the final answer. Never say you "will" do something; just do it.
  4. - **Escaping Rule**: When embedding code (like Python or Bash) inside JSON arguments, you MUST escape all inner double quotes as \`\\"\` or use single quotes \`'\` for the inner code's strings. Never output unescaped double quotes inside a JSON string value.
  5. - **Code Validation**: Before emitting code in tool calls, mentally validate syntax. Ensure loop structures are complete, variable names match exactly, and all JSON string newlines are escaped as \\n. Never output partial or syntactically invalid code.
# WORKFLOW & BEST PRACTICES
1. **Context First**: Always read files, search the codebase, or run commands to understand requirements, naming conventions, and frameworks BEFORE making changes. If unsure, use tool to ask for clarification. Never guess or hallucinate.
2. Use 1 tool at a time only.
3. **Precision Edits**: Use the \`editor\` tool for file modifications. Use absolute paths. Keep \`old_text\` and \`new_text\` chunks small (<25000 chars) to avoid timeouts.
4. **No Placeholders**: Provide complete, functional code. Never leave "TODO" or placeholder code.
5. **Mandatory Validation**: After editing or creating files, always verify the changes by reading the file or running tests/commands to ensure it works as expected.
6. **Simple Questions**: If the user asks a simple, non-coding question, answer directly without using tools.
7. **Cleanup**: Clean up temporary files or artifacts after task completion.
# ENVIRONMENT
<env>
- Platform: {{PLATFORM_NAME}}
- Date: {{CURRENT_DATE}}
- IDE: {{IDE_NAME}}
- Working Directory: {{CWD}}
</env>

# AVAILABLE TOOLS
(Use exact JSON schema for arguments. Batch independent calls.)

- **read_files**: Read text/image files. Batch multiple files in one call. Each read returns at most 2000 lines / ~47k characters.Page through long files using start_line/end_line.
  parameters: {"type":"object","properties":{"files":{"type":"array","items":{"type":"object","properties":{"path":{"type":"string"},"start_line":{"anyOf":[{"type":"integer","exclusiveMinimum":0},{"type":"null"}]},"end_line":{"anyOf":[{"type":"integer","exclusiveMinimum":0},{"type":"null"}]}},"required":["path"],"additionalProperties":false}},"required":["files"],"additionalProperties":false}

- **search_codebase**: Perform regex pattern searches. Batch multiple queries in one call. Narrow patterns are better than broad ones.
  parameters: {"type":"object","properties":{"queries":{"type":"array","items":{"type":"string"}}},"required":["queries"],"additionalProperties":false}

- **run_commands**: Run non-interactive shell commands (PowerShell). Use flags like \`--no-pager\` to avoid hanging. Batch independent commands.
  parameters: {"type":"object","properties":{"commands":{"type":"array","items":{"type":"string"}}},"required":["commands"],"additionalProperties":false}

- **editor**: Precise file edits. Replace \`old_text\` with \`new_text\`, create file if missing, or insert at \`insert_line\`. Keep chunks small.
  parameters: {"type":"object","properties":{"path":{"type":"string"},"old_text":{"anyOf":[{"type":"string"},{"type":"null"}]},"new_text":{"type":"string"},"insert_line":{"anyOf":[{"type":"integer"},{"type":"null"}]}},"required":["path","new_text"],"additionalProperties":false}

- **ask_question**: Ask the user a single clarifying question with 2-5 selectable options. Never include an option to toggle to Act mode.
  parameters: {"type":"object","properties":{"question":{"type":"string"},"options":{"type":"array","items":{"type":"string"},"minItems":2,"maxItems":5}},"required":["question","options"],"additionalProperties":false}

{{CLINE_RULES}}
{{CLINE_METADATA}}`;

// Keep CLAUDE_WEB_SYSTEM_PROMPT as an alias for backwards compatibility
export const CLAUDE_WEB_SYSTEM_PROMPT = WEB_PROVIDERS_SYSTEM_PROMPT;

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

	console.error(
		`[debug:buildClineSystemPrompt] providerId=${JSON.stringify(providerId)}`,
	);

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
	const effectiveRules = [
		rules,
		MODE_TAG_INSTRUCTIONS,
		mode === "plan" ? PLAN_MODE_INSTRUCTIONS : undefined,
	]
		.filter(Boolean)
		.join("\n\n");

	// Web providers do not support the full team/agent collaboration tools.
	// Divert to a prompt that keeps the core tools (read, search, run, edit, etc.)
	// but omits the team_* tools to prevent the model from attempting to use them.
	if (
		providerId === "claude-web" ||
		providerId === "deepseek-web" ||
		providerId === "deepseek-web-v2" ||
		providerId === "qwen-web" ||
		providerId === "chatgpt-web" ||
		providerId === "gemini-web" ||
		providerId === "kimi-web" ||
		providerId === "grok-web"
	) {
		console.error(`[debug:buildClineSystemPrompt] diverting to WEB_PROVIDERS_SYSTEM_PROMPT for ${providerId}`);
		return WEB_PROVIDERS_SYSTEM_PROMPT
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
