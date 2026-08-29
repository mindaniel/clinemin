/**
 * Claude Web ("claude-web") provider.
 *
 * Drives the real Claude web client (claude.ai) through your installed Chrome
 * via the DevTools Protocol â€” no API key needed.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	LanguageModelV2,
	LanguageModelV2CallOptions,
	LanguageModelV2Content,
	LanguageModelV2FinishReason,
	LanguageModelV2FunctionTool,
	LanguageModelV2Prompt,
	LanguageModelV2StreamPart,
} from "@ai-sdk/provider";
import type {
	BasicLogger,
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
} from "@cline/shared";

import {
	messagesToPrompt,
	parseDeepSeekToolCalls,
	parseLooseDeepSeekToolCalls,
} from "./deepseek-web";
import {
	buildLeanConversation,
	computeSendDelay,
	continuationLabel,
	isRateLimitText,
	isSameChatLocation,
	parseFallbackToolUses,
} from "./deepseek-web-v2";
import {
	abortableSleep,
	abortRace,
	throwIfAborted,
} from "./tool-pipeline/abort";
import {
	browserNotFoundMessage,
	findChromePath,
} from "./tool-pipeline/browser-path";
import { registerLaunchedBrowser } from "./tool-pipeline/browser-processes";
import { resolveActiveProfilePaths } from "./tool-pipeline/browser-profiles";
import { resolveChatKey } from "./tool-pipeline/chat-target";
import { consumePendingInjectedReply } from "./tool-pipeline/injected-reply";
import { parseInvokeStyleToolCalls } from "./tool-pipeline/invoke-parser";
import {
	realUserMessageKey,
	stripPreviousUserBlock,
} from "./tool-pipeline/previous-user-dedupe";
import { validateToolCalls } from "./tool-pipeline/tool-dispatcher";
import type { ProviderFactoryResult } from "./types";

const CONFIG_DIR = path.join(os.homedir(), ".cline", "claude-web");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const CLAUDE_WEB_URL = "https://claude.ai/";
const CLAUDE_API_ENDPOINT = "/chat_conversations/";

const DEFAULT_DEBUG_PORT = 9225;
const DEFAULT_LAUNCH_TIMEOUT_MS = 30000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 1200000; // Increased to 1200s (20 mins) to prevent premature timeout on long thinking/tool calls
const DEFAULT_LOGIN_TIMEOUT_MS = 120000;
const DEFAULT_MIN_SEND_DELAY_MS = 800;
const DEFAULT_MAX_SEND_DELAY_MS = 2_800;
const DEFAULT_TOOL_TURN_EXTRA_MIN_MS = 1_500;
const DEFAULT_TOOL_TURN_EXTRA_MAX_MS = 4_500;
/** Fallback context window when the model definition doesn't report one. */
const CLAUDE_WEB_FALLBACK_CONTEXT_WINDOW = 1_000_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One-shot "recover from a throttle/block" signal, mirroring deepseek-web-v2's
 * own flag (kept separate â€” this provider drives an unrelated tab/profile, so
 * the two must never share recovery state). When Claude rate-limits a turn, the
 * page can be left blocked; the next `runCompletion` forces a full reload even
 * if the URL already matches to clear it. Consumed (reset) after one reload.
 */
let claudeRecoverFromThrottle = false;

function requestClaudeThrottleRecoveryReload(): void {
	claudeRecoverFromThrottle = true;
}

function consumeClaudeThrottleRecoveryReload(): boolean {
	const shouldReload = claudeRecoverFromThrottle;
	claudeRecoverFromThrottle = false;
	return shouldReload;
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
	/**
	 * Context window of the selected model, used to turn the session usage
	 * percent Claude Web reports into an absolute token count for the status bar.
	 */
	contextWindow?: number;
}

interface ChatSessionRecord {
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
	const port =
		Number(process.env.CLAUDE_WEB_DEBUG_PORT ?? fileConfig.debugPort) ||
		profile.debugPort;
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

async function isEndpointUp(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
			signal: AbortSignal.timeout(2000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

// â”€â”€ CDP Client â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

class CdpClient {
	private ws: WebSocket;
	private id = 0;
	private pending = new Map<
		number,
		{ resolve: (value: any) => void; reject: (reason: any) => void }
	>();
	private listeners = new Map<
		string,
		Set<(params: any, sessionId?: string) => void>
	>();

	constructor(wsUrl: string) {
		this.ws = new WebSocket(wsUrl);
		this.ws.addEventListener("message", (event: any) => {
			try {
				const data = event.data;
				const msg = JSON.parse(data.toString());
				if (msg.id !== undefined && this.pending.has(msg.id)) {
					const { resolve, reject } = this.pending.get(msg.id)!;
					this.pending.delete(msg.id);
					if (msg.error) reject(new Error(msg.error.message));
					else resolve(msg.result);
				} else if (msg.method) {
					const cbs = this.listeners.get(msg.method);
					if (cbs) {
						for (const cb of cbs) {
							try {
								cb(msg.params, msg.sessionId);
							} catch {
								/* ignore */
							}
						}
					}
				}
			} catch {
				/* ignore */
			}
		});
	}

	waitOpen(): Promise<void> {
		return new Promise((resolve, reject) => {
			const t = setTimeout(
				() => reject(new Error("CDP websocket timeout")),
				8000,
			);
			const onOpen = () => {
				clearTimeout(t);
				resolve();
			};
			const onError = () => {
				clearTimeout(t);
				reject(new Error("CDP websocket error"));
			};
			this.ws.addEventListener("open", onOpen);
			this.ws.addEventListener("error", onError);
		});
	}

	send(method: string, params: any = {}, sessionId?: string): Promise<any> {
		const id = ++this.id;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws.send(
				JSON.stringify({
					id,
					method,
					params,
					...(sessionId ? { sessionId } : {}),
				}),
			);
			setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error(`CDP timeout: ${method}`));
				}
			}, 30000);
		});
	}

	on(method: string, cb: (params: any, sessionId?: string) => void): void {
		if (!this.listeners.has(method)) this.listeners.set(method, new Set());
		this.listeners.get(method)?.add(cb);
	}

	off(method: string, cb: (params: any, sessionId?: string) => void): void {
		this.listeners.get(method)?.delete(cb);
	}

	isOpen(): boolean {
		return this.ws.readyState === WebSocket.OPEN;
	}

	close(): void {
		this.ws.close();
	}
}

let activeCdp: CdpClient | null = null;
let activeCdpKey: string | null = null;

// Cache the attached page target + its CDP session so consecutive turns reuse
// the SAME session instead of re-attaching (and re-toggling the Network
// domain) on every message — the same first-message "empty response" fix
// applied to chatgpt-web and gemini-web.
let activeClaudeTargetId: string | null = null;
let activeClaudeCdpSessionId: string | null = null;

// Sessions whose Network domain is already enabled. Enable once and leave it
// on for the session's lifetime; toggling it per turn made capture flaky.
const claudeNetworkEnabledSessions = new Set<string>();

async function connectCdp(port: number, timeoutMs: number): Promise<CdpClient> {
	const endpoint = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const version = (await (
				await fetch(`${endpoint}/json/version`)
			).json()) as { webSocketDebuggerUrl: string };
			const cdp = new CdpClient(version.webSocketDebuggerUrl);
			await cdp.waitOpen();
			return cdp;
		} catch (err) {
			lastError = err;
			await sleep(750);
		}
	}
	const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
	throw new Error(
		`Could not connect to Chrome DevTools at ${endpoint} within ${Math.round(timeoutMs / 1000)}s${detail}`,
	);
}
async function waitForEndpoint(port: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			if (await isEndpointUp(port)) {
				return;
			}
		} catch (err) {
			lastError = err;
		}
		await sleep(500);
	}
	const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
	throw new Error(
		`Chrome DevTools endpoint at port ${port} did not become available within ${Math.round(timeoutMs / 1000)}s${detail}`,
	);
}

