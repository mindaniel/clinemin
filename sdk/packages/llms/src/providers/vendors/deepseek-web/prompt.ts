import type {
	LanguageModelV2FunctionTool,
	LanguageModelV2Message,
	LanguageModelV2Prompt,
} from "@ai-sdk/provider";

// ── Prompt building (the web endpoint only accepts a flat `prompt` string) ──

const DEFAULT_AUTO_HISTORY_WINDOW = 20;

/** Loose view over any LanguageModelV2 content part for text extraction. */
type PromptPart = {
	type?: string;
	text?: unknown;
	toolName?: unknown;
	toolCallId?: unknown;
	// Legacy (AI SDK v1) tool-result shape.
	result?: unknown;
	// AI SDK v2 tool-result shape: { type, value } | { type: "content", value: ... }.
	output?: unknown;
};

function toPromptParts(message: LanguageModelV2Message): PromptPart[] {
	if (Array.isArray(message.content)) {
		return message.content as unknown as PromptPart[];
	}
	return [{ type: "text", text: String(message.content ?? "") }];
}

/**
 * Convert an AI SDK v2 tool-result `output` into a plain string so the model
 * can see the tool's result. v2 uses `output` (not v1's `result`) with one of
 * several shapes:
 *   - { type: "text",        value: string }
 *   - { type: "json",        value: JSONValue }
 *   - { type: "error-text",  value: string }
 *   - { type: "error-json",  value: JSONValue }
 *   - { type: "content",     value: Array<{ type: "text", text } | { type: "media", ... }> }
 * Without this, the web provider silently swallowed every tool result (the
 * model kept asking "did you actually create it?" because it never saw the
 * command output).
 */
function toolResultOutputText(output: unknown): string {
	if (output == null) return "";
	if (typeof output === "string") return output;

	const out = output as {
		type?: string;
		value?: unknown;
	};

	if (out.type === "text" || out.type === "error-text") {
		return typeof out.value === "string" ? out.value : String(out.value ?? "");
	}

	if (out.type === "json" || out.type === "error-json") {
		return typeof out.value === "string"
			? out.value
			: JSON.stringify(out.value);
	}

	if (out.type === "content") {
		const items = out.value as Array<{
			type?: string;
			text?: string;
			data?: string;
			mediaType?: string;
		}>;
		if (Array.isArray(items)) {
			return items
				.map((item) => {
					if (item.type === "text" && typeof item.text === "string") {
						return item.text;
					}
					if (item.type === "media") {
						const mime =
							typeof item.mediaType === "string" ? ` [${item.mediaType}]` : "";
						const body = typeof item.data === "string" ? item.data : "";
						return `[media${mime}]${body ? ` ${body}` : ""}`;
					}
					return "";
				})
				.filter((t) => t.length > 0)
				.join("\n");
		}
	}

	return JSON.stringify(output);
}

function promptPartText(part: PromptPart): string {
	if (typeof part.text === "string" && part.text.length > 0) return part.text;
	if (part.type === "tool-result" || part.type === "tool_result") {
		// v2 shape takes precedence; fall back to the core SDK's `content`
		// field or the legacy `result` field.
		if (part.output !== undefined) return toolResultOutputText(part.output);
		if ((part as { content?: unknown }).content !== undefined) {
			return toolResultOutputText((part as { content?: unknown }).content);
		}
		if (part.result !== undefined) {
			return typeof part.result === "string"
				? part.result
				: JSON.stringify(part.result);
		}
	}
	return "";
}

/**
 * Serialize the AI SDK prompt into DeepSeek's flat `prompt` string. For
 * multi-turn conversations a bounded rolling window of recent turns is stitched
 * in so the agent keeps context across turns.
 */
export interface MessagesToPromptOptions {
	/** Number of most-recent turns to fold into the flat prompt (default: global). */
	historyWindow?: number;
	/**
	 * Label prefix for prior user messages. Defaults to "User". v2 uses
	 * "Previous user message" so the model reads it as context, not a fresh
	 * instruction, and doesn't re-answer it.
	 */
	userLabel?: string;
	/**
	 * Label prefix for the FINAL user message only, overriding `userLabel`.
	 * v2 uses "Note" for the runtime's synthetic "Use tool to continue..."
	 * continuation, so the current directive is not framed as stale context.
	 */
	lastUserLabel?: string;
	/** Label prefix for trailing tool results. Defaults to "Tool result". */
	toolResultLabel?: string;
}

