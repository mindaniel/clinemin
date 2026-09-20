import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { estimateTokens } from "@cline/shared";

export class ContextLengthExceededError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ContextLengthExceededError";
	}
}

/**
 * DeepSeek answered `{"finish_reason":"rate_limit_reached"}` — "Messages too
 * frequent. Try again later." Its own type so a caller can back off on it
 * rather than string-matching the message.
 */
export class DeepSeekRateLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DeepSeekRateLimitError";
	}
}

export const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

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

// ── Send pacing ────────────────────────────────────────────────────────────

/**
 * An agent run fires one request per tool round with no human typing in
 * between, which chat.deepseek.com answers with
 * `{"finish_reason":"rate_limit_reached"}` — an empty completion, not an HTTP
 * error. Every send waits a random `[min,max]`; a turn that carries tools (the
 * fastest back-to-back pattern) waits an extra random amount on top. Randomized
 * rather than fixed, because an exactly-periodic sender is itself a signal.
 *
 * Mirrors the pacing `deepseek-web-v2` already applies before typing into the
 * composer; this provider posts over HTTP and had none.
 */
const DEFAULT_MIN_SEND_DELAY_MS = 800;
const DEFAULT_MAX_SEND_DELAY_MS = 2_800;
const DEFAULT_TOOL_TURN_EXTRA_MIN_MS = 1_500;
const DEFAULT_TOOL_TURN_EXTRA_MAX_MS = 4_500;

/**
 * Pacing lowers the odds of a throttle but cannot remove them — the window is
 * server-side and shared with any other client using the same account. When it
 * does fire, the turn is recoverable by simply waiting: sleep this long, then
 * send the identical prompt again.
 */
const DEFAULT_RATE_LIMIT_RETRY_DELAY_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX_RETRIES = 3;

export interface DeepSeekWebPacingConfig {
	minSendDelayMs: number;
	maxSendDelayMs: number;
	toolTurnExtraMinMs: number;
	toolTurnExtraMaxMs: number;
	/** How long to wait after a throttle before resending the same prompt. */
	rateLimitRetryDelayMs: number;
	/** Extra sends attempted after a throttle before the error is surfaced. */
	rateLimitMaxRetries: number;
}

const CONFIG_FILE = path.join(
	os.homedir(),
	".cline",
	"deepseek-web",
	"config.json",
);

function readPacingFile(): Partial<DeepSeekWebPacingConfig> {
	try {
		return JSON.parse(
			fs.readFileSync(CONFIG_FILE, "utf-8"),
		) as Partial<DeepSeekWebPacingConfig>;
	} catch {
		return {};
	}
}

/**
 * Env vars win over `~/.cline/deepseek-web/config.json`, which wins over the
 * defaults. `Number(undefined)` is NaN and NaN is falsy, so `||` falls through
 * to the default for anything unset or unparseable — including an explicit 0,
 * which is deliberate: a zero delay is what this exists to prevent.
 */
export function resolveDeepSeekWebPacing(
	env: NodeJS.ProcessEnv = process.env,
): DeepSeekWebPacingConfig {
	const file = readPacingFile();
	return {
		minSendDelayMs:
			Number(env.DEEPSEEK_WEB_MIN_SEND_DELAY_MS ?? file.minSendDelayMs) ||
			DEFAULT_MIN_SEND_DELAY_MS,
		maxSendDelayMs:
			Number(env.DEEPSEEK_WEB_MAX_SEND_DELAY_MS ?? file.maxSendDelayMs) ||
			DEFAULT_MAX_SEND_DELAY_MS,
		toolTurnExtraMinMs:
			Number(
				env.DEEPSEEK_WEB_TOOL_TURN_EXTRA_MIN_MS ?? file.toolTurnExtraMinMs,
			) || DEFAULT_TOOL_TURN_EXTRA_MIN_MS,
		toolTurnExtraMaxMs:
			Number(
				env.DEEPSEEK_WEB_TOOL_TURN_EXTRA_MAX_MS ?? file.toolTurnExtraMaxMs,
			) || DEFAULT_TOOL_TURN_EXTRA_MAX_MS,
		rateLimitRetryDelayMs:
			Number(
				env.DEEPSEEK_WEB_RATE_LIMIT_RETRY_DELAY_MS ??
					file.rateLimitRetryDelayMs,
			) || DEFAULT_RATE_LIMIT_RETRY_DELAY_MS,
		// Unlike the delays, 0 is a meaningful value here — it turns automatic
		// retry off — so it is read with an explicit finite check instead of the
		// `||` fallback the others use.
		rateLimitMaxRetries: readCount(
			env.DEEPSEEK_WEB_RATE_LIMIT_MAX_RETRIES ?? file.rateLimitMaxRetries,
			DEFAULT_RATE_LIMIT_MAX_RETRIES,
		),
	};
}

function readCount(raw: unknown, fallback: number): number {
	if (raw === undefined || raw === null || raw === "") return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return fallback;
	return Math.floor(parsed);
}

/**
 * Sleep `ms`, but in one-second steps so an abort mid-wait is noticed promptly
 * rather than after the full minute. Throws `AbortError` the moment the signal
 * fires, matching what the rest of the client does.
 */
export async function waitWithAbort(
	ms: number,
	signal?: AbortSignal,
	sleepImpl: (ms: number) => Promise<void> = sleep,
): Promise<void> {
	const STEP_MS = 1_000;
	let remaining = ms;
	while (remaining > 0) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const chunk = Math.min(STEP_MS, remaining);
		await sleepImpl(chunk);
		remaining -= chunk;
	}
	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

/** Random integer in the inclusive `[min, max]` range. `rng` is injectable. */
export function randomInRange(
	min: number,
	max: number,
	rng: () => number = Math.random,
): number {
	// Guard against inverted / degenerate ranges so the delay is always sane.
	const low = Math.min(min, max);
	const high = Math.max(min, max);
	if (high <= low) return low;
	return Math.floor(low + rng() * (high - low + 1));
}

/** The randomized sleep to apply before one send. */
export function computeSendDelay(
	config: DeepSeekWebPacingConfig,
	opts: { isToolTurn: boolean },
	rng: () => number = Math.random,
): number {
	const base = randomInRange(config.minSendDelayMs, config.maxSendDelayMs, rng);
	if (!opts.isToolTurn) return base;
	return (
		base +
		randomInRange(config.toolTurnExtraMinMs, config.toolTurnExtraMaxMs, rng)
	);
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
