/**
 * SSE parser for Claude Web.
 *
 * Consumes the raw response body from Claude's /completion endpoint and
 * emits text chunks, usage, ask-user-input widgets, and session percentage.
 */

interface ClaudeSSEEvent {
	type?: string;
	index?: number;
	content_block?: {
		type: string;
		text?: string;
		name?: string;
		input?: unknown;
	};
	message?: {
		content?: {
			parts?: unknown[];
		};
	};
	content?: string;
	text?: string;
	usage?: {
		input_tokens?: number;
		prompt_tokens?: number;
		output_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
	message_limit?: {
		windows?: Record<
			string,
			{ utilization?: number; resets_at?: number } | undefined
		>;
		resolved?: {
			limit?: {
				percent?: number;
				resets_at?: string;
			};
		};
	};
	questions?: unknown;
	delta?: {
		type?: string;
		text?: string;
		partial_json?: string;
	};
}

/**
 * Pull the raw JSON out of an `ask_user_input_v0` block, whether it arrived
 * as a pre-populated `tool_use.input`, a `tool_result.content` text part, or
 * a plain `text` field. Returns the tool_use id (for dedupe) and the JSON
 * string.
 */
function extractAskUserInputJson(
	block: unknown,
): { id?: string; json: string } | undefined {
	if (!block || typeof block !== "object") return undefined;
	const obj = block as {
		id?: string;
		tool_use_id?: string;
		input?: unknown;
		content?: unknown;
		text?: string;
	};

	const id =
		typeof obj.tool_use_id === "string"
			? obj.tool_use_id
			: typeof obj.id === "string"
				? obj.id
				: undefined;

	// Full input already populated on a tool_use block.
	if (obj.input && typeof obj.input === "object") {
		if (Object.keys(obj.input).length > 0) {
			return { id, json: JSON.stringify(obj.input) };
		}
	}

	// tool_result blocks carry the JSON in content[0].text.
	const content = obj.content;
	if (Array.isArray(content)) {
		for (const part of content) {
			if (
				part &&
				typeof part === "object" &&
				typeof (part as { text: string }).text === "string"
			) {
				const trimmed = (part as { text: string }).text.trim();
				if (trimmed) return { id, json: trimmed };
			}
		}
	} else if (typeof content === "string" && content.trim()) {
		return { id, json: content.trim() };
	}

	// Final fallbacks.
	if (typeof obj.text === "string" && obj.text.trim()) {
		return { id, json: obj.text.trim() };
	}

	return undefined;
}

/**
 * Convert the raw JSON from Claude's `ask_user_input_v0` widget into the
 * runtime's `ask_question` tool calls. The widget payload looks like:
 *
 *   {"questions":[{"question":"...","options":["T1","T2"]}]}
 *
 * Each question becomes one `ask_question` call with `{ question, options }`,
 * only when `ask_question` is one of the available function tools.
 */
export function parseAskUserInputToolCalls(
	rawJson: string,
	availableToolNames: string[],
): { name: string; arguments: Record<string, unknown> }[] {
	if (!availableToolNames.includes("ask_question")) return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawJson);
	} catch {
		return [];
	}

	const questions = (parsed as ClaudeSSEEvent)?.questions;
	if (!Array.isArray(questions)) return [];

	const calls: { name: string; arguments: Record<string, unknown> }[] = [];
	for (const q of questions) {
		if (!q || typeof q !== "object") continue;
		const question = typeof q.question === "string" ? q.question.trim() : "";
		if (!question) continue;

		let options = q.options;
		if (!Array.isArray(options)) {
			options = typeof q.choices === "string" ? [q.choices] : [];
		}
		const cleanedOptions = options
			.filter(
				(o: unknown): o is string => typeof o === "string" && o.trim() !== "",
			)
			.slice(0, 5);

		calls.push({
			name: "ask_question",
			arguments: {
				question,
				options: cleanedOptions.length > 0 ? cleanedOptions : [],
			},
		});
	}
	return calls;
}

/**
 * The same widget payload, written out for a human to read.
 *
 * Used when the session has no `ask_question` tool — a manager, for instance,
 * whose whole tool set is delegation.
 */
export function renderAskUserInputAsText(rawJson: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawJson);
	} catch {
		return undefined;
	}
	const questions = (parsed as { questions?: unknown })?.questions;
	if (!Array.isArray(questions)) return undefined;

	const lines: string[] = [];
	for (const entry of questions) {
		if (!entry || typeof entry !== "object") continue;
		const q = entry as { question?: unknown; options?: unknown };
		const question = typeof q.question === "string" ? q.question.trim() : "";
		if (!question) continue;
		lines.push(question);
		if (Array.isArray(q.options)) {
			for (const option of q.options) {
				if (typeof option === "string" && option.trim()) {
					lines.push(`- ${option.trim()}`);
				}
			}
		}
	}
	return lines.length > 0 ? lines.join("\n") : undefined;
}

/**
 * Consume a Claude SSE response body.
 */