export function messagesToPrompt(
	messages: LanguageModelV2Message[],
	historyWindowOrOptions:
		| number
		| MessagesToPromptOptions = DEFAULT_AUTO_HISTORY_WINDOW,
): string {
	const options: MessagesToPromptOptions =
		typeof historyWindowOrOptions === "number"
			? { historyWindow: historyWindowOrOptions }
			: historyWindowOrOptions;
	const historyWindow = options.historyWindow ?? DEFAULT_AUTO_HISTORY_WINDOW;
	const userLabel = options.userLabel ?? "User";
	const lastUserLabel = options.lastUserLabel;
	const toolResultLabel = options.toolResultLabel ?? "Tool result";
	const systemParts: string[] = [];
	const conversation: Array<{ role: string; text: string }> = [];
	let lastUserContent = "";
	let lastUserIndex = -1;

	for (const message of messages) {
		const parts = toPromptParts(message);
		const text = parts
			.map((part) =>
				part.type === "text" ||
				part.type === "tool-result" ||
				part.type === "tool_result"
					? promptPartText(part)
					: "",
			)
			.join("\n")
			.trim();

		if (message.role === "system") {
			if (text) systemParts.push(text);
		} else if (message.role === "user" || message.role === "assistant") {
			if (text) {
				conversation.push({ role: message.role, text });
				if (message.role === "user") lastUserIndex = conversation.length - 1;
			}
			if (message.role === "user") lastUserContent = text;
		} else if (message.role === "tool") {
			// Tool results have no native slot in the flat-prompt format; fold
			// them in as plain text so the model keeps seeing the output.
			if (text) {
				const toolResult = parts.find(
					(p) => p.type === "tool-result" || p.type === "tool_result",
				);
				const toolName =
					typeof toolResult?.toolName === "string"
						? toolResult.toolName
						: "tool";
				conversation.push({ role: "tool", text: `(${toolName}) ${text}` });
			}
		}
	}

	const outputParts: string[] = [];
	if (systemParts.length > 0) outputParts.push(systemParts.join("\n\n"));

	const effectiveWindow = conversation.length > 1 ? historyWindow : 0;
	if (effectiveWindow > 0 && conversation.length > 1) {
		const recent = conversation.slice(-effectiveWindow);
		outputParts.push(
			recent
				.map((turn, index) => {
					if (turn.role === "assistant") {
						return `Assistant: ${turn.text}`;
					}
					if (turn.role === "tool") {
						return `${toolResultLabel}: ${turn.text}`;
					}
					// The final user message (e.g. the runtime's synthetic
					// "Use tool to continue..." continuation) may carry its own
					// label instead of the generic prior-user label.
					const isLastUser =
						lastUserIndex >= 0 &&
						conversation.length - recent.length + index === lastUserIndex;
					return isLastUser && lastUserLabel
						? `${lastUserLabel}: ${turn.text}`
						: `${userLabel}: ${turn.text}`;
				})
				.join("\n\n"),
		);
	} else if (lastUserContent) {
		outputParts.push(lastUserContent);
	}

	return outputParts.join("\n\n").replace(/!\[.*?\]\(.*?\)/g, "");
}

/**
 * Serialize AI SDK function tools into DeepSeek's strict `<tool>{json}</tool>`
 * prompt contract so the model can request tool calls despite the web endpoint
 * having no native `tools[]` field.
 */
export function serializeDeepSeekToolPrompt(
	tools: LanguageModelV2FunctionTool[],
): string {
	if (!tools.length) return "";
	const lines: string[] = [];
	for (const tool of tools) {
		const desc = tool.description ?? "";
		const params = tool.inputSchema ? JSON.stringify(tool.inputSchema) : "";
		lines.push(
			`- ${tool.name}${desc ? `: ${desc}` : ""}${params ? `\n  parameters: ${params}` : ""}`,
		);
	}
	return [
		"You can call tools. To call a tool, output ONLY this exact block (no markdown fence):",
		'<tool>{"name": "<tool_name>", "arguments": { ... }}</tool>',
		"Rules:",
		"- Use exactly <tool>...</tool>. Do NOT use <tool:name>, <tool_call>, <name>, <parameter>, id=/name= attributes, or code fences.",
		'- "name" must be one of the tools below; "arguments" must be a JSON object.',
		"- When a tool is needed, emit the <tool> block instead of only describing the plan.",
		"- Emit one <tool> block per call; you may put several blocks back to back.",
		"- If no tool is needed, just answer normally without any <tool> block.",
		"",
		"Available tools:",
		...lines,
	].join("\n");
}

export function buildPrompt(
	prompt: LanguageModelV2Prompt,
	_tools: LanguageModelV2FunctionTool[] | undefined,
): string {
	return messagesToPrompt(prompt);
}
