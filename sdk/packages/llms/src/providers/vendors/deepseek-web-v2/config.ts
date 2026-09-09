import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveActiveProfilePaths } from "../tool-pipeline/browser-profiles";
export const DEEPSEEK_WEB_URL = "https://chat.deepseek.com/";

export const CONFIG_DIR = path.join(os.homedir(), ".cline", "deepseek-web-v2");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export const DEFAULT_DEBUG_PORT = 9222;
export const DEFAULT_LAUNCH_TIMEOUT_MS = 20_000;
export const DEFAULT_RESPONSE_TIMEOUT_MS = 1_200_000; // 1200s (20 mins) to prevent premature timeout on long thinking/tool calls
export const DEFAULT_LOGIN_TIMEOUT_MS = 120_000;
export const DEFAULT_TOOL_PROMPT_THRESHOLD_CHARS = 20_000;
/**
 * Where the CLI-conversation -> DeepSeek web chat mapping is persisted, so a
 * resumed/forked CLI chat reopens its original DeepSeek web conversation
 * (mirrors the `chat_sessions.json` in the reference `start_continue_chat.py`).
 */

/**
 * One-shot "recover from a throttle/block" signal. When DeepSeek rate-limited
 * the last turn ("Messages too frequent"), the page can be left in a stale or
 * temporarily-blocked state. On the next `runCompletion` we FORCE a page reload
 * even if the URL already matches the target chat — this clears the blocked
 * page and lets the composer work normally again. The flag is consumed (reset)
 * after one forced reload so healthy turns still skip reloading.
 */
let recoverFromThrottle = false;

/** Mark that the next turn must force a page reload to clear a throttle block. */
export function requestThrottleRecoveryReload(): void {
	recoverFromThrottle = true;
}

/** `true` exactly once, then reset — i.e. consume the pending recovery reload. */
export function consumeThrottleRecoveryReload(): boolean {
	const shouldReload = recoverFromThrottle;
	recoverFromThrottle = false;
	return shouldReload;
}

const DEFAULT_MIN_SEND_DELAY_MS = 800;
const DEFAULT_MAX_SEND_DELAY_MS = 2_800;
/** Extra randomized delay added when the turn is itself a tool-call turn. */
const DEFAULT_TOOL_TURN_EXTRA_MIN_MS = 1_500;
const DEFAULT_TOOL_TURN_EXTRA_MAX_MS = 4_500;

/** Whether the full `<tool>` contract + tool list is sent on every turn. */
export type ToolPromptMode = "lean" | "always";

export interface DeepSeekWebV2RuntimeConfig {
	chromePath?: string;
	profileDir?: string;
	debugPort: number;
	headless: boolean;
	debug: boolean;
	launchTimeoutMs: number;
	responseTimeoutMs: number;
	/** How long to wait for the composer to become usable (login + hydration). */
	loginTimeoutMs: number;
	/**
	 * Path to the persistent chat-session registry (CLI chat key -> DeepSeek
	 * web `session_id`). Overridable via DEEPSEEK_WEB_V2_CHATS_FILE so multiple
	 * profiles/processes don't fight over the same mapping.
	 */
	chatsFile: string;
	/**
	 * Legacy: accepted for backward compatibility with existing config files.
	 * The tool-contract block is no longer prepended (the system prompt itself
	 * carries the `<tool>` protocol and tool list), so this no longer changes
	 * the prompt.
	 */
	toolPromptMode: ToolPromptMode;
	/** Legacy: accepted for backward compatibility; no longer used. */
	toolPromptThresholdChars: number;
	/**
	 * Lower bound of the random sleep applied before each message send.
	 * Randomized (with `maxSendDelayMs`) so sends don't look machine-gunned.
	 */
	minSendDelayMs: number;
	/** Upper bound of the random sleep applied before each message send. */
	maxSendDelayMs: number;
	/**
	 * Lower bound of the EXTRA random sleep added on turns that are themselves
	 * tool-request turns (the fastest back-to-back pattern in an agent run).
	 */
	toolTurnExtraMinMs: number;
	/** Upper bound of the EXTRA random sleep added on tool-request turns. */
	toolTurnExtraMaxMs: number;
}

function readConfigFile(): Partial<DeepSeekWebV2RuntimeConfig> {
	try {
		return JSON.parse(
			fs.readFileSync(CONFIG_FILE, "utf-8"),
		) as Partial<DeepSeekWebV2RuntimeConfig>;
	} catch {
		return {};
	}
}

/**
 * Env vars win over the config file, mirroring the llamacpp runtime pattern so
 * scripted/CI runs can override without editing files.
 */
