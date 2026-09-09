import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	resolveActiveProfilePaths,
	resolveProfileDebugPort,
} from "../tool-pipeline/browser-profiles";

export const CONFIG_DIR = path.join(os.homedir(), ".cline", "claude-web");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export const CLAUDE_WEB_URL = "https://claude.ai/";
export const CLAUDE_API_ENDPOINT = "/chat_conversations/";
export const CLAUDE_COMPLETION_PATH = "/completion";

export const DEFAULT_DEBUG_PORT = 9225;
export const DEFAULT_LAUNCH_TIMEOUT_MS = 30000;
export const DEFAULT_RESPONSE_TIMEOUT_MS = 1200000;
export const DEFAULT_LOGIN_TIMEOUT_MS = 120000;
export const DEFAULT_MIN_SEND_DELAY_MS = 800;
export const DEFAULT_MAX_SEND_DELAY_MS = 2800;
export const DEFAULT_TOOL_TURN_EXTRA_MIN_MS = 1500;
export const DEFAULT_TOOL_TURN_EXTRA_MAX_MS = 4500;

export const sleep = (ms: number) =>
	new Promise((resolve) => setTimeout(resolve, ms));

export interface ChatSessionRecord {
	session_id: string;
	first_seen: string;
	last_active: string;
}

export interface ClaudeWebChatEntry {
	chatKey: string;
	sessionId: string;
	firstSeen: string;
	lastActive: string;
}

export interface ClaudeWebV2RuntimeConfig {
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
	/** Set per turn from the routed model, not from the env config. */
	contextWindow?: number;
}

function readConfigFile(): Partial<ClaudeWebV2RuntimeConfig> {
	try {
		return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
	} catch {
		return {};
	}
}

export function resolveClaudeWebV2Config(): ClaudeWebV2RuntimeConfig {
	const fileConfig = readConfigFile();
	// The active named profile (`/profile`) decides which Chrome user-data-dir,
	// debug port and chat registry this provider uses, so one provider can be
	// driven with several logins. Env vars and config.json still win over it.
	const profile = resolveActiveProfilePaths(CONFIG_DIR, DEFAULT_DEBUG_PORT);
	// The profile's port OFFSET is applied on top of whatever base port was
	// chosen, rather than being a fallback for it. A `debugPort` in
	// config.json used to win outright, so every profile landed on one port,
	// attached to the Chrome already listening there, and shared one account.
	const port = resolveProfileDebugPort(
		Number(process.env.CLAUDE_WEB_DEBUG_PORT ?? fileConfig.debugPort) ||
			DEFAULT_DEBUG_PORT,
	);
	return {
		chromePath: process.env.CLAUDE_WEB_CHROME_PATH || fileConfig.chromePath,
		profileDir:
			process.env.CLAUDE_WEB_PROFILE_DIR ||
			fileConfig.profileDir ||
			profile.profileDir,
		debugPort: port,
		headless:
			process.env.CLAUDE_WEB_HEADLESS !== undefined
				? process.env.CLAUDE_WEB_HEADLESS !== "false"
				: (fileConfig.headless ?? false),
		debug:
			process.env.CLAUDE_WEB_DEBUG !== undefined
				? process.env.CLAUDE_WEB_DEBUG !== "false"
				: (fileConfig.debug ?? false),
		launchTimeoutMs:
			Number(
				process.env.CLAUDE_WEB_LAUNCH_TIMEOUT_MS ?? fileConfig.launchTimeoutMs,
			) || DEFAULT_LAUNCH_TIMEOUT_MS,
		responseTimeoutMs:
			Number(
				process.env.CLAUDE_WEB_RESPONSE_TIMEOUT_MS ??
					fileConfig.responseTimeoutMs,
			) || DEFAULT_RESPONSE_TIMEOUT_MS,
		loginTimeoutMs:
			Number(
				process.env.CLAUDE_WEB_LOGIN_TIMEOUT_MS ?? fileConfig.loginTimeoutMs,
			) || DEFAULT_LOGIN_TIMEOUT_MS,
		chatsFile:
			process.env.CLAUDE_WEB_CHATS_FILE ||
			fileConfig.chatsFile ||
			profile.chatsFile,
		minSendDelayMs:
			Number(
				process.env.CLAUDE_WEB_MIN_SEND_DELAY_MS ?? fileConfig.minSendDelayMs,
			) || DEFAULT_MIN_SEND_DELAY_MS,
		maxSendDelayMs:
			Number(
				process.env.CLAUDE_WEB_MAX_SEND_DELAY_MS ?? fileConfig.maxSendDelayMs,
			) || DEFAULT_MAX_SEND_DELAY_MS,
		toolTurnExtraMinMs:
			Number(
				process.env.CLAUDE_WEB_TOOL_TURN_EXTRA_MIN_MS ??
					fileConfig.toolTurnExtraMinMs,
			) || DEFAULT_TOOL_TURN_EXTRA_MIN_MS,
		toolTurnExtraMaxMs:
			Number(
				process.env.CLAUDE_WEB_TOOL_TURN_EXTRA_MAX_MS ??
					fileConfig.toolTurnExtraMaxMs,
			) || DEFAULT_TOOL_TURN_EXTRA_MAX_MS,
	};
}
