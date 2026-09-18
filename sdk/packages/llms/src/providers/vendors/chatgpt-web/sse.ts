/**
 * SSE parser for ChatGPT Web responses.
 */

import type { ChatGPTQuotaSnapshot } from "./quota";
import type { ChatGPTSSEEvent } from "./types";

export function consumeChatGPTSse(
	body: string,
	onChunk: (text: string) => void,
	onDone: () => void,
	onError: (err: Error) => void,
	onUsage?: (usage: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
	}) => void,
	onQuota?: (snapshot: ChatGPTQuotaSnapshot) => void,
): void {
	try {
		let fullText = "";

		for (const rawLine of body.split("\n")) {
			const line = rawLine.trim();
			if (!line.startsWith("data:")) continue;
			const data = line.slice(5).trim();
			if (!data || data === "[DONE]") continue;

			let parsed: ChatGPTSSEEvent;
			try {
				parsed = JSON.parse(data);
			} catch {
				continue;
			}
			if (!parsed || typeof parsed !== "object") continue;

			// 1. Handle JSON patch operations: { o: "patch", v: [{ p: "/message/content/parts/0", o: "append", v: "text" }] }
			// Delta encoding v1 only names `o: "patch"` on the first batch; every
			// later batch is a bare `{ v: [...] }` that inherits it. Requiring the
			// `o` kept the first chunk ("Yes.") and dropped the rest of the reply.
			if (
				Array.isArray(parsed.v) &&
				(parsed.o === "patch" || parsed.o === undefined)
			) {
				for (const patch of parsed.v) {
					if (
						patch &&
						typeof patch === "object" &&
						patch.p === "/message/content/parts/0" &&
						patch.o === "append" &&
						typeof patch.v === "string"
					) {
						fullText += patch.v;
					}
				}
				continue;
			}

			// 2. Streaming delta: { v: "...", o: "append" }
			if (typeof parsed.v === "string") {
				if (parsed.o === "patch") continue;
				fullText += parsed.v;
				continue;
			}

			// 3. message.content.parts[] is ChatGPT's normal terminal payload.
			// It can be at the root (parsed.message) or nested under v (parsed.v.message)
			const message =
				parsed.message ||
				(parsed.v && typeof parsed.v === "object" && "message" in parsed.v
					? parsed.v.message
					: undefined);
			if (message && typeof message === "object") {
				// ChatGPT's SSE replays the turn's own user message as a `message`
				// event before the assistant starts streaming, and on the first
				// turn that message carries our system prompt inside it. Appending
				// it made the "reply" contain our own prompt -- whose patch-format
				// example is a literal `*** Begin Patch` block, so
				// `parsePatchBlocks` found it and every ChatGPT turn opened with a
				// phantom `apply_patch` against the example path in that prompt.
				const messageObj = message as {
					author?: { role?: string };
					content?: string | { parts?: string[] };
				};
				const authorRole = messageObj.author?.role;
				if (authorRole && authorRole !== "assistant") continue;
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

			// ChatGPT web SSE includes a `conversation_detail_metadata` event with
			// quota info. The wire fields are snake_case (`feature_name`,
			// `reset_after`); handing them over unmapped left every lookup by
			// `featureName` empty, so the quota was never actually read.
			//
			// The event is forwarded whenever it appears, not only when
			// `limits_progress` is a non-empty array. Once the cap is hit ChatGPT
			// drops that field entirely and the reset time survives only in
			// `model_limits` / `blocked_features`, so gating on it blanked the
			// status bar for exactly the stretch where the reset time matters.
			if (parsed.type === "conversation_detail_metadata" && onQuota) {
				onQuota({
					entries: (parsed.limits_progress ?? []).flatMap((entry) =>
						typeof entry?.feature_name === "string" &&
						typeof entry.remaining === "number" &&
						Number.isFinite(entry.remaining)
							? [
									{
										featureName: entry.feature_name,
										remaining: entry.remaining,
										resetAfter:
											typeof entry.reset_after === "string"
												? entry.reset_after
												: "",
									},
								]
							: [],
					),
					modelLimits: (parsed.model_limits ?? []).map((limit) => ({
						...(typeof limit?.model_slug === "string"
							? { modelSlug: limit.model_slug }
							: {}),
						...(typeof limit?.resets_after === "string"
							? { resetsAfter: limit.resets_after }
							: {}),
					})),
					blockedFeatures: (parsed.blocked_features ?? []).flatMap((feature) =>
						typeof feature?.name === "string"
							? [
									{
										name: feature.name,
										...(typeof feature.resets_after === "string"
											? { resetsAfter: feature.resets_after }
											: {}),
									},
								]
							: [],
					),
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
