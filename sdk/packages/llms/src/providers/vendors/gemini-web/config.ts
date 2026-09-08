/**
 * Where Gemini Web reads its settings, and the shapes everything else here uses.
 *
 * Split out of the old single-file provider so the tuning knobs are findable
 * without scrolling past the send script and the SSE parser.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveActiveProfilePaths } from "../tool-pipeline/browser-profiles";

export const CONFIG_DIR = path.join(os.homedir(), ".cline", "gemini-web");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export const GEMINI_WEB_URL = "https://gemini.google.com/";
export const GEMINI_API_ENDPOINT = "/StreamGenerate";

export const DEFAULT_DEBUG_PORT = 9226;
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
 * the two must never share recovery state). When Gemini rate-limits a turn, the
 * page can be left blocked; the next `runCompletion` forces a full reload even
 * if the URL already matches to clear it. Consumed (reset) after one reload.
 */
let geminiRecoverFromThrottle = false;

export function requestGeminiThrottleRecoveryReload(): void {
	geminiRecoverFromThrottle = true;
}

export function consumeGeminiThrottleRecoveryReload(): boolean {
	const shouldReload = geminiRecoverFromThrottle;
	geminiRecoverFromThrottle = false;
	return shouldReload;
}

export interface GeminiWebV2RuntimeConfig {
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
}

export interface ChatSessionRecord {
	session_id: string;
	first_seen: string;
	last_active: string;
}

export interface GeminiWebChatEntry {
	chatKey: string;
	sessionId: string;
	firstSeen: string;
	lastActive: string;
}

export function readConfigFile(): Partial<GeminiWebV2RuntimeConfig> {
	try {
		return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
	} catch {
		return {};
	}
}

export function resolveGeminiWebV2Config(): GeminiWebV2RuntimeConfig {
	const fileConfig = readConfigFile();
	// The active named profile (`/profile`) decides which Chrome user-data-dir,
	// debug port and chat registry this provider uses, so one provider can be
	// driven with several logins. Env vars and config.json still win over it.
	const profile = resolveActiveProfilePaths(CONFIG_DIR, DEFAULT_DEBUG_PORT);
	const port =
		Number(process.env.GEMINI_WEB_DEBUG_PORT ?? fileConfig.debugPort) ||
		profile.debugPort;
	return {
		chromePath: process.env.GEMINI_WEB_CHROME_PATH || fileConfig.chromePath,
		profileDir:
			process.env.GEMINI_WEB_PROFILE_DIR ||
			fileConfig.profileDir ||
			profile.profileDir,
		debugPort: port,
		headless:
			process.env.GEMINI_WEB_HEADLESS !== undefined
				? process.env.GEMINI_WEB_HEADLESS !== "false"
				: (fileConfig.headless ?? false),
		debug:
			process.env.GEMINI_WEB_DEBUG !== undefined
				? process.env.GEMINI_WEB_DEBUG !== "false"
				: (fileConfig.debug ?? false),
		launchTimeoutMs:
			Number(
				process.env.GEMINI_WEB_LAUNCH_TIMEOUT_MS ?? fileConfig.launchTimeoutMs,
			) || DEFAULT_LAUNCH_TIMEOUT_MS,
		responseTimeoutMs:
			Number(
				process.env.GEMINI_WEB_RESPONSE_TIMEOUT_MS ??
					fileConfig.responseTimeoutMs,
			) || DEFAULT_RESPONSE_TIMEOUT_MS,
		loginTimeoutMs:
			Number(
				process.env.GEMINI_WEB_LOGIN_TIMEOUT_MS ?? fileConfig.loginTimeoutMs,
			) || DEFAULT_LOGIN_TIMEOUT_MS,
		chatsFile:
			process.env.GEMINI_WEB_CHATS_FILE ||
			fileConfig.chatsFile ||
			profile.chatsFile,
		minSendDelayMs:
			Number(
				process.env.GEMINI_WEB_MIN_SEND_DELAY_MS ?? fileConfig.minSendDelayMs,
			) || DEFAULT_MIN_SEND_DELAY_MS,
		maxSendDelayMs:
			Number(
				process.env.GEMINI_WEB_MAX_SEND_DELAY_MS ?? fileConfig.maxSendDelayMs,
			) || DEFAULT_MAX_SEND_DELAY_MS,
		toolTurnExtraMinMs:
			Number(
				process.env.GEMINI_WEB_TOOL_TURN_EXTRA_MIN_MS ??
					fileConfig.toolTurnExtraMinMs,
			) || DEFAULT_TOOL_TURN_EXTRA_MIN_MS,
		toolTurnExtraMaxMs:
			Number(
				process.env.GEMINI_WEB_TOOL_TURN_EXTRA_MAX_MS ??
					fileConfig.toolTurnExtraMaxMs,
			) || DEFAULT_TOOL_TURN_EXTRA_MAX_MS,
	};
}
