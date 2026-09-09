import { ContextLengthExceededError } from "./config";

// ── DeepSeek SSE parsing ───────────────────────────────────────────────────

interface SseFragment {
	content?: string;
	type?: string;
}

interface DeepSeekCompletionEvent {
	p?: string;
	v?: unknown;
}

/**
 * Read the DeepSeek completion SSE stream, invoking `onText` / `onReasoning`
 * with content fragments as they arrive. Returns the fully buffered text,
 * reasoning, and the latest `accumulated_token_usage` the server reported
 * (the model's own cumulative context-token count for this conversation).
 *
 * `initialThinking` mirrors the reference client's behavior: reasoning models
 * treat un-tagged content as thinking until the first ANSWER/RESPONSE fragment
 * flips the path.
 */
export async function consumeDeepSeekSse(
	body: ReadableStream<Uint8Array>,
	onText?: (text: string) => void,
	onReasoning?: (text: string) => void,
	initialThinking = false,
): Promise<{
	text: string;
	reasoning: string;
	accumulatedTokenUsage?: number;
}> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let text = "";
	let reasoning = "";
	let thinking = initialThinking;
	let accumulatedTokenUsage: number | undefined;

	// DeepSeek reports the cumulative context-token count in several shapes:
	//   - inside the `response` envelope: { response: { accumulated_token_usage: N } }
	//   - a path update:                 { p: "accumulated_token_usage", v: N }
	//   - a batched update:              { p: "response", o: "BATCH", v: [{ p: "accumulated_token_usage", v: N }] }
	// Capture whichever appears last.
	const captureAccumulatedTokens = (candidate: unknown): void => {
		if (typeof candidate !== "number" || !Number.isFinite(candidate)) return;
		if (candidate >= 0) accumulatedTokenUsage = candidate;
	};

	const cleanFragment = (raw: string): string =>
		raw
			.replace(/FINISHED/g, "")
			.replace(/^(SEARCH|WEB_SEARCH|SEARCHING)\s*/i, "");

	const handleFragment = (fragment: SseFragment): void => {
		const type = String(fragment?.type ?? "").toUpperCase();
		if (type === "THINK") thinking = true;
		else if (type === "ANSWER" || type === "RESPONSE") thinking = false;
		if (
			typeof fragment?.content !== "string" ||
			fragment.content.length === 0
		) {
			return;
		}
		const cleaned = cleanFragment(fragment.content);
		if (!cleaned) return;
		if (thinking) {
			reasoning += cleaned;
			onReasoning?.(cleaned);
		} else {
			text += cleaned;
			onText?.(cleaned);
		}
	};

	const handleEvent = (event: DeepSeekCompletionEvent): void => {
		const p = event.p;
		const v = event.v;
		if (v && typeof v === "object" && (v as { response?: unknown }).response) {
			const response = (v as { response?: unknown }).response as {
				thinking_enabled?: boolean;
				fragments?: SseFragment[];
				accumulated_token_usage?: number;
			};
			if (response.thinking_enabled === true) thinking = true;
			else if (response.thinking_enabled === false) thinking = false;
			captureAccumulatedTokens(response.accumulated_token_usage);
			if (Array.isArray(response.fragments)) {
				for (const fragment of response.fragments) handleFragment(fragment);
			}
		}
		if (p === "response/fragments") {
			if (Array.isArray(v)) {
				for (const fragment of v as SseFragment[]) handleFragment(fragment);
			} else if (v && typeof v === "object") {
				handleFragment(v as SseFragment);
			}
		}
		// Path updates: { p: "<path>", v: <value> } and BATCH updates:
		// { p: ..., o: "BATCH", v: [{ p: <path>, v: <value> }, ...] }.
		if (p === "accumulated_token_usage") {
			captureAccumulatedTokens(v);
		}
		if (Array.isArray(v)) {
			for (const entry of v as unknown[]) {
				const rec = entry as { p?: string; v?: unknown };
				if (rec?.p === "accumulated_token_usage") {
					captureAccumulatedTokens(rec.v);
				}
			}
		}
		if (typeof v === "string" && v.length > 0) {
			const cleaned = cleanFragment(v);
			if (!cleaned) return;
			if (thinking) {
				reasoning += cleaned;
				onReasoning?.(cleaned);
			} else {
				text += cleaned;
				onText?.(cleaned);
			}
		}
	};

	try {
		let currentEventType: string | null = null;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;

				// Handle event: lines
				if (trimmed.startsWith("event:")) {
					currentEventType = trimmed.replace(/^event:\s*/, "").trim();
					continue;
				}

				// Handle data: lines
				if (trimmed.startsWith("data:")) {
					const payload = trimmed.replace(/^data:\s*/, "").trim();
					if (!payload || payload === "[DONE]") {
						currentEventType = null;
						continue;
					}

					// If this is a hint event, check for context_length_exceeded
					if (currentEventType === "hint") {
						try {
							const hintData = JSON.parse(payload) as {
								type?: string;
								finish_reason?: string;
							};
							if (
								hintData.type === "error" &&
								hintData.finish_reason === "context_length_exceeded"
							) {
								throw new ContextLengthExceededError(
									"Length limit reached. Please start a new chat.",
								);
							}
						} catch (e) {
							if (e instanceof ContextLengthExceededError) throw e;
							// ignore other malformed hint data
						}
						currentEventType = null;
						continue;
					}

					// Normal event (response/fragments)
					try {
						handleEvent(JSON.parse(payload) as DeepSeekCompletionEvent);
					} catch {
						// ignore malformed lines
					}
					currentEventType = null;
				}
			}
		}
	} finally {
		reader.releaseLock();
	}

	return { text, reasoning, accumulatedTokenUsage };
}
