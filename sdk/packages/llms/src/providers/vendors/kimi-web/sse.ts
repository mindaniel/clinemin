/**
 * Reading Kimi's response stream.
 *
 * Kimi answers over two different shapes — a plain SSE body, and a run of
 * length-prefixed JSON frames — so both are handled here and nowhere else.
 * This is the most provider-specific code in the folder: nothing about it
 * generalises to another vendor.
 */

// ── SSE parser for Kimi ──────────────────────────────────────────────────────

/** Exported for tests: the boundary between the stream and the reply. */
export function consumeKimiSse(
	body: string,
	onChunk: (text: string) => void,
	onDone: () => void,
	onError: (err: Error) => void,
	onUsage?: (usage: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
	}) => void,
): void {
	try {
		let answerText = "";
		let anyText = "";
		let hasSseData = false;

		// 1. Try standard SSE parsing first
		for (const rawLine of body.split("\n")) {
			const line = rawLine.trim();
			if (line.startsWith("data:")) {
				hasSseData = true;
				const data = line.slice(5).trim();
				if (!data) continue;
				if (data === "[DONE]") break;

				let parsed: any;
				try {
					parsed = JSON.parse(data);
				} catch {
					continue;
				}

				for (const choice of Array.isArray(parsed.choices)
					? parsed.choices
					: []) {
					const delta = choice?.delta;
					const deltaContent =
						typeof delta?.content === "string" ? delta.content : "";
					if (deltaContent) {
						anyText += deltaContent;
						if (delta.phase === "answer" || delta.phase === undefined) {
							answerText += deltaContent;
						}
					}
					const messageContent =
						typeof choice?.message?.content === "string"
							? choice.message.content
							: "";
					if (messageContent) {
						anyText += messageContent;
						answerText += messageContent;
					}
				}

				if (typeof parsed.content === "string" && parsed.content) {
					anyText += parsed.content;
					answerText += parsed.content;
				}
				if (typeof parsed.output === "string" && parsed.output) {
					anyText += parsed.output;
					answerText += parsed.output;
				} else if (
					typeof parsed.output?.content === "string" &&
					parsed.output.content
				) {
					anyText += parsed.output.content;
					answerText += parsed.output.content;
				}

				if (parsed.usage && onUsage) {
					onUsage({
						inputTokens: parsed.usage.input_tokens || 0,
						outputTokens: parsed.usage.output_tokens || 0,
						totalTokens: parsed.usage.total_tokens || 0,
					});
				}
			}
		}

		// 2. If no SSE data was found, or it yielded nothing, try parsing as
		// concatenated JSON objects (e.g., gRPC-web or raw JSON stream format
		// used by newer Kimi endpoints like /apiv2/kimi.gateway.chat.v1.ChatService/Chat)
		if (!hasSseData || (!answerText && !anyText)) {
			let i = 0;
			while (i < body.length) {
				const start = body.indexOf("{", i);
				if (start === -1) break;

				// Find the end of the JSON object by counting braces
				let braceCount = 0;
				let inString = false;
				let escaped = false;
				let end = start;

				for (let j = start; j < body.length; j++) {
					const char = body[j];
					if (escaped) {
						escaped = false;
						continue;
					}
					if (char === "\\") {
						escaped = true;
						continue;
					}
					if (char === '"') {
						inString = !inString;
						continue;
					}
					if (!inString) {
						if (char === "{") braceCount++;
						else if (char === "}") {
							braceCount--;
							if (braceCount === 0) {
								end = j + 1;
								break;
							}
						}
					}
				}

				if (end > start) {
					const jsonStr = body.slice(start, end);
					try {
						const parsed = JSON.parse(jsonStr);
						const fragment = extractTextFragment(parsed);
						if (fragment) {
							anyText += fragment;
							answerText += fragment;
						}

						if (parsed.usage && onUsage) {
							onUsage({
								inputTokens:
									parsed.usage.input_tokens || parsed.usage.prompt_tokens || 0,
								outputTokens:
									parsed.usage.output_tokens ||
									parsed.usage.completion_tokens ||
									0,
								totalTokens: parsed.usage.total_tokens || 0,
							});
						}
					} catch {
						// Not a valid JSON object, skip
					}
					i = end;
				} else {
					break;
				}
			}
		}

		const finalText = answerText || anyText;
		if (finalText) onChunk(finalText);
		onDone();
	} catch (err) {
		onError(err instanceof Error ? err : new Error(String(err)));
	}
}

/**
 * Frame masks that can carry assistant text.
 *
 * Kimi's stream is a run of length-prefixed JSON frames, each naming what it
 * updates in a `mask` field. Only these three ever hold reply text; the rest
 * (`chat.lastRequest`, `chat.name`, `message.status`) are bookkeeping whose
 * strings must never end up in the answer.
 */
export const KIMI_TEXT_MASKS = new Set([
	"message",
	"block.text",
	"block.text.content",
]);

/**
 * Pull the assistant's text out of one Kimi stream frame.
 *
 * The role check is the whole point. Kimi echoes the message we just sent back
 * as its own frame — `{"mask":"message","message":{"role":"user","blocks":[...]}}`,
 * eventOffset 2, before the assistant's first token — and this function used to
 * return the first text it could find anywhere in any frame. So every reply
 * arrived as our own prompt with the real answer stuck on the end. The manager
 * prompt's worked examples were then parsed as if the model had written them:
 * workers got dispatched, the example command ran, and the retry loop bounced
 * the same complaint back six times because the echo came round again with it.
 *
 * A frame that names a role other than `assistant` holds no answer, and a frame
 * whose mask is not a text mask holds no answer either. Both return null rather
 * than falling through to the generic search below, which is broad enough to
 * find a string in almost anything.
 */
export function extractTextFragment(obj: any): string | null {
	if (typeof obj !== "object" || obj === null) return null;

	if (Array.isArray(obj)) {
		for (const item of obj) {
			const result = extractTextFragment(item);
			if (result) return result;
		}
		return null;
	}

	if (typeof obj.mask === "string" && !KIMI_TEXT_MASKS.has(obj.mask)) {
		return null;
	}
	const role = obj.message?.role;
	if (typeof role === "string" && role !== "assistant") {
		return null;
	}

	// Kimi's response format: message -> blocks -> text -> content (for requests)
	// or blocks -> text -> content (for responses)
	if (obj.message && obj.message.blocks && Array.isArray(obj.message.blocks)) {
		for (const block of obj.message.blocks) {
			if (block.text && typeof block.text.content === "string") {
				return block.text.content;
			}
		}
	}

	if (obj.blocks && Array.isArray(obj.blocks)) {
		for (const block of obj.blocks) {
			if (block.text && typeof block.text.content === "string") {
				return block.text.content;
			}
		}
	}

	if (obj.text && typeof obj.text.content === "string") {
		return obj.text.content;
	}

	if (typeof obj.content === "string") {
		return obj.content;
	}

	// Recurse into values
	for (const key of Object.keys(obj)) {
		const result = extractTextFragment(obj[key]);
		if (result) return result;
	}

	return null;
}
