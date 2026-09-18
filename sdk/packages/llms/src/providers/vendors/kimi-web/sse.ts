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
		// Text blocks from the framed shape, keyed by block id and kept in the
		// order they first appeared. A reply is one block built up by `append`
		// frames, but keying it means a second block can never overwrite the
		// first.
		const blocks = new Map<string, string>();
		const blockOrder: string[] = [];

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

		// 2. If no SSE data was found, or it yielded nothing, the body is Kimi's
		// other shape: a run of length-prefixed JSON frames (the Connect
		// streaming protocol used by
		// /apiv2/kimi.gateway.chat.v1.ChatService/Chat).
		if (!hasSseData || (!answerText && !anyText)) {
			const frames = collectKimiFrames(body);
			for (const frame of frames) {
				applyKimiFrame(frame, blocks, blockOrder);
				const usage = (frame as { usage?: Record<string, number> }).usage;
				if (usage && onUsage) {
					onUsage({
						inputTokens: usage.input_tokens || usage.prompt_tokens || 0,
						outputTokens: usage.output_tokens || usage.completion_tokens || 0,
						totalTokens: usage.total_tokens || 0,
					});
				}
			}
			const assembled = blockOrder.map((id) => blocks.get(id) ?? "").join("");
			if (assembled) {
				anyText += assembled;
				answerText += assembled;
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
 * Split a framed Kimi body into its JSON frames.
 *
 * The frames are length-prefixed — one flag byte, then a four-byte big-endian
 * length — but Chrome hands the body back as a *string*, not bytes, and those
 * prefix bytes are not valid UTF-8, so by the time it reaches here each one has
 * already become U+FFFD. The lengths are unrecoverable; the JSON is not.
 *
 * So frames are found by their opening `{"op":` and read with a brace counter,
 * and — the point of this function — a frame that fails to parse is skipped by
 * resyncing on the *next* `{"op":`. The previous scanner brace-counted straight
 * through the body from the first `{` it saw, with no resync: one mangled byte
 * inside the huge `chat.lastRequest` frame (it carries the whole system prompt,
 * quotes and braces and all) desynced its in-string tracking, and every frame
 * after that was misread as part of one giant object. A 500-frame reply came
 * back as 35 fragments — the answer truncated mid-sentence with whole words
 * missing, so a `<manager>` block arrived with no `</manager>` and `TO:
 * deepseek` read as `TO: deepTOOLS:`.
 */
export function collectKimiFrames(body: string): unknown[] {
	const frames: unknown[] = [];
	const FRAME_START = /\{"op":/g;
	FRAME_START.lastIndex = 0;
	let match = FRAME_START.exec(body);

	while (match !== null) {
		const source = readJsonObjectAt(body, match.index);
		if (source !== undefined) {
			try {
				frames.push(JSON.parse(source));
			} catch {
				// Corrupt frame: drop this one only, and keep going.
			}
		}
		// Always advance by one start marker rather than by the object's length.
		// Resyncing on the next marker is what makes a bad frame cost one frame.
		FRAME_START.lastIndex = match.index + 1;
		match = FRAME_START.exec(body);
	}

	return frames;
}

/** The complete `{...}` beginning at `start`, or undefined when it never closes. */
function readJsonObjectAt(body: string, start: number): string | undefined {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = start; i < body.length; i++) {
		const char = body[i];
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
		if (inString) continue;
		if (char === "{") {
			depth++;
		} else if (char === "}") {
			depth--;
			if (depth === 0) return body.slice(start, i + 1);
		}
	}

	return undefined;
}

/**
 * Fold one frame's text into the blocks being assembled.
 *
 * `op` decides how: `set` replaces a block's text, `append` adds to it. Reading
 * every frame as a replacement would leave only the last token of the reply,
 * and reading every frame as an append would double the text of any block Kimi
 * re-sends in full.
 *
 * Frames that are not text are skipped, and so is the `role: "user"` frame in
 * which Kimi echoes the message we just sent — eventOffset 2, before the
 * assistant's first token. An earlier parser returned the first string it could
 * find in any frame, so every reply arrived with our own prompt glued to the
 * front: the manager prompt's worked examples parsed as real blocks, workers
 * were dispatched, and the retry loop bounced the same complaint back each time
 * the echo came round again.
 */
export function applyKimiFrame(
	frame: unknown,
	blocks: Map<string, string>,
	order: string[],
): void {
	if (typeof frame !== "object" || frame === null) return;
	const record = frame as {
		op?: string;
		mask?: string;
		message?: {
			role?: string;
			blocks?: {
				id?: string;
				messageId?: string;
				text?: { content?: string };
			}[];
		};
		block?: { id?: string; text?: { content?: string } };
	};

	if (typeof record.mask === "string" && !KIMI_TEXT_MASKS.has(record.mask)) {
		return;
	}
	const append = record.op !== "set";

	const write = (id: string, text: string) => {
		if (!blocks.has(id)) {
			blocks.set(id, "");
			order.push(id);
		}
		blocks.set(id, append ? (blocks.get(id) ?? "") + text : text);
	};

	if (record.message) {
		const role = record.message.role;
		if (typeof role === "string" && role !== "assistant") return;
		for (const block of record.message.blocks ?? []) {
			const text = block?.text?.content;
			if (typeof text === "string") {
				write(block.id || block.messageId || "message", text);
			}
		}
		return;
	}

	const text = record.block?.text?.content;
	if (typeof text === "string") {
		write(record.block?.id || "block", text);
	}
}