async function connectBrowser(
	config: ClaudeWebV2RuntimeConfig,
): Promise<CdpClient> {
	const key = `${config.debugPort}`;
	if (activeCdp && activeCdpKey === key && activeCdp.isOpen()) {
		return activeCdp;
	}
	// A different key means a different browser — `/profile` switched the
	// user-data-dir and with it the debug port. Drop the old socket rather than
	// leaking it; the Chrome behind it stays up so switching back is instant.
	if (activeCdp && activeCdpKey !== key) {
		try {
			activeCdp.close();
		} catch {
			// Already gone; nothing to release.
		}
		activeCdp = null;
		activeCdpKey = null;
	}

	const connectTimeoutMs = Math.max(config.launchTimeoutMs, 30000);

	if (await isEndpointUp(config.debugPort)) {
		activeCdp = await connectCdp(config.debugPort, connectTimeoutMs);
		activeCdpKey = key;
		return activeCdp;
	}

	const executablePath = config.chromePath ?? findChromePath();
	if (!executablePath) {
		throw new Error(
			browserNotFoundMessage(
				"~/.cline/claude-web/config.json",
				"CLAUDE_WEB_CHROME_PATH",
			),
		);
	}
	const profileDir = config.profileDir ?? path.join(CONFIG_DIR, "profile");
	fs.mkdirSync(profileDir, { recursive: true });

	const args = [
		`--remote-debugging-port=${config.debugPort}`,
		`--user-data-dir=${profileDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--remote-allow-origins=*",
		CLAUDE_WEB_URL,
	];
	if (config.headless) args.push("--headless=new");

	const child = spawn(executablePath, args, {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	// We own this browser, so the CLI can close it on exit instead of leaving
	// it holding the debug port. See tool-pipeline/browser-processes.ts.
	if (child.pid) {
		registerLaunchedBrowser({
			providerId: "claude-web",
			pid: child.pid,
			debugPort: config.debugPort,
		});
	}

	try {
		await waitForEndpoint(config.debugPort, config.launchTimeoutMs);
	} catch (err) {
		throw new Error(
			`Failed to launch Chrome for Claude Web: ${(err as Error).message}. ` +
				"If Chrome is already running with this profile, close it or set a different CLAUDE_WEB_PROFILE_DIR.",
		);
	}
	activeCdp = await connectCdp(config.debugPort, connectTimeoutMs);
	activeCdpKey = key;
	return activeCdp;
}

// â”€â”€ Enhanced Claude send script (from send_claude.txt) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const SEND_MESSAGE_SOURCE = `
// ---------- 1. Set text in editor ----------
async function setClaudeInput(message) {
    const selectors = [
        '[data-testid="chat-input"]',
        '#prompt-textarea',
        'textarea[name="prompt"]',
        'textarea[placeholder*="Message" i]',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]'
    ];
    
    let editor = null;
    for (const sel of selectors) {
        editor = document.querySelector(sel);
        if (editor) break;
    }

    if (!editor) {
        console.error('âŒ Input editor not found. Available inputs:', Array.from(document.querySelectorAll('textarea, div[contenteditable="true"]')).map(e => e.tagName + (e.className ? '.'+e.className : '')));
        return false;
    }

    editor.focus();
    await new Promise(resolve => setTimeout(resolve, 100));

    if (editor.tagName.toLowerCase() === 'textarea' || editor.tagName.toLowerCase() === 'input') {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
        if (nativeInputValueSetter) {
            nativeInputValueSetter.call(editor, message);
        } else {
            editor.value = message;
        }
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
        editor.innerHTML = '';
        try {
            document.execCommand('insertText', false, message);
        } catch (e) {
            editor.innerText = message;
        }
        editor.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: message
        }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
    }
    
    await new Promise(resolve => setTimeout(resolve, 300));
    return true;
}

// ---------- 2. Click the send button ----------
async function waitForSendButton(timeout) {
    timeout = timeout || 5000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const selectors = [
            'button[data-testid="chat-input-send"]',
            'button[type="submit"]',
            '.send-button',
            'button[aria-label*="Send" i]',
            'button[aria-label*="å‘é€" i]',
            'button.send-message-button'
        ];
        for (const sel of selectors) {
            const btn = document.querySelector(sel);
            if (btn && !btn.disabled && btn.offsetParent !== null) return btn;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    return null;
}

async function clickClaudeSend() {
    const sendBtn = await waitForSendButton();
    if (sendBtn) {
        sendBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        sendBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        sendBtn.click();
        console.log('âœ… Send button clicked');
        return true;
    }
    
    const selectors = [
        '[data-testid="chat-input"]',
        '#prompt-textarea',
        'textarea[name="prompt"]',
        'div[contenteditable="true"]'
    ];
    let editor = null;
    for (const sel of selectors) {
        editor = document.querySelector(sel);
        if (editor) break;
    }
    
    if (editor) {
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        console.log('âœ… Enter key dispatched as fallback');
        return true;
    }
    
    console.warn('âŒ Send button not found and Enter key failed');
    return false;
}

// ---------- 3. Main function ----------
async function sendMessageToClaude(message, options) {
    options = options || {};
    const inputSuccess = await setClaudeInput(message);
    if (!inputSuccess) {
        console.error('âŒ Failed to set input');
        return false;
    }

    await new Promise(resolve => setTimeout(resolve, 500));

    const sendSuccess = await clickClaudeSend();
    if (sendSuccess) {
        console.log('âœ… Message sent successfully: ' + message.substring(0, 50) + '...');
    }
    return sendSuccess;
}
`;

function buildSendScript(
	prompt: string,
	options?: { think?: boolean },
): string {
	const opts = options || {};
	return `(async () => {
        ${SEND_MESSAGE_SOURCE}
        await sendMessageToClaude(${JSON.stringify(prompt)}, ${JSON.stringify(opts)});
    })(); true;`;
}

// â”€â”€ Chat session persistence â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function readChatRegistry(
	chatsFile: string,
): Record<string, ChatSessionRecord> {
	try {
		return JSON.parse(fs.readFileSync(chatsFile, "utf-8"));
	} catch {
		return {};
	}
}

function writeChatRegistry(
	chatsFile: string,
	registry: Record<string, ChatSessionRecord>,
): void {
	try {
		fs.mkdirSync(path.dirname(chatsFile), { recursive: true });
		fs.writeFileSync(chatsFile, JSON.stringify(registry, null, 2), "utf-8");
	} catch (error) {
		console.warn(`[claude-web] failed to persist chat registry: ${error}`);
	}
}

export function lookupClaudeChatSession(
	chatsFile: string,
	chatKey: string,
): string | undefined {
	return readChatRegistry(chatsFile)[chatKey]?.session_id;
}

export function recordClaudeChatSession(
	chatsFile: string,
	chatKey: string,
	sessionId: string,
): void {
	const registry = readChatRegistry(chatsFile);
	const existing = registry[chatKey];
	registry[chatKey] = {
		session_id: sessionId,
		first_seen: existing?.first_seen ?? new Date().toISOString(),
		last_active: new Date().toISOString(),
	};
	writeChatRegistry(chatsFile, registry);
}

export function deleteClaudeChatSession(
	chatsFile: string,
	chatKey: string,
): void {
	const registry = readChatRegistry(chatsFile);
	if (registry[chatKey]) {
		delete registry[chatKey];
		writeChatRegistry(chatsFile, registry);
	}
}

export function chatKeyFromPrompt(prompt: LanguageModelV2Prompt): string {
	let firstUserText = "";
	for (const message of prompt) {
		if (message.role !== "user") continue;
		const content = Array.isArray(message.content)
			? message.content
					.map((block) => ("text" in block ? block.text : ""))
					.join("\n")
			: message.content;
		firstUserText = typeof content === "string" ? content : "";
		break;
	}
	const normalized = firstUserText.trim().toLowerCase() || "<empty>";
	return createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}

/** The text of the last user message in the prompt (for dedup + fallback filename hints). */
function lastUserText(prompt: LanguageModelV2Prompt): string {
	for (let i = prompt.length - 1; i >= 0; i--) {
		const message = prompt[i];
		if (message.role !== "user") continue;
		const content = Array.isArray(message.content)
			? message.content
					.map((block) => ("text" in block ? block.text : ""))
					.join("\n")
			: message.content;
		return typeof content === "string" ? content.trim() : "";
	}
	return "";
}

export function extractClaudeSessionId(url: string): string | undefined {
	const match = /\/chat\/([a-f0-9-]+)/.exec(url);
	return match?.[1] ?? undefined;
}

export function listClaudeWebChats(): ClaudeWebChatEntry[] {
	const config = resolveClaudeWebV2Config();
	const registry = readChatRegistry(config.chatsFile);
	return Object.entries(registry)
		.map(([chatKey, record]) => ({
			chatKey,
			sessionId: record.session_id,
			firstSeen: record.first_seen,
			lastActive: record.last_active,
		}))
		.sort((a, b) => (a.lastActive < b.lastActive ? 1 : -1));
}

/**
 * Opens an existing Claude Web chat in the browser driven by this provider.
 * This is what the CLI `/findchat` command calls after you pick a chat.
 */
export async function openClaudeWebChat(
	sessionId: string,
): Promise<{ sessionId: string; url: string }> {
	const config = resolveClaudeWebV2Config();
	const cdp = await connectBrowser(config);
	const targets = await cdp.send("Target.getTargets");
	let pageTarget = targets.targetInfos?.find(
		(t: any) => t.type === "page" && t.url?.startsWith("https://claude.ai"),
	);
	if (!pageTarget) {
		const result = await cdp.send("Target.createTarget", {
			url: CLAUDE_WEB_URL,
		});
		await sleep(2000);
		const newTargets = await cdp.send("Target.getTargets");
		pageTarget = newTargets.targetInfos?.find(
			(t: any) => t.targetId === result.targetId,
		);
		if (!pageTarget) {
			throw new Error("Failed to create Claude page");
		}
	}
	const attachResult = await cdp.send("Target.attachToTarget", {
		targetId: pageTarget.targetId,
		flatten: true,
	});
	const cdpSessionId = attachResult.sessionId;
	await navigateClaudeChat(cdp, cdpSessionId, { fresh: false, sessionId });
	return {
		sessionId,
		url: `https://claude.ai/chat/${sessionId}`,
	};
}

