import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveActiveProfilePaths } from "../tool-pipeline/browser-profiles";

export const CONFIG_DIR = path.join(os.homedir(), ".cline", "grok-web");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export const Grok_WEB_URL = "https://grok.com/";
export const Grok_RATE_LIMIT_ENDPOINT = "/rest/rate-limits";

export const DEFAULT_DEBUG_PORT = 9228;
export const DEFAULT_LAUNCH_TIMEOUT_MS = 30000;
export const DEFAULT_RESPONSE_TIMEOUT_MS = 1200000; // Increased to 1200s (20 mins) to prevent premature timeout on long thinking/tool calls
export const DEFAULT_LOGIN_TIMEOUT_MS = 120000;
export const DEFAULT_MIN_SEND_DELAY_MS = 800;
export const DEFAULT_MAX_SEND_DELAY_MS = 2_800;
export const DEFAULT_TOOL_TURN_EXTRA_MIN_MS = 1_500;
export const DEFAULT_TOOL_TURN_EXTRA_MAX_MS = 4_500;

export const sleep = (ms: number) =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One-shot "recover from a throttle/block" signal, mirroring deepseek-web-v2's
 * own flag (kept separate — this provider drives an unrelated tab/profile, so
 * the two must never share recovery state). When Grok rate-limits a turn, the
 * page can be left blocked; the next `runCompletion` forces a full reload even
 * if the URL already matches to clear it. Consumed (reset) after one reload.
 */
let grokRecoverFromThrottle = false;

export function requestGrokThrottleRecoveryReload(): void {
	grokRecoverFromThrottle = true;
}

export function consumeGrokThrottleRecoveryReload(): boolean {
	const shouldReload = grokRecoverFromThrottle;
	grokRecoverFromThrottle = false;
	return shouldReload;
}

export interface ChatSessionRecord {
	session_id: string;
	first_seen: string;
	last_active: string;
}

export interface GrokRateLimitInfo {
	windowSizeSeconds: number;
	remainingQueries: number;
	totalQueries: number;
	lowEffortRateLimits: unknown | null;
	highEffortRateLimits: unknown | null;
}

export interface GrokWebChatEntry {
	chatKey: string;
	sessionId: string;
	firstSeen: string;
	lastActive: string;
}

export interface GrokWebV2RuntimeConfig {
	chromePath?: string;
	profileDir?: string;
	debugPort: number;
	headless: boolean;
	debug: boolean;
	launchTimeoutMs: number;
	responseTimeoutMs: number;
	loginTimeoutMs: number;
	chatsFile: string;
	/** Lower/upper bound of the randomized sleep applied before each send. */
	minSendDelayMs: number;
	maxSendDelayMs: number;
	/** Extra randomized delay added on turns that themselves request tools. */
	toolTurnExtraMinMs: number;
	toolTurnExtraMaxMs: number;
	/** Callback fired when rate limit info is captured from the /rest/rate-limits endpoint. */
	onRateLimitUpdate?: (info: GrokRateLimitInfo) => void;
}

function readConfigFile(): Partial<GrokWebV2RuntimeConfig> {
	try {
		return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
	} catch {
		return {};
	}
}

export function resolveGrokWebV2Config(): GrokWebV2RuntimeConfig {
	const fileConfig = readConfigFile();
	// The active named profile (`/profile`) decides which Chrome user-data-dir,
	// debug port and chat registry this provider uses, so one provider can be
	// driven with several logins. Env vars and config.json still win over it.
	const profile = resolveActiveProfilePaths(CONFIG_DIR, DEFAULT_DEBUG_PORT);
	const port =
		Number(process.env.Grok_WEB_DEBUG_PORT ?? fileConfig.debugPort) ||
		profile.debugPort;
	return {
		chromePath: process.env.Grok_WEB_CHROME_PATH || fileConfig.chromePath,
		profileDir:
			process.env.Grok_WEB_PROFILE_DIR ||
			fileConfig.profileDir ||
			profile.profileDir,
		debugPort: port,
		headless:
			process.env.Grok_WEB_HEADLESS !== undefined
				? process.env.Grok_WEB_HEADLESS !== "false"
				: (fileConfig.headless ?? false),
		debug:
			process.env.Grok_WEB_DEBUG !== undefined
				? process.env.Grok_WEB_DEBUG !== "false"
				: (fileConfig.debug ?? false),
		launchTimeoutMs:
			Number(
				process.env.Grok_WEB_LAUNCH_TIMEOUT_MS ?? fileConfig.launchTimeoutMs,
			) || DEFAULT_LAUNCH_TIMEOUT_MS,
		responseTimeoutMs:
			Number(
				process.env.Grok_WEB_RESPONSE_TIMEOUT_MS ??
					fileConfig.responseTimeoutMs,
			) || DEFAULT_RESPONSE_TIMEOUT_MS,
		loginTimeoutMs:
			Number(
				process.env.Grok_WEB_LOGIN_TIMEOUT_MS ?? fileConfig.loginTimeoutMs,
			) || DEFAULT_LOGIN_TIMEOUT_MS,
		chatsFile:
			process.env.Grok_WEB_CHATS_FILE ||
			fileConfig.chatsFile ||
			profile.chatsFile,
		minSendDelayMs:
			Number(
				process.env.Grok_WEB_MIN_SEND_DELAY_MS ?? fileConfig.minSendDelayMs,
			) || DEFAULT_MIN_SEND_DELAY_MS,
		maxSendDelayMs:
			Number(
				process.env.Grok_WEB_MAX_SEND_DELAY_MS ?? fileConfig.maxSendDelayMs,
			) || DEFAULT_MAX_SEND_DELAY_MS,
		toolTurnExtraMinMs:
			Number(
				process.env.Grok_WEB_TOOL_TURN_EXTRA_MIN_MS ??
					fileConfig.toolTurnExtraMinMs,
			) || DEFAULT_TOOL_TURN_EXTRA_MIN_MS,
		toolTurnExtraMaxMs:
			Number(
				process.env.Grok_WEB_TOOL_TURN_EXTRA_MAX_MS ??
					fileConfig.toolTurnExtraMaxMs,
			) || DEFAULT_TOOL_TURN_EXTRA_MAX_MS,
	};
}
