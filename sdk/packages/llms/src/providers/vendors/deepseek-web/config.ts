import { estimateTokens } from "@cline/shared";

export class ContextLengthExceededError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ContextLengthExceededError";
	}
}

export const DEEPSEEK_WEB_BASE = "https://chat.deepseek.com";
export const DEEPSEEK_API_BASE = `${DEEPSEEK_WEB_BASE}/api`;
export const COMPLETION_URL = `${DEEPSEEK_API_BASE}/v0/chat/completion`;

// Fingerprint headers the chat.deepseek.com web client (v2.0.0) sends on every
// /api/v0/* request. Sending a stale client version is itself a bot-detection
// signal, so these must match the current build.
export const FAKE_HEADERS: Record<string, string> = {
	Accept: "*/*",
	"Accept-Encoding": "gzip, deflate, br, zstd",
	"Accept-Language": "en-US,en;q=0.9",
	Origin: DEEPSEEK_WEB_BASE,
	Referer: `${DEEPSEEK_WEB_BASE}/`,
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
	"X-Client-Bundle-Id": "com.deepseek.chat",
	"X-Client-Locale": "en-US",
	"X-Client-Platform": "web",
	"X-Client-Version": "2.0.0",
};

export interface PowChallenge {
	algorithm: string;
	challenge: string;
	salt: string;
	signature: string;
	difficulty: number;
	expire_at: number;
	expire_after: number;
	target_path: string;
}

export function resolveModelOptions(modelId: string): {
	modelType: string;
	thinkingEnabled: boolean;
} {
	const m = modelId.toLowerCase();
	// The web UI no longer exposes an expert model — only Instant (chat) and
	// Deep Thinking (reasoner) — so the API "model_type" is always "default".
	// The mode is carried entirely by `thinking_enabled`.
	const modelType = "default";
	const thinkingEnabled =
		m.includes("r1") ||
		m.includes("think") ||
		m.includes("reason") ||
		m.includes("deepthink");
	return { modelType, thinkingEnabled };
}

export interface DeepSeekWebUsageEstimate {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
}

/**
 * Estimate token usage from the exact flat `prompt` string sent to
 * chat.deepseek.com and the buffered reply (`text` + `reasoning`).
 *
 * The web endpoint does not report token counts, so this uses the repo-wide
 * heuristic (`estimateTokens` = chars / 3, conservative) so the context bar,
 * per-turn metrics and session totals show real numbers instead of zeros.
 */
export function estimateDeepSeekWebUsage(
	prompt: string,
	output: string,
): DeepSeekWebUsageEstimate {
	const inputTokens = estimateTokens(prompt.length);
	const outputTokens = estimateTokens(output.length);
	return {
		inputTokens,
		outputTokens,
		totalTokens: inputTokens + outputTokens,
	};
}
