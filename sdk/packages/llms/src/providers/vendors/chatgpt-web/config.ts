/**
 * Configuration for ChatGPT Web provider.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	resolveActiveProfilePaths,
	resolveProfileDebugPort,
} from "../tool-pipeline/browser-profiles";

export const CONFIG_DIR = path.join(os.homedir(), ".cline", "chatgpt-web");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const DEFAULT_DEBUG_PORT = 9224;
const DEFAULT_LAUNCH_TIMEOUT_MS = 30000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 1200000; // 20 mins
const DEFAULT_MIN_SEND_DELAY_MS = 2000;
const DEFAULT_MAX_SEND_DELAY_MS = 8000;
const DEFAULT_TOOL_TURN_EXTRA_MIN_MS = 3000;
const DEFAULT_TOOL_TURN_EXTRA_MAX_MS = 12000;

function readConfigFile(): Partial<ChatGPTWebV2RuntimeConfig> {
	try {
		return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
	} catch {
		return {};
	}
}

export function resolveChatGPTWebV2Config(): ChatGPTWebV2RuntimeConfig {
	const fileConfig = readConfigFile();
	// The active named profile (`/profile`) decides which Chrome user-data-dir,
	// debug port and chat registry to use. If none, fall back to the default.
	const { profileDir: activeProfileDir } = resolveActiveProfilePaths(
		CONFIG_DIR,
		DEFAULT_DEBUG_PORT,
	);
	const profileDir =
		fileConfig.profileDir ??
		activeProfileDir ??
		path.join(CONFIG_DIR, "profile");
	// The profile's port OFFSET is applied on top of whatever base port was
	// chosen, rather than being a fallback for it. A `debugPort` in
	// config.json used to win outright, so every profile landed on one port,
	// attached to the Chrome already listening there, and shared one account.
	const debugPort = resolveProfileDebugPort(
		fileConfig.debugPort ?? DEFAULT_DEBUG_PORT,
	);

	return {
		chromePath: fileConfig.chromePath,
		profileDir,
		debugPort,
		headless: fileConfig.headless ?? false,
		debug: fileConfig.debug ?? false,
		launchTimeoutMs: fileConfig.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS,
		responseTimeoutMs:
			fileConfig.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS,
		loginTimeoutMs: fileConfig.loginTimeoutMs ?? 60000,
		chatsFile: fileConfig.chatsFile ?? path.join(profileDir, "chats.json"),
		minSendDelayMs: fileConfig.minSendDelayMs ?? DEFAULT_MIN_SEND_DELAY_MS,
		maxSendDelayMs: fileConfig.maxSendDelayMs ?? DEFAULT_MAX_SEND_DELAY_MS,
		toolTurnExtraMinMs:
			fileConfig.toolTurnExtraMinMs ?? DEFAULT_TOOL_TURN_EXTRA_MIN_MS,
		toolTurnExtraMaxMs:
			fileConfig.toolTurnExtraMaxMs ?? DEFAULT_TOOL_TURN_EXTRA_MAX_MS,
	};
}

export interface ChatGPTWebV2RuntimeConfig {
	chromePath?: string;
	profileDir?: string;
	debugPort: number;
	headless: boolean;
	debug: boolean;
	launchTimeoutMs: number;
	responseTimeoutMs: number;
	loginTimeoutMs: number;
	chatsFile: string;
	minSendDelayMs: number;
	maxSendDelayMs: number;
	toolTurnExtraMinMs: number;
	toolTurnExtraMaxMs: number;
}

export interface ChatSessionRecord {
	session_id: string;
	first_seen: string;
	last_active: string;
}

export interface ChatGPTWebChatEntry {
	chatKey: string;
	sessionId: string;
	firstSeen: string;
	lastActive: string;
}

// Constants
export const CHATGPT_WEB_URL = "https://chatgpt.com/";
export const CHATGPT_API_ENDPOINT = "/backend-api/f/conversation";
export const CDP_CALL_TIMEOUT_MS = 30000;

// Throttle recovery reload flag
let chatgptThrottleRecoveryReloadRequested = false;

export function requestChatGPTThrottleRecoveryReload(): void {
	chatgptThrottleRecoveryReloadRequested = true;
}

export function consumeChatGPTThrottleRecoveryReload(): boolean {
	const requested = chatgptThrottleRecoveryReloadRequested;
	chatgptThrottleRecoveryReloadRequested = false;
	return requested;
}