// â”€â”€ SSE parser for Claude â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Pull the raw JSON out of an `ask_user_input_v0` block, whether it arrived
 * as a pre-populated `tool_use.input`, a `tool_result.content` text part, or
 * a plain `text` field. Returns the tool_use id (for dedupe) and the JSON
 * string.
 */
function extractAskUserInputJson(
	block: any,
): { id?: string; json: string } | undefined {
	if (!block || typeof block !== "object") return undefined;

	const id =
		typeof block.tool_use_id === "string"
			? block.tool_use_id
			: typeof block.id === "string"
				? block.id
				: undefined;

	// Full input already populated on a tool_use block.
	if (block.input && typeof block.input === "object") {
		if (Object.keys(block.input).length > 0) {
			return { id, json: JSON.stringify(block.input) };
		}
	}

	// tool_result blocks carry the JSON in content[0].text.
	const content = block.content;
	if (Array.isArray(content)) {
		for (const part of content) {
			if (
				part &&
				typeof part === "object" &&
				typeof (part as any).text === "string"
			) {
				const trimmed = (part as any).text.trim();
				if (trimmed) return { id, json: trimmed };
			}
		}
	} else if (typeof content === "string" && content.trim()) {
		return { id, json: content.trim() };
	}

	// Final fallbacks.
	if (typeof block.text === "string" && block.text.trim()) {
		return { id, json: block.text.trim() };
	}

	return undefined;
}

/**
 * Convert the raw JSON from Claude's `ask_user_input_v0` widget into the
 * runtime's `ask_question` tool calls. The widget payload looks like:
 *
 *   {"questions":[{"question":"...","options":["T1","T2"]}]}
 *
 * Each question becomes one `ask_question` call with `{ question, options }`,
 * only when `ask_question` is one of the available function tools.
 */
function parseAskUserInputToolCalls(
	rawJson: string,
	availableToolNames: string[],
): { name: string; arguments: Record<string, unknown> }[] {
	if (!availableToolNames.includes("ask_question")) return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawJson);
	} catch {
		return [];
	}

	const questions = (parsed as any)?.questions;
	if (!Array.isArray(questions)) return [];

	const calls: { name: string; arguments: Record<string, unknown> }[] = [];
	for (const q of questions) {
		if (!q || typeof q !== "object") continue;
		const question = typeof q.question === "string" ? q.question.trim() : "";
		if (!question) continue;

		let options = q.options;
		if (!Array.isArray(options)) {
			options = typeof q.choices === "string" ? [q.choices] : [];
		}
		const cleanedOptions = options
			.filter(
				(o: unknown): o is string => typeof o === "string" && o.trim() !== "",
			)
			.slice(0, 5);

		calls.push({
			name: "ask_question",
			arguments: {
				question,
				options: cleanedOptions.length > 0 ? cleanedOptions : [],
			},
		});
	}
	return calls;
}

