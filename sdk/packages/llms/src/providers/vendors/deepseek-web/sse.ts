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
 * What the stream actually carried, kept so a turn that produced no text can
 * say why instead of surfacing as the opaque "Model returned empty response".
 *
 * Only `context_length_exceeded` used to be recognised; every other server-side
 * `event: hint` error was parsed, matched nothing, and was dropped by the
 * `catch` below. The stream then ended with `text === ""` and the real reason
 * never left this function.
 */
export interface DeepSeekSseDiagnostics {
	/** `data:` payloads seen, including ones no handler claimed. */
	dataEvents: number;
	/** Verbatim `event: hint` payloads whose `type` was `"error"`. */
	hintErrors: string[];
	/** Last `data:` payload seen, for the tail of an error message. */
	lastPayload?: string;
}

/** Longest payload excerpt quoted back in an error message. */
const DIAGNOSTIC_PAYLOAD_MAX_CHARS = 400;

function excerpt(payload: string): string {
	return payload.length > DIAGNOSTIC_PAYLOAD_MAX_CHARS
		? `${payload.slice(0, DIAGNOSTIC_PAYLOAD_MAX_CHARS)}…`
		: payload;
}

/**
 * True when the stream died on DeepSeek's frequency throttle
 * (`{"finish_reason":"rate_limit_reached"}`), which has its own remedy.
 */
export function isRateLimitDiagnostic(
	diagnostics: DeepSeekSseDiagnostics,
): boolean {
	return diagnostics.hintErrors.some((payload) =>
		payload.includes("rate_limit_reached"),
	);
}

/**
 * Render diagnostics as the body of an "empty response" error. Callers pass
 * this to `new Error(...)` when a stream finished with nothing to show.
 */
export function describeEmptyDeepSeekStream(
	diagnostics: DeepSeekSseDiagnostics,
): string {
	if (diagnostics.hintErrors.length > 0) {
		return `DeepSeek returned no content. Server said: ${diagnostics.hintErrors
			.map(excerpt)
			.join(" | ")}`;
	}
	if (diagnostics.dataEvents === 0) {
		return "DeepSeek returned no content and sent no SSE events at all — the request was accepted but the stream was empty.";
	}
	return `DeepSeek returned no content across ${diagnostics.dataEvents} SSE events. Last event: ${
		diagnostics.lastPayload ? excerpt(diagnostics.lastPayload) : "(none)"
	}`;
}

/**
 * Read the DeepSeek completion SSE stream, invoking `onText` / `onReasoning`
 * with content fragments as they arrive. Returns the fully buffered text,
 * reasoning, the latest `accumulated_token_usage` the server reported (the
 * model's own cumulative context-token count for this conversation), and
 * `diagnostics` describing what the stream carried.
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
	diagnostics: DeepSeekSseDiagnostics;
}> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let text = "";
	let reasoning = "";
	let thinking = initialThinking;
	let accumulatedTokenUsage: number | undefined;
	const diagnostics: DeepSeekSseDiagnostics = {
		dataEvents: 0,
		hintErrors: [],
	};

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

					diagnostics.dataEvents += 1;
					diagnostics.lastPayload = payload;

					// If this is a hint event, check for context_length_exceeded
					if (currentEventType === "hint") {
						try {
							const hintData = JSON.parse(payload) as {
								type?: string;
								finish_reason?: string;
							};
							// Keep every server-side error, not only the one shape we
							// know how to act on. The rest used to fall through the
							// catch below and vanish, leaving an empty stream with no
							// stated cause.
							if (hintData.type === "error") {
								diagnostics.hintErrors.push(payload);
							}
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

	return { text, reasoning, accumulatedTokenUsage, diagnostics };
}
