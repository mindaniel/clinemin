/**
 * Qwen SSE parser.
 */

export function consumeQwenSse(
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
		// Thinking-enabled replies tag each delta with `phase` ("think" vs
		// "answer"); prefer the answer-phase text, but also collect every
		// delta regardless of phase as a fallback for replies that never set
		// `phase` at all (thinking disabled, or a differently-shaped
		// response) — matching a known-working reference capture that reads
		// `delta.content` unconditionally instead of gating on `phase`.
		let answerText = "";
		let anyText = "";

		for (const rawLine of body.split("\n")) {
			const line = rawLine.trim();
			if (!line.startsWith("data:")) continue;
			const data = line.slice(5).trim();
			if (!data) continue;
			if (data === "[DONE]") break;

			let parsed: unknown;
			try {
				parsed = JSON.parse(data);
			} catch {
				continue;
			}

			const record = parsed as {
				choices?: {
					delta?: { content?: string; phase?: string };
					message?: { content?: string };
				}[];
				content?: string;
				output?: string | { content?: string };
				usage?: {
					input_tokens?: number;
					output_tokens?: number;
					total_tokens?: number;
				};
			};

			for (const choice of Array.isArray(record.choices)
				? record.choices
				: []) {
				const delta = choice?.delta;
				const deltaContent =
					typeof delta?.content === "string" ? delta.content : "";
				if (deltaContent) {
					anyText += deltaContent;
					if (!delta || delta.phase === "answer" || delta.phase === undefined) {
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

			if (typeof record.content === "string" && record.content) {
				anyText += record.content;
				answerText += record.content;
			}
			if (typeof record.output === "string" && record.output) {
				anyText += record.output;
				answerText += record.output;
			} else if (
				record.output &&
				typeof record.output === "object" &&
				typeof record.output.content === "string" &&
				record.output.content
			) {
				anyText += record.output.content;
				answerText += record.output.content;
			}

			if (record.usage && onUsage) {
				onUsage({
					inputTokens: record.usage.input_tokens || 0,
					outputTokens: record.usage.output_tokens || 0,
					totalTokens: record.usage.total_tokens || 0,
				});
			}
		}

		const finalText = answerText || anyText;
		if (finalText) onChunk(finalText);
		onDone();
	} catch (err) {
		onError(err instanceof Error ? err : new Error(String(err)));
	}
}