export function resolveDeepSeekWebV2Config(): DeepSeekWebV2RuntimeConfig {
	const fileConfig = readConfigFile();
	// The active named profile (`/profile`) decides which Chrome user-data-dir,
	// debug port and chat registry this provider uses, so one provider can be
	// driven with several logins. Env vars and config.json still win over it.
	const profile = resolveActiveProfilePaths(CONFIG_DIR, DEFAULT_DEBUG_PORT);
	const port =
		Number(process.env.DEEPSEEK_WEB_V2_DEBUG_PORT ?? fileConfig.debugPort) ||
		profile.debugPort;
	return {
		chromePath:
			process.env.DEEPSEEK_WEB_V2_CHROME_PATH || fileConfig.chromePath,
		profileDir:
			process.env.DEEPSEEK_WEB_V2_PROFILE_DIR ||
			fileConfig.profileDir ||
			profile.profileDir,
		debugPort: port,
		headless:
			process.env.DEEPSEEK_WEB_V2_HEADLESS !== undefined
				? process.env.DEEPSEEK_WEB_V2_HEADLESS !== "false"
				: (fileConfig.headless ?? false),
		debug:
			process.env.DEEPSEEK_WEB_V2_DEBUG !== undefined
				? process.env.DEEPSEEK_WEB_V2_DEBUG !== "false"
				: (fileConfig.debug ?? false),
		launchTimeoutMs:
			Number(
				process.env.DEEPSEEK_WEB_V2_LAUNCH_TIMEOUT_MS ??
					fileConfig.launchTimeoutMs,
			) || DEFAULT_LAUNCH_TIMEOUT_MS,
		responseTimeoutMs:
			Number(
				process.env.DEEPSEEK_WEB_V2_RESPONSE_TIMEOUT_MS ??
					fileConfig.responseTimeoutMs,
			) || DEFAULT_RESPONSE_TIMEOUT_MS,
		loginTimeoutMs:
			Number(
				process.env.DEEPSEEK_WEB_V2_LOGIN_TIMEOUT_MS ??
					fileConfig.loginTimeoutMs,
			) || DEFAULT_LOGIN_TIMEOUT_MS,
		toolPromptMode:
			(process.env.DEEPSEEK_WEB_V2_TOOL_PROMPT_MODE ??
				fileConfig.toolPromptMode) === "always"
				? "always"
				: "lean",
		toolPromptThresholdChars:
			Number(
				process.env.DEEPSEEK_WEB_V2_TOOL_PROMPT_THRESHOLD_CHARS ??
					fileConfig.toolPromptThresholdChars,
			) || DEFAULT_TOOL_PROMPT_THRESHOLD_CHARS,
		minSendDelayMs:
			Number(
				process.env.DEEPSEEK_WEB_V2_MIN_SEND_DELAY_MS ??
					fileConfig.minSendDelayMs,
			) || DEFAULT_MIN_SEND_DELAY_MS,
		maxSendDelayMs:
			Number(
				process.env.DEEPSEEK_WEB_V2_MAX_SEND_DELAY_MS ??
					fileConfig.maxSendDelayMs,
			) || DEFAULT_MAX_SEND_DELAY_MS,
		toolTurnExtraMinMs:
			Number(
				process.env.DEEPSEEK_WEB_V2_TOOL_TURN_EXTRA_MIN_MS ??
					fileConfig.toolTurnExtraMinMs,
			) || DEFAULT_TOOL_TURN_EXTRA_MIN_MS,
		toolTurnExtraMaxMs:
			Number(
				process.env.DEEPSEEK_WEB_V2_TOOL_TURN_EXTRA_MAX_MS ??
					fileConfig.toolTurnExtraMaxMs,
			) || DEFAULT_TOOL_TURN_EXTRA_MAX_MS,
		chatsFile:
			process.env.DEEPSEEK_WEB_V2_CHATS_FILE ||
			fileConfig.chatsFile ||
			profile.chatsFile,
	};
}

/**
 * Random integer in the inclusive `[min, max]` range. `rng` is injectable so
 * tests can pin a deterministic value; defaults to `Math.random`.
 */
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

/**
 * Compute the randomized sleep to apply before sending one message to the
 * DeepSeek web UI. Every send waits a random `[min,max]` amount; tool-request
 * turns (the most rapid-fire pattern in an agent run) get an extra random
 * delay on top, making the pacing irregular enough to dodge the
 * "Messages too frequent" throttle while still being clearly randomized.
 *
 * `rng` is injectable for deterministic tests (defaults to `Math.random`).
 */
export function computeSendDelay(
	config: Pick<
		DeepSeekWebV2RuntimeConfig,
		| "minSendDelayMs"
		| "maxSendDelayMs"
		| "toolTurnExtraMinMs"
		| "toolTurnExtraMaxMs"
	>,
	opts: { isToolTurn: boolean },
	rng: () => number = Math.random,
): number {
	const base = randomInRange(config.minSendDelayMs, config.maxSendDelayMs, rng);
	if (!opts.isToolTurn) return base;
	const extra = randomInRange(
		config.toolTurnExtraMinMs,
		config.toolTurnExtraMaxMs,
		rng,
	);
	return base + extra;
}

/**
 * Human-ish markers DeepSeek uses to say "slow down". Used to detect a
 * throttled reply so the provider can log/back off instead of misinterpreting
 * it as a normal (possibly shorter-context) completion.
 */
const RATE_LIMIT_TEXT_RE =
	/Messages too frequent|Try again later|too many requests|rate.limit|slow down/i;

/** Return `true` when `text` looks like a DeepSeek anti-abuse / throttle reply. */
export function isRateLimitText(text: string): boolean {
	return RATE_LIMIT_TEXT_RE.test(text);
}
export { findChromePath } from "../tool-pipeline/browser-path";
export const sleep = (ms: number) =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** A ReadableStream we can push bytes into from the CDP IO.read loop. */
export interface PushSink {
	stream: ReadableStream<Uint8Array>;
	push(chunk: Uint8Array): void;
	close(): void;
	error(err: unknown): void;
}

export function createPushSink(): PushSink {
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let closed = false;
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
		cancel() {
			closed = true;
		},
	});
	return {
		stream,
		push(chunk) {
			if (closed) return;
			try {
				controller?.enqueue(chunk);
			} catch {
				// sink already errored/closed — ignore late pushes
			}
		},
		close() {
			if (closed) return;
			closed = true;
			try {
				controller?.close();
			} catch {
				// ignore
			}
		},
		error(err) {
			if (closed) return;
			closed = true;
			try {
				controller?.error(err);
			} catch {
				// ignore
			}
		},
	};
}