function consumeClaudeSse(
	body: string,
	onChunk: (text: string) => void,
	onDone: () => void,
	onError: (err: Error) => void,
	onUsage?: (usage: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
	}) => void,
	onAskUserInput?: (json: string) => void,
	onSessionPercent?: (percent: number) => void,
): void {
	try {
		// Claude SSE parsing: Anthropic content block format.
		let fullText = "";

		// Track native `ask_user_input_v0` tool_use blocks by index so the
		// streamed `input_json_delta` fragments can be reassembled and handed
		// back to the runtime's `ask_question` tool once the block closes.
		const askUserInputBlocks = new Map<number, string>();

		for (const rawLine of body.split("\n")) {
			const line = rawLine.trim();
			if (!line.startsWith("data:")) continue;
			const data = line.slice(5).trim();
			if (!data || data === "[DONE]") continue;

			let parsed: any;
			try {
				parsed = JSON.parse(data);
			} catch {
				continue;
			}
			if (!parsed || typeof parsed !== "object") continue;

			// Streaming delta: { v: "...", o: "append" }. Skip patch diffs.
			if (parsed.type === "content_block_delta") {
				const d = parsed.delta;
				if (d && d.type === "text_delta" && typeof d.text === "string")
					fullText += d.text;

				// Accumulate the streamed JSON for a native ask-user-input
				// widget (ask_user_input_v0) so it can be mapped to the
				// runtime's ask_question tool once the block closes.
				if (
					d &&
					d.type === "input_json_delta" &&
					typeof parsed.index === "number" &&
					askUserInputBlocks.has(parsed.index)
				) {
					const partial =
						typeof d.partial_json === "string" ? d.partial_json : "";
					askUserInputBlocks.set(
						parsed.index,
						askUserInputBlocks.get(parsed.index)! + partial,
					);
				}
			} else if (parsed.type === "content_block_start") {
				const b = parsed.content_block;
				if (b && b.type === "text" && typeof b.text === "string")
					fullText += b.text;

				if (
					b &&
					typeof b.type === "string" &&
					typeof parsed.index === "number"
				) {
					if (b.type === "tool_use" && b.name === "ask_user_input_v0") {
						// Pre-populated input arrives in some payloads; emit it
						// now. Empty input means the JSON is streamed via
						// `input_json_delta`, so open a buffer for it instead.
						const extracted = extractAskUserInputJson(b);
						if (extracted?.json) {
							onAskUserInput?.(extracted.json);
						} else {
							askUserInputBlocks.set(parsed.index, "");
						}
					} else if (
						b.type === "tool_result" &&
						b.name === "ask_user_input_v0"
					) {
						// Some payloads emit the full tool_result block instead
						// of streamed input_json_delta fragments; parse it
						// directly from the block.
						const extracted = extractAskUserInputJson(b);
						if (extracted?.json) onAskUserInput?.(extracted.json);
					}
				}
			} else if (parsed.type === "content_block_stop") {
				// The streamed input for an ask-user-input block is now
				// complete.
				if (
					typeof parsed.index === "number" &&
					askUserInputBlocks.has(parsed.index)
				) {
					const json = askUserInputBlocks.get(parsed.index)!.trim();
					if (json) onAskUserInput?.(json);
					askUserInputBlocks.delete(parsed.index);
				}
			}

			// message.content.parts[] is Claude's normal terminal payload.
			const message = parsed.message;
			if (message && typeof message === "object") {
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

			if (parsed.type === "message_limit" && onSessionPercent) {
				const resolvedPercent = (parsed as any)?.message_limit?.resolved?.limit
					?.percent;
				if (
					typeof resolvedPercent === "number" &&
					Number.isFinite(resolvedPercent) &&
					resolvedPercent >= 0
				) {
					onSessionPercent(resolvedPercent);
				}
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
		}

		const finalText = fullText.trim();
		if (finalText) onChunk(finalText);
		onDone();
	} catch (err) {
		onError(err instanceof Error ? err : new Error(String(err)));
	}
}

// â”€â”€ Composer ready â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function waitForComposerReady(
	cdp: CdpClient,
	sessionId: string,
	config: ClaudeWebV2RuntimeConfig,
	logger?: BasicLogger,
): Promise<void> {
	const pageFullyLoaded = `(() => {
        if (document.readyState !== 'complete') return false;
        var ta = document.querySelector('#prompt-textarea, textarea, div[contenteditable="true"], input[type="text"]');
        if (!ta || ta.disabled) return false;
        var s = window.getComputedStyle(ta);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        return true;
    })()`;

	const deadline = Date.now() + config.loginTimeoutMs;
	let hintLogged = false;
	for (;;) {
		let ready = false;
		try {
			const r = await cdp.send(
				"Runtime.evaluate",
				{
					expression: pageFullyLoaded,
					returnByValue: true,
					awaitPromise: true,
				},
				sessionId,
			);
			ready = r.result?.value === true;
		} catch {
			/* ignore */
		}

		if (ready) {
			if (config.debug) logger?.debug("[claude-web] page fully loaded");
			await sleep(1500);
			return;
		}

		if (!hintLogged) {
			hintLogged = true;
			logger?.log(
				"Claude Web: waiting for the claude.ai page to finish loading " +
					`(up to ${Math.round(config.loginTimeoutMs / 1000)}s). If the Chrome window shows a login page, log in now.`,
				{ severity: "info", providerId: "claude-web" },
			);
		}

		if (Date.now() >= deadline) {
			throw new Error(
				"Claude Web: claude.ai did not finish loading within " +
					`${Math.round(config.loginTimeoutMs / 1000)}s. Please log in to claude.ai in the Chrome window.`,
			);
		}
		await sleep(500);
	}
}

// â”€â”€ Chat navigation (mirrors deepseek-web-v2's navigateDeepSeekChat) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Read the current page URL via CDP. */
async function readPageUrl(
	cdp: CdpClient,
	cdpSessionId: string,
): Promise<string> {
	try {
		const res = await cdp.send(
			"Runtime.evaluate",
			{ expression: "window.location.href", returnByValue: true },
			cdpSessionId,
		);
		return typeof res.result?.value === "string" ? res.result.value : "";
	} catch {
		return "";
	}
}

/**
 * Point the Claude tab at a specific chat (load an old conversation) or at a
 * fresh composer (new chat). Skips navigating when the tab is already on the
 * destination â€” that is what avoids a needless full page reload on every
 * follow-up turn of the same conversation. `forceReload` skips that shortcut
 * to recover from a rate-limit block, where the page needs a real refresh to
 * accept messages again even though the URL is unchanged.
 */
async function navigateClaudeChat(
	cdp: CdpClient,
	cdpSessionId: string,
	target: { sessionId?: string; fresh: boolean },
	logger?: BasicLogger,
	forceReload = false,
): Promise<void> {
	const destination = target.fresh
		? CLAUDE_WEB_URL
		: target.sessionId
			? `https://claude.ai/chat/${target.sessionId}`
			: CLAUDE_WEB_URL;

	const currentUrl = (await readPageUrl(cdp, cdpSessionId)) || "";
	const alreadyThere = isSameChatLocation(currentUrl, destination);

	const clickNewChatScript = `(() => {
        const ta = document.querySelector('textarea, input[type="text"], .chat-input');
        if (ta && !ta.value) {
            const clickTargets = [
                'button[aria-label*="New chat" i]',
                'a[href="/"]',
                '[data-testid*="new-chat" i]',
                '.new-chat-button',
            ];
            for (const sel of clickTargets) {
                const el = document.querySelector(sel);
                if (el) { el.click(); return true; }
            }
        }
        return false;
    })()`;

	if (alreadyThere && !forceReload) {
		logger?.debug?.(
			`[claude-web] already on ${destination} â€” skipping navigation (no reload)`,
		);
		if (target.fresh) {
			await cdp.send(
				"Runtime.evaluate",
				{ expression: clickNewChatScript, returnByValue: true },
				cdpSessionId,
			);
		}
		await sleep(300);
		return;
	}

	logger?.debug?.(
		`[claude-web] ${target.fresh ? "opening a new Claude chat" : `loading Claude chat ${target.sessionId}`}`,
	);
	await cdp.send(
		"Runtime.evaluate",
		{
			expression: `(() => { window.location.href = ${JSON.stringify(destination)}; })()`,
			returnByValue: true,
		},
		cdpSessionId,
	);
	if (target.fresh) {
		await cdp.send(
			"Runtime.evaluate",
			{ expression: clickNewChatScript, returnByValue: true },
			cdpSessionId,
		);
	}
	// Give the SPA time to route to the target chat and hydrate before
	// `waitForComposerReady` confirms the composer is usable.
	await sleep(1500);
}

// â”€â”€ Send and capture (CDP Network domain â€” mirrors deepseek-web-v2) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Drives the SAME tab/session `doGenerate` already attached to over CDP,
// instead of launching a second, disconnected Playwright browser on the same
// profile dir (the previous approach â€” that second browser competed for the
// profile lock and its own "response" listener often never fired, which is
// what surfaced as "Model returned empty response").
//
// Network.responseReceived/loadingFinished listeners are scoped to this
// call's own cdpSessionId and unregistered in `finally`, so a listener left
// over from an earlier turn never intercepts a later turn's response.

async function sendAndCapture(
	cdp: CdpClient,
	cdpSessionId: string,
	prompt: string,
	config: ClaudeWebV2RuntimeConfig,
	logger?: BasicLogger,
	sendOptions?: { think?: boolean },
	isToolTurn = false,
	signal?: AbortSignal,
): Promise<{
	text: string;
	finishReason: LanguageModelV2FinishReason;
	usage: { inputTokens: number; outputTokens: number; totalTokens: number };
	rateLimited?: boolean;
	/** Raw JSON from a native `ask_user_input_v0` widget, when present. */
	askUserInput?: string;
}> {
	const debugLog = (msg: string) => {
		if (config.debug) logger?.debug(`[claude-web] ${msg}`);
	};

	let completionRequestId: string | undefined;
	let capturedBody = "";
	let bodyResolve: (() => void) | undefined;
	const bodyCaptured = new Promise<void>((resolve) => {
		bodyResolve = resolve;
	});

	const onResponseReceived = (event: any, eventSessionId?: string) => {
		if (eventSessionId !== cdpSessionId) return;
		const url: string = event.response?.url ?? "";
		if (!url.includes(CLAUDE_API_ENDPOINT)) return;
		if (event.response?.status !== 200) return;
		completionRequestId = event.requestId;
		debugLog(`completion response received (${url})`);
	};
	const onLoadingFinished = async (event: any, eventSessionId?: string) => {
		if (eventSessionId !== cdpSessionId) return;
		if (event.requestId !== completionRequestId) return;
		debugLog("completion body fully written â€” reading it");
		try {
			const { body, base64Encoded } = await cdp.send(
				"Network.getResponseBody",
				{ requestId: event.requestId },
				cdpSessionId,
			);
			capturedBody = base64Encoded
				? Buffer.from(body, "base64").toString("utf-8")
				: body;
			debugLog(`completion body captured (${capturedBody.length} chars)`);
		} catch (err) {
			logger?.error?.(
				`[claude-web] failed to read response body: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			bodyResolve?.();
		}
	};

	cdp.on("Network.responseReceived", onResponseReceived);
	cdp.on("Network.loadingFinished", onLoadingFinished);

	try {
		// Enable the Network domain ONCE per CDP session and leave it on for
		// the session's lifetime. Re-enabling here and disabling in `finally`
		// every turn is what made capture flaky on the first message.
		if (!claudeNetworkEnabledSessions.has(cdpSessionId)) {
			await cdp.send("Network.enable", {}, cdpSessionId);
			claudeNetworkEnabledSessions.add(cdpSessionId);
		}

		// Randomized human-like pacing before sending, plus an extra random
		// amount on tool-request turns (the fastest back-to-back pattern in an
		// agent run) â€” dodges claude.ai's own anti-abuse frequency throttle
		// the same way deepseek-web-v2 dodges DeepSeek's.
		const sendDelay = computeSendDelay(config, { isToolTurn });
		debugLog(
			`pacing: waiting ${sendDelay}ms before send (toolTurn=${String(isToolTurn)})`,
		);
		await abortableSleep(sendDelay, signal);

		await cdp.send(
			"Runtime.evaluate",
			{
				expression: buildSendScript(prompt, sendOptions),
				returnByValue: true,
				awaitPromise: true,
			},
			cdpSessionId,
		);

		// A cancelled turn has to stop waiting here. Until this returns the CLI
		// still counts the turn as running and refuses the next message, so
		// without the abort in this race Escape looked like it worked and then
		// the input stayed dead until the response timeout fired minutes later.
		const cancelled = abortRace(signal);
		const timeoutPromise = new Promise<void>((resolve) => {
			setTimeout(resolve, config.responseTimeoutMs);
		});
		try {
			await Promise.race([bodyCaptured, timeoutPromise, cancelled.promise]);
		} finally {
			cancelled.dispose();
		}

		if (!capturedBody) {
			// Distinguish a real timeout (body never arrived) from a listener
			// gap. An empty captured body is exactly what used to silently
			// surface as "Model returned empty response" on the first message.
			throw new Error(
				`[claude-web] no completion response captured for the last message. ` +
					`${completionRequestId ? "A response was seen but its body could not be read." : "No Claude completion response was observed."} ` +
					"Check that claude.ai is logged in and not rate-limited in the browser profile.",
			);
		}

		let fullText = "";
		let askUserInput: string | undefined;
		let sessionPercent: number | undefined;
		const finishReason: LanguageModelV2FinishReason = "stop";
		let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
		consumeClaudeSse(
			capturedBody,
			(chunk) => {
				fullText += chunk;
			},
			() => {},
			(err) => {
				logger?.error?.(`[claude-web] SSE parse error: ${err.message}`);
			},
			(nextUsage) => {
				usage = nextUsage;
			},
			(json) => {
				if (json) askUserInput = json;
			},
			(percent) => {
				sessionPercent = percent;
			},
		);

		if (sessionPercent !== undefined) {
			// Claude Web does not report per-turn input/output token counts; it
			// reports the session usage as a percentage of the context window.
			// Derive an absolute input-token estimate from that percent so the
			// runtime's status bar shows "used/total" against the real window.
			const contextWindow =
				config.contextWindow ?? CLAUDE_WEB_FALLBACK_CONTEXT_WINDOW;
			const inputTokens = Math.round(
				(contextWindow * Math.max(0, Math.min(sessionPercent, 100))) / 100,
			);
			usage = {
				inputTokens,
				outputTokens: usage.outputTokens,
				totalTokens: inputTokens + usage.outputTokens,
			};
		}

		// Flag a throttled reply so the caller can back off / report it, and
		// arm a one-shot recovery reload so the next turn forces a page
		// refresh to clear the temporarily-blocked composer.
		const rateLimited = isRateLimitText(fullText);
		if (rateLimited) {
			requestClaudeThrottleRecoveryReload();
			logger?.log?.(
				"[claude-web] Claude throttled the request (rate-limit reply detected). " +
					"Next message will reload the page to recover, and sending is paced. " +
					"Consider raising CLAUDE_WEB_MIN/MAX_SEND_DELAY_MS.",
			);
		}
		return { text: fullText, finishReason, usage, rateLimited, askUserInput };
	} finally {
		// Unregister only this turn's listeners. Leave the Network domain
		// enabled for the session — disabling it here was the other half of the
		// per-turn toggle that made capture flaky.
		cdp.off("Network.responseReceived", onResponseReceived);
		cdp.off("Network.loadingFinished", onLoadingFinished);
	}
}

// â”€â”€ Main provider â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface ClaudeCompletionResult {
	text: string;
	toolCalls: { name: string; arguments: Record<string, unknown> }[];
	usage: { inputTokens: number; outputTokens: number; totalTokens: number };
	/**
	 * Set when every tool call in the reply was rejected (e.g. invalid Python
	 * in an `editor` call). It is OUR commentary on what the model typed, so
	 * the model never sees it unless we send it back into the chat — the web
	 * client's server-side history has no idea we rejected anything.
	 */
	retryPrompt?: string;
}

/**
 * Build the flat prompt sent to claude.ai, mirroring deepseek-web-v2's
 * `buildPrompt`: the real web client keeps its own server-side conversation
 * state, so the system prompt is sent verbatim on the conversation's first
 * turn (via `buildLeanConversation`'s own first-turn passthrough) and dropped
 * on every follow-up turn in the SAME Claude chat â€” re-added only when
 * `reInjectSystem` is true (a brand-new Claude chat, e.g. right after a
 * compaction opens a fresh one).
 */

/**
 * Rephrase a tool result as natural first-person prose so Claude Web reads it
 * as context the user is pasting back, not a tool-call transcript. Claude Web
 * has its own built-in tools; when we echo "Tool result: (read_files) {...}",
 * Claude denies it because from its side no such tool call was ever made.
 */
/**
 * `run_commands` returns a JSON array of `ToolOperationResult` entries
 * (`[{query, result, success, error, ...}]`). Sending that raw JSON back to
 * Claude Web is unnatural; it only cares about the actual command output. Parse
 * the array and join each entry's `result` (or `error`) string, so the model
 * sees the PowerShell output like a human would. Falls back to the raw text
 * when the payload isn't that structured shape.
 */
function extractRunCommandsOutput(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("[")) return trimmed;

	const outputs: string[] = [];
	let cursor = 0;

	// The runtime can stack multiple `ToolOperationResult[]` arrays back to
	// back (one per command in a single run_commands call), e.g.
	// `[{...}]\n[{...}]`. JSON.parse can't handle the concatenation, so scan
	// each balanced `[...]` block individually.
	for (;;) {
		const start = trimmed.indexOf("[", cursor);
		if (start === -1) break;

		let depth = 0;
		let inString = false;
		let escaped = false;
		let end = -1;
		for (let i = start; i < trimmed.length; i++) {
			const ch = trimmed[i];
			if (inString) {
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') inString = true;
			else if (ch === "[") depth++;
			else if (ch === "]") {
				depth--;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
		if (end === -1) break;

		const raw = trimmed.slice(start, end + 1);
		cursor = end + 1;

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			continue;
		}
		if (!Array.isArray(parsed)) continue;

		for (const entry of parsed) {
			if (!entry || typeof entry !== "object") continue;
			const record = entry as Record<string, unknown>;
			const result =
				typeof record.result === "string" ? record.result.trim() : "";
			const error = typeof record.error === "string" ? record.error.trim() : "";
			if (error && result !== error) {
				// A failed entry (exit code, timeout, etc.) has a non-empty
				// `error` and often an empty `result`. Emit the error so the
				// model sees why the command failed instead of raw JSON.
				outputs.push(result ? `${result}\n${error}` : error);
			} else if (result) {
				outputs.push(result);
			}
		}
	}

	return outputs.length > 0 ? outputs.join("\n\n") : trimmed;
}
/**
 * Maximum number of lines of a Claude Web tool result sent back to the model.
 * Claude Web answers in plain text and the whole flattened prompt is sent in a
 * single browser request; a very long command output (e.g. `Get-Content -Raw`
 * of a large file) makes the page return an empty response. Cap every tool
 * result at this many lines so the request stays within the web client's
 * practical limits.
 */
const CLAUDE_WEB_TOOL_RESULT_MAX_LINES = 200;

function truncateToolResultLines(text: string): string {
	const lines = text.split("\n");
	if (lines.length <= CLAUDE_WEB_TOOL_RESULT_MAX_LINES) return text;
	const dropped = lines.length - CLAUDE_WEB_TOOL_RESULT_MAX_LINES;
	return [
		...lines.slice(0, CLAUDE_WEB_TOOL_RESULT_MAX_LINES),
		`... [output truncated: ${dropped} more lines]`,
	].join("\n");
}

function formatClaudeToolResult(toolName: string, text: string): string {
	const body = text.trim();
	const capped = truncateToolResultLines(body);
	switch (toolName) {
		case "read_files":
			return `Here is the file content I just read:\n${capped}`;
		case "search_codebase":
			return `Here are the files/functions I found when searching:\n${capped}`;
		case "run_commands":
			return `Here is the output of the command I just ran:\n${truncateToolResultLines(extractRunCommandsOutput(body))}`;
		case "editor":
			return `I just edited the file. Here is the result:\n${capped}`;
		case "fetch_web_content":
			return `Here is the content I fetched from the web:\n${capped}`;
		case "ask_question":
		case "ask_followup_question":
			// This is the user's answer to a question we asked them, not a
			// tool discovery. Send it back as plain natural language instead
			// of wrapping it in "Here is what I found:".
			return capped;
		default:
			return `Here is what I found:\n${capped}`;
	}
}

/** Code-fence language tags that mean "run this as a shell command". */
const CLAUDE_SHELL_FENCE_LANGS = new Set([
	"powershell",
	"pwsh",
	"ps1",
	"bash",
	"shell",
	"sh",
	"zsh",
	"cmd",
	"bat",
	"console",
	"terminal",
]);

/**
 * Claude Web-specific fallback. Claude answers in plain prose and often puts a
 * PowerShell command in a ```powershell fence to ask the user to "run it and
 * paste the output". The shared `parseFallbackToolUses` treats EVERY code fence
 * as an `editor` (create file) call, which would wrongly turn that command into
 * a file write. This parser first maps shell fences to `run_commands`, then
 * delegates the rest (pip installs, real code files) to the shared fallback.
 */
function parseClaudeFallbackToolUses(
	text: string,
	prompt: string,
	availableToolNames: string[],
): {
	cleanedText: string;
	toolUses: { name: string; arguments: Record<string, unknown> }[];
} {
	const toolUses: { name: string; arguments: Record<string, unknown> }[] = [];
	const hasRunCommands = availableToolNames.includes("run_commands");

	let remaining = text;
	if (hasRunCommands) {
		const fenceRe = /```([\w+-]*)\s*\n([\s\S]*?)```/g;
		remaining = text.replace(fenceRe, (full, lang: string, code: string) => {
			const normalizedLang = (lang || "").toLowerCase().trim();
			if (!CLAUDE_SHELL_FENCE_LANGS.has(normalizedLang)) return full;
			const command = code.replace(/\s+$/, "");
			if (!command.trim()) return full;
			toolUses.push({
				name: "run_commands",
				arguments: { commands: [command] },
			});
			return "";
		});
	}

	const fallback = parseFallbackToolUses(remaining, prompt, availableToolNames);
	return {
		cleanedText: fallback.cleanedText,
		toolUses: [...toolUses, ...fallback.toolUses],
	};
}

/**
 * Clean the flattened prompt for Claude Web:
 *   - rephrase `Tool result: (name) ...` turns into natural first-person prose,
 *   - drop the stale `Previous user message:` echo (Claude Web keeps its own
 *     server-side history, so re-sending the prior user text is redundant), and
 *   - drop the runtime's synthetic `Note:` continuation (it reads like a
 *     machine instruction, not a human pasting results back).
 * This runs AFTER the shared `messagesToPrompt` formatter (which we do not
 * modify). Segments are the formatter's own `\n\n`-joined turns.
 */
function rephraseClaudeToolResults(promptText: string): string {
	const segments = promptText.split("\n\n");
	return segments
		.filter((segment, index) => {
			const trimmed = segment.trim();
			// Keep the LAST "Previous user message:" segment: it is the current
			// queued directive when the user steers the turn right after a tool
			// round. Every earlier one is stale context (Claude Web already
			// holds it server-side) and is dropped.
			const isLastPreviousUser =
				trimmed.startsWith("Previous user message:") &&
				index === segments.length - 1;
			return (
				isLastPreviousUser ||
				(!trimmed.startsWith("Previous user message:") &&
					!trimmed.startsWith("Note:"))
			);
		})
		.map((segment) => {
			const match = /^Tool result: \(([^)]+)\)\s*([\s\S]*)$/.exec(segment);
			if (!match) return segment;
			return formatClaudeToolResult(match[1], match[2]);
		})
		.join("\n\n");
}

function buildClaudePrompt(
	prompt: LanguageModelV2Prompt,
	reInjectSystem: boolean,
	preserveCompactionContext: boolean,
): string {
	// Use a simpler system prompt for claude-web provider
	const simpleSystemPrompt =
		"Help me with this problem. Do not give me multiple code options, just 1 option. " +
		"Before helping me with my task, you must first help me understand the project folder structure and read the relevant files — send me PowerShell commands to do that, and I will paste you the results. " +
		"When a file needs to be edited, do not ask me to edit it manually: send me PowerShell code to make the change instead, while making sure I do not mess up the existing code. " +
		"I will then paste you the results of what has been done that I followed you.";

	// Replace the runtime's full system prompt with the simple one BEFORE
	// building the conversation. Otherwise the first turn (where
	// buildLeanConversation returns the whole prompt unchanged) would send the
	// full "# ROLE & OBJECTIVE ..." tool-contract prompt to Claude Web.
	const effectivePrompt = prompt.map((m) =>
		m.role === "system" ? { ...m, content: simpleSystemPrompt } : m,
	);

	const conversation = buildLeanConversation(
		effectivePrompt,
		preserveCompactionContext,
	);
	const systemMessage = effectivePrompt.find((m) => m.role === "system");
	const alreadyHasSystem = conversation.some((m) => m.role === "system");
	const promptOptions = {
		historyWindow: 10,
		userLabel: "Previous user message",
		lastUserLabel: continuationLabel(conversation),
		toolResultLabel: "Tool result",
	};

	if (
		reInjectSystem &&
		systemMessage &&
		!alreadyHasSystem &&
		conversation.length > 0
	) {
		return rephraseClaudeToolResults(
			messagesToPrompt([systemMessage, ...conversation], promptOptions),
		);
	}
	return rephraseClaudeToolResults(
		messagesToPrompt(conversation, promptOptions),
	);
}

/**
 * Turn a finished reply into visible text plus tool calls.
 *
 * Two callers hand us a reply string: the normal capture path, and `/paste`,
 * where the user copied the reply out of the browser because a network error
 * ate ours. Both need the same parse ladder, so they run the same code.
 */
function parseCapturedReply(
	text: string,
	options: LanguageModelV2CallOptions,
	usage: ClaudeCompletionResult["usage"],
	askUserInput?: string,
): ClaudeCompletionResult {
	const functionTools = (options.tools ?? []).filter(
		(tool): tool is LanguageModelV2FunctionTool => tool.type === "function",
	);

	// Claude's native `ask_user_input_v0` widget streams its payload as
	// raw JSON (`{"questions":[...]}`). Map it to the runtime's `ask_question`
	// tool so the agent gets a real question/options tool call instead of
	// the raw JSON ending up ignored as prose.
	if (askUserInput) {
		const askCalls = parseAskUserInputToolCalls(
			askUserInput,
			functionTools.map((t) => t.name),
		);
		if (askCalls.length > 0) {
			return { text, toolCalls: askCalls, usage };
		}
	}

	if (functionTools.length === 0) {
		return { text, toolCalls: [], usage };
	}

	const toolNames = functionTools.map((t) => t.name);
	const { cleanedContent, toolCalls } = parseDeepSeekToolCalls(text, toolNames);
	const looseCalls =
		toolCalls.length === 0
			? parseLooseDeepSeekToolCalls(text, toolNames)
			: toolCalls;
	if (looseCalls.length > 0) {
		const { tools: validatedCalls, retryPrompt } =
			validateToolCalls(looseCalls);
		return {
			text: retryPrompt
				? `${cleanedContent}

${retryPrompt}`.trim()
				: cleanedContent,
			toolCalls: validatedCalls,
			usage,
			retryPrompt,
		};
	}

	// Anthropic-style `<invoke>` bodies, which every big model reaches for
	// under load. See tool-pipeline/invoke-parser.ts.
	const invoked = parseInvokeStyleToolCalls(text, toolNames);
	if (invoked.toolCalls.length > 0) {
		const { tools: validatedInvoked, retryPrompt } = validateToolCalls(
			invoked.toolCalls,
		);
		return {
			text: retryPrompt
				? `${invoked.cleanedContent}

${retryPrompt}`.trim()
				: invoked.cleanedContent,
			toolCalls: validatedInvoked,
			usage,
			retryPrompt,
		};
	}

	// The web model often ignores the `<tool>` contract and answers with
	// plain text (a plan, code fences, install commands). Convert the visible
	// structure of the reply into real tool calls so the agent actually
	// executes them, same as deepseek-web-v2's fallback.
	// Claude answers in prose and puts shell commands in fences; map those to
	// `run_commands` before the shared fallback treats every fence as a file
	// write.
	const fallback = parseClaudeFallbackToolUses(
		cleanedContent,
		lastUserText(options.prompt),
		toolNames,
	);
	return {
		text: fallback.cleanedText,
		toolCalls: fallback.toolUses,
		usage,
	};
}

function createClaudeWebModel(
	modelId: string,
	logger?: BasicLogger,
	contextWindow?: number,
): LanguageModelV2 {
	// Re-resolved on every turn, not captured once: `/profile` can switch the
	// active browser profile between turns, which changes the user-data-dir,
	// the debug port and the chat registry. A model built before the switch
	// would otherwise keep driving the old profile's Chrome.
	let runtimeConfig = resolveClaudeWebV2Config();
	runtimeConfig.contextWindow = contextWindow;

	const debugLog = (msg: string) => {
		if (runtimeConfig.debug) logger?.debug(`[claude-web] ${msg}`);
	};

	// De-dup: if the last user-authored message is identical to the one
	// already sent (the agent is iterating after a tool call and the user
	// hasn't typed anything new), drop the stale "Previous user message:"
	// block so it isn't re-sent every turn. Mirrors deepseek-web-v2.
	let lastSentUserMessage = "";

	// Shared by doGenerate/doStream (mirrors deepseek-web-v2's doCompletion):
	// drives the CDP session, sends the prompt, captures + parses the SSE
	// body, and recovers `<tool>` calls the model emitted â€” one code path so
	// both entry points behave identically instead of doStream being a thin,
	// divergent wrapper around doGenerate.
	async function runCompletion(
		options: LanguageModelV2CallOptions,
	): Promise<ClaudeCompletionResult> {
		runtimeConfig = resolveClaudeWebV2Config();
		debugLog("runCompletion called");

		// A reply the user pasted back with `/paste` after a network error ate
		// the real one. Short-circuit before touching the browser: the text is
		// already the model's answer, it just needs the same tool parsing a
		// captured reply gets.
		const injected = consumePendingInjectedReply("claude-web");
		if (injected) {
			debugLog(`Using pasted reply (${injected.length} chars)`);
			return parseCapturedReply(injected, options, {
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
			});
		}

		// Cancelled while queued — do not open a browser for a dead turn.
		throwIfAborted(options.abortSignal);

		const cdp = await connectBrowser(runtimeConfig);

		const targets = await cdp.send("Target.getTargets");
		let pageTarget = targets.targetInfos?.find(
			(t: any) => t.type === "page" && t.url?.startsWith("https://claude.ai"),
		);

		if (!pageTarget) {
			const result = await cdp.send("Target.createTarget", {
				url: CLAUDE_WEB_URL,
			});
			await sleep(2000);
			const newTargets = await cdp.send("Target.getTargets");
			pageTarget = newTargets.targetInfos?.find(
				(t: any) => t.targetId === result.targetId,
			);
			if (!pageTarget) {
				throw new Error("Failed to create Claude page");
			}
		}

		// Reuse the already-attached session for this page target when we can.
		// The page target + its CDP session stay alive across turns, so
		// re-attaching every turn (and re-enabling the Network domain) was what
		// dropped the completion response on the very first message.
		let cdpSessionId: string | null = activeClaudeCdpSessionId;
		if (
			!cdpSessionId ||
			activeClaudeTargetId !== pageTarget.targetId ||
			!cdp.isOpen()
		) {
			const attachResult = await cdp.send("Target.attachToTarget", {
				targetId: pageTarget.targetId,
				flatten: true,
			});
			const newSessionId = attachResult.sessionId as string;
			cdpSessionId = newSessionId;
			activeClaudeTargetId = pageTarget.targetId;
			activeClaudeCdpSessionId = newSessionId;
			// A brand-new session needs the Network domain enabled fresh.
			claudeNetworkEnabledSessions.delete(newSessionId);
		}
		if (!cdpSessionId) {
			throw new Error(
				"[claude-web] failed to attach a CDP session to the Claude page",
			);
		}

		// Chat continuity: this CLI conversation is keyed by its first user
		// message. A fresh key (no mapped Claude chat yet) means this call opens
		// a brand-new web chat, e.g. right after a compaction where the
		// compaction summary becomes the first user message.
		// Which web chat does this call go to? Normally the hash of the
		// conversation's first user message; during compaction, the chat the
		// last ordinary turn used, because the standalone summarize request
		// would otherwise hash to an empty chat of its own. See
		// `tool-pipeline/chat-target.ts` for the full /compact hand-off.
		const chatKey = resolveChatKey("claude-web", () =>
			chatKeyFromPrompt(options.prompt),
		);
		let existingClaudeSession = lookupClaudeChatSession(
			runtimeConfig.chatsFile,
			chatKey,
		);
		if (!existingClaudeSession && chatKey.length !== 16) {
			existingClaudeSession = chatKey;
			recordClaudeChatSession(runtimeConfig.chatsFile, chatKey, chatKey);
		}
		const isNewChat = existingClaudeSession === undefined;

		const forceReload = consumeClaudeThrottleRecoveryReload();
		await navigateClaudeChat(
			cdp,
			cdpSessionId,
			existingClaudeSession
				? { sessionId: existingClaudeSession, fresh: false }
				: { fresh: true },
			logger,
			forceReload,
		);

		await waitForComposerReady(cdp, cdpSessionId, runtimeConfig, logger);

		// Re-inject the system prompt only when this turn opens a brand-new
		// Claude chat â€” every other turn in the SAME chat sends no system
		// prompt at all, since the web client already has it server-side.
		// (Unlike deepseek-web-v2 this has no token-threshold re-injection:
		// Claude's SSE responses don't expose an equivalent cumulative
		// accumulated-context figure to gate that on.)
		let promptText = buildClaudePrompt(options.prompt, isNewChat, isNewChat);

		// Key on the last message the USER actually typed, not the last user
		// message: on an iteration turn that is the runtime's synthetic
		// continuation note, which would flip the key and let the instruction
		// go out one extra time. See `tool-pipeline/previous-user-dedupe.ts`.
		const currentUserText = realUserMessageKey(options.prompt);
		if (currentUserText && currentUserText === lastSentUserMessage) {
			promptText = stripPreviousUserBlock(promptText);
		}
		lastSentUserMessage = currentUserText;

		const functionTools = (options.tools ?? []).filter(
			(tool): tool is LanguageModelV2FunctionTool => tool.type === "function",
		);

		debugLog(`Sending prompt (${promptText.length} chars)`);

		const MAX_TOOL_REJECTION_RETRIES = 2;

		// Bounded retry: when EVERY tool call in a reply is rejected, resend the
		// rejection as a real follow-up message in the SAME chat so the model
		// actually sees why we refused it and can correct itself. Capped so a
		// persistently broken reply can't loop forever.
		let sendPrompt = promptText;
		let result: Awaited<ReturnType<typeof sendAndCapture>>;
		let parsed: ClaudeCompletionResult;
		for (let attempt = 0; ; attempt++) {
			result = await sendAndCapture(
				cdp,
				cdpSessionId,
				sendPrompt,
				runtimeConfig,
				logger,
				{},
				functionTools.length > 0,
				options.abortSignal,
			);

			debugLog(`Received response (${result.text.length} chars)`);

			parsed = parseCapturedReply(
				result.text,
				options,
				result.usage,
				result.askUserInput,
			);
			if (
				parsed.toolCalls.length === 0 &&
				parsed.retryPrompt &&
				attempt < MAX_TOOL_REJECTION_RETRIES
			) {
				logger?.log(
					`[claude-web] all tool calls rejected, resending correction into chat (attempt ${attempt + 1}/${MAX_TOOL_REJECTION_RETRIES})`,
					{ severity: "warn" },
				);
				sendPrompt = parsed.retryPrompt;
				continue;
			}
			break;
		}

		// After sending, the SPA routes to `/c/<id>`; capture it so the next
		// turn (or a resume) can reopen this same Claude chat.
		const pageUrl = await readPageUrl(cdp, cdpSessionId);
		const claudeSession = extractClaudeSessionId(pageUrl);
		if (claudeSession) {
			recordClaudeChatSession(runtimeConfig.chatsFile, chatKey, claudeSession);
		}

		return parsed;
	}

	function finishReasonFor(
		text: string,
		toolCalls: ClaudeCompletionResult["toolCalls"],
	): LanguageModelV2FinishReason {
		return toolCalls.length > 0 ? "tool-calls" : text ? "stop" : "unknown";
	}

	const provider: LanguageModelV2 = {
		specificationVersion: "v2",
		provider: "claude-web",
		modelId,
		supportedUrls: {} as Record<string, RegExp[]>,

		async doGenerate(options: LanguageModelV2CallOptions) {
			try {
				const { text, toolCalls, usage } = await runCompletion(options);

				const content: LanguageModelV2Content[] = [];
				if (text) content.push({ type: "text", text });
				for (let i = 0; i < toolCalls.length; i++) {
					content.push({
						type: "tool-call",
						toolCallId: `call-${Date.now()}-${i}`,
						toolName: toolCalls[i].name,
						input: JSON.stringify(toolCalls[i].arguments),
					});
				}

				return {
					content,
					finishReason: finishReasonFor(text, toolCalls),
					usage,
					warnings: [],
				};
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));
				logger?.error?.(`[claude-web] doGenerate error: ${err.message}`);
				throw err;
			}
		},

		async doStream(options: LanguageModelV2CallOptions) {
			const { text, toolCalls, usage } = await runCompletion(options);
			const id = `claude-web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

			const parts: LanguageModelV2StreamPart[] = [
				{ type: "stream-start", warnings: [] },
				{ type: "response-metadata", id },
			];
			if (text) {
				parts.push({ type: "text-start", id });
				parts.push({ type: "text-delta", id, delta: text });
				parts.push({ type: "text-end", id });
			}
			for (let i = 0; i < toolCalls.length; i++) {
				const input = JSON.stringify(toolCalls[i].arguments);
				parts.push({
					type: "tool-input-start",
					id,
					toolName: toolCalls[i].name,
				});
				parts.push({ type: "tool-input-delta", id, delta: input });
				parts.push({ type: "tool-input-end", id });
				parts.push({
					type: "tool-call",
					toolCallId: `call-${Date.now()}-${i}`,
					toolName: toolCalls[i].name,
					input,
				});
			}
			parts.push({
				type: "finish",
				finishReason: finishReasonFor(text, toolCalls),
				usage,
			});

			const stream = new ReadableStream<LanguageModelV2StreamPart>({
				start(controller) {
					for (const part of parts) controller.enqueue(part);
					controller.close();
				},
			});
			return { stream, usage };
		},
	};

	return provider;
}

// â”€â”€ Provider factory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function createClaudeWebProvider(
	_config: GatewayResolvedProviderConfig,
	context?: GatewayProviderContext,
): ProviderFactoryResult {
	const logger = context?.logger;
	const contextWindow = context?.model?.contextWindow;
	return {
		model: (modelId: string) =>
			createClaudeWebModel(modelId, logger, contextWindow),
	};
}

export function createClaudeWebProviderFactory() {
	return { id: "claude-web", create: createClaudeWebProvider };
}

// â”€â”€ Module factory (used by ai-sdk.ts) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function createClaudeWebProviderModule(
	config: GatewayResolvedProviderConfig,
	context?: GatewayProviderContext,
): ProviderFactoryResult {
	return createClaudeWebProvider(config, context);
}
