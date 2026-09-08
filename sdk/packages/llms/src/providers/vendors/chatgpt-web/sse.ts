/**
 * SSE parser for ChatGPT Web responses.
 */

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
	onQuota?: (
		quota: { featureName: string; remaining: number; resetAfter: string }[],
	) => void,
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
			if (parsed.o === "patch" && Array.isArray(parsed.v)) {
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

			// ChatGPT web SSE includes a `conversation_detail_metadata` event with quota info.
			if (
				parsed.type === "conversation_detail_metadata" &&
				Array.isArray(parsed.limits_progress) &&
				onQuota
			) {
				onQuota(parsed.limits_progress);
			}
		}

		const finalText = fullText.trim();
		if (finalText) onChunk(finalText);
		onDone();
	} catch (err) {
		onError(err instanceof Error ? err : new Error(String(err)));
	}
}