export function consumeClaudeSse(
	body: string,
	onChunk: (text: string) => void,
	onDone: () => void,
	onError: (err: Error) => void,
	onUsage?: (usage: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
	}) => void,
	onAskUserInput?: (json: string) => void,
	onSessionPercent?: (percent: number, resetsAt?: string) => void,
): void {
	try {
		// Claude SSE parsing: Anthropic content block format.
		let fullText = "";

		// Track native `ask_user_input_v0` tool_use blocks by index so the
		// streamed `input_json_delta` fragments can be reassembled and handed
		// back to the runtime's `ask_question` tool once the block closes.
		const askUserInputBlocks = new Map<number, string>();

		for (const rawLine of body.split("\n")) {
			const line = rawLine.trim();
			if (!line.startsWith("data:")) continue;
			const data = line.slice(5).trim();
			if (!data || data === "[DONE]") continue;

			let parsed: ClaudeSSEEvent;
			try {
				parsed = JSON.parse(data) as ClaudeSSEEvent;
			} catch {
				continue;
			}
			if (!parsed || typeof parsed !== "object") continue;

			// Streaming delta: { v: "...", o: "append" }. Skip patch diffs.
			if (parsed.type === "content_block_delta") {
				const d = parsed.delta;
				if (d && d.type === "text_delta" && typeof d.text === "string")
					fullText += d.text;

				// Accumulate the streamed JSON for a native ask-user-input
				// widget (ask_user_input_v0) so it can be mapped to the
				// runtime's ask_question tool once the block closes.
				if (
					d &&
					d.type === "input_json_delta" &&
					typeof parsed.index === "number" &&
					askUserInputBlocks.has(parsed.index)
				) {
					const partial =
						typeof d.partial_json === "string" ? d.partial_json : "";
					const current = askUserInputBlocks.get(parsed.index) || "";
					askUserInputBlocks.set(parsed.index, current + partial);
				}
			} else if (parsed.type === "content_block_start") {
				const b = parsed.content_block;
				if (b && b.type === "text" && typeof b.text === "string")
					fullText += b.text;

				if (
					b &&
					typeof b.type === "string" &&
					typeof parsed.index === "number"
				) {
					if (b.type === "tool_use" && b.name === "ask_user_input_v0") {
						// Pre-populated input arrives in some payloads; emit it
						// now. Empty input means the JSON is streamed via
						// `input_json_delta`, so open a buffer for it instead.
						const extracted = extractAskUserInputJson(b);
						if (extracted?.json) {
							onAskUserInput?.(extracted.json);
						} else {
							askUserInputBlocks.set(parsed.index, "");
						}
					} else if (
						b.type === "tool_result" &&
						b.name === "ask_user_input_v0"
					) {
						// Some payloads emit the full tool_result block instead
						// of streamed input_json_delta fragments; parse it
						// directly from the block.
						const extracted = extractAskUserInputJson(b);
						if (extracted?.json) onAskUserInput?.(extracted.json);
					}
				}
			} else if (parsed.type === "content_block_stop") {
				// The streamed input for an ask-user-input block is now
				// complete.
				if (
					typeof parsed.index === "number" &&
					askUserInputBlocks.has(parsed.index)
				) {
					const json = askUserInputBlocks.get(parsed.index)?.trim();
					if (json) onAskUserInput?.(json);
					askUserInputBlocks.delete(parsed.index);
				}
			}

			// message.content.parts[] is Claude's normal terminal payload.
			const message = parsed.message;
			if (message && typeof message === "object") {
				const content = message.content;
				if (typeof content === "string") {
					fullText += content;
				} else if (content && typeof content === "object") {
					const parts = content.parts;
					if (Array.isArray(parts)) {
						for (const part of parts) {
							if (typeof part === "string") fullText += part;
						}
					}
				}
			}

			if (typeof parsed.content === "string" && parsed.content) {
				fullText += parsed.content;
			}
			if (typeof parsed.text === "string" && parsed.text) {
				fullText += parsed.text;
			}

			if (parsed.type === "message_limit" && onSessionPercent) {
				// `resolved.limit` is Claude's own summary. The raw five-hour
				// window carries the same figure as a 0-1 fraction and an epoch
				// reset, so fall back to it if the summary is ever missing.
				const window5h = parsed.message_limit?.windows?.["5h"];
				const resolvedPercent =
					parsed.message_limit?.resolved?.limit?.percent ??
					(typeof window5h?.utilization === "number"
						? Math.round(window5h.utilization * 1000) / 10
						: undefined);
				const resolvedResetsAt =
					parsed.message_limit?.resolved?.limit?.resets_at ??
					(typeof window5h?.resets_at === "number"
						? new Date(window5h.resets_at * 1000).toISOString()
						: undefined);
				if (
					typeof resolvedPercent === "number" &&
					Number.isFinite(resolvedPercent) &&
					resolvedPercent >= 0
				) {
					onSessionPercent(
						resolvedPercent,
						typeof resolvedResetsAt === "string" ? resolvedResetsAt : undefined,
					);
				}
			}

			if (parsed.usage && onUsage) {
				onUsage({
					inputTokens:
						parsed.usage.input_tokens || parsed.usage.prompt_tokens || 0,
					outputTokens:
						parsed.usage.output_tokens || parsed.usage.completion_tokens || 0,
					totalTokens:
						parsed.usage.total_tokens ||
						(parsed.usage.prompt_tokens || 0) +
							(parsed.usage.completion_tokens || 0),
				});
			}
		}

		const finalText = fullText.trim();
		if (finalText) onChunk(finalText);
		onDone();
	} catch (err) {
		onError(err instanceof Error ? err : new Error(String(err)));
	}
}
