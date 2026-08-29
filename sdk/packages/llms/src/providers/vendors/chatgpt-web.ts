/**
 * ChatGPT Web ("chatgpt-web") provider.
 *
 * Drives the real ChatGPT web client (chatgpt.com) through your installed Chrome
 * via the DevTools Protocol — no API key needed.
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
import { estimateTokens } from "@cline/shared";

import {
	messagesToPrompt,
	parseDeepSeekToolCalls,
	parseLooseDeepSeekToolCalls,
} from "./deepseek-web";
import {
	buildLeanConversation,
	computeSendDelay,
	currentUserLabel,
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
import { stripPreviousUserBlock } from "./tool-pipeline/previous-user-dedupe";
import { validateToolCalls } from "./tool-pipeline/tool-dispatcher";
import type { ProviderFactoryResult } from "./types";

const CONFIG_DIR = path.join(os.homedir(), ".cline", "chatgpt-web");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const CHATGPT_WEB_URL = "https://chatgpt.com/";
const CHATGPT_API_ENDPOINT = "/backend-api/f/conversation";

const DEFAULT_DEBUG_PORT = 9224;
const DEFAULT_LAUNCH_TIMEOUT_MS = 30000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 1200000; // Increased to 1200s (20 mins) to prevent premature timeout on long thinking/tool calls
const DEFAULT_LOGIN_TIMEOUT_MS = 120000;
const DEFAULT_MIN_SEND_DELAY_MS = 800;
const DEFAULT_MAX_SEND_DELAY_MS = 2_800;
const DEFAULT_TOOL_TURN_EXTRA_MIN_MS = 1_500;
const DEFAULT_TOOL_TURN_EXTRA_MAX_MS = 4_500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One-shot "recover from a throttle/block" signal, mirroring deepseek-web-v2's
 * own flag (kept separate — this provider drives an unrelated tab/profile, so
 * the two must never share recovery state). When ChatGPT rate-limits a turn, the
 * page can be left blocked; the next `runCompletion` forces a full reload even
 * if the URL already matches to clear it. Consumed (reset) after one reload.
 */
let chatgptRecoverFromThrottle = false;

function requestChatGPTThrottleRecoveryReload(): void {
	chatgptRecoverFromThrottle = true;
}

function consumeChatGPTThrottleRecoveryReload(): boolean {
	const shouldReload = chatgptRecoverFromThrottle;
	chatgptRecoverFromThrottle = false;
	return shouldReload;
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
	/** Lower/upper bound of the randomized sleep applied before each send. */
	minSendDelayMs: number;
	maxSendDelayMs: number;
	/** Extra randomized delay added on turns that themselves request tools. */
	toolTurnExtraMinMs: number;
	toolTurnExtraMaxMs: number;
}

interface ChatSessionRecord {
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
	// debug port and chat registry this provider uses, so one provider can be
	// driven with several logins. Env vars and config.json still win over it.
	const profile = resolveActiveProfilePaths(CONFIG_DIR, DEFAULT_DEBUG_PORT);
	const port =
		Number(process.env.CHATGPT_WEB_DEBUG_PORT ?? fileConfig.debugPort) ||
		profile.debugPort;
	return {
		chromePath: process.env.CHATGPT_WEB_CHROME_PATH || fileConfig.chromePath,
		profileDir:
			process.env.CHATGPT_WEB_PROFILE_DIR ||
			fileConfig.profileDir ||
			profile.profileDir,
		debugPort: port,
		headless:
			process.env.CHATGPT_WEB_HEADLESS !== undefined
				? process.env.CHATGPT_WEB_HEADLESS !== "false"
				: (fileConfig.headless ?? false),
		debug:
			process.env.CHATGPT_WEB_DEBUG !== undefined
				? process.env.CHATGPT_WEB_DEBUG !== "false"
				: (fileConfig.debug ?? false),
		launchTimeoutMs:
			Number(
				process.env.CHATGPT_WEB_LAUNCH_TIMEOUT_MS ?? fileConfig.launchTimeoutMs,
			) || DEFAULT_LAUNCH_TIMEOUT_MS,
		responseTimeoutMs:
			Number(
				process.env.CHATGPT_WEB_RESPONSE_TIMEOUT_MS ??
					fileConfig.responseTimeoutMs,
			) || DEFAULT_RESPONSE_TIMEOUT_MS,
		loginTimeoutMs:
			Number(
				process.env.CHATGPT_WEB_LOGIN_TIMEOUT_MS ?? fileConfig.loginTimeoutMs,
			) || DEFAULT_LOGIN_TIMEOUT_MS,
		chatsFile:
			process.env.CHATGPT_WEB_CHATS_FILE ||
			fileConfig.chatsFile ||
			profile.chatsFile,
		minSendDelayMs:
			Number(
				process.env.CHATGPT_WEB_MIN_SEND_DELAY_MS ?? fileConfig.minSendDelayMs,
			) || DEFAULT_MIN_SEND_DELAY_MS,
		maxSendDelayMs:
			Number(
				process.env.CHATGPT_WEB_MAX_SEND_DELAY_MS ?? fileConfig.maxSendDelayMs,
			) || DEFAULT_MAX_SEND_DELAY_MS,
		toolTurnExtraMinMs:
			Number(
				process.env.CHATGPT_WEB_TOOL_TURN_EXTRA_MIN_MS ??
					fileConfig.toolTurnExtraMinMs,
			) || DEFAULT_TOOL_TURN_EXTRA_MIN_MS,
		toolTurnExtraMaxMs:
			Number(
				process.env.CHATGPT_WEB_TOOL_TURN_EXTRA_MAX_MS ??
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

// ── CDP Client ────────────────────────────────────────────────────────────────

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
// domain) on every message. Re-attaching each turn was the "monitoring
// restarts every send" behavior: a fresh session plus Network.enable/disable
// churn left a window where the completion response could slip past the
// listener and surface as "Model returned empty response".
let activeChatGPTTargetId: string | null = null;
let activeChatGPTCdpSessionId: string | null = null;

// Sessions whose Network domain is already enabled. We enable once and leave
// it on for the session's lifetime; toggling it per turn is what made capture
// flaky.
const chatgptNetworkEnabledSessions = new Set<string>();

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
	config: ChatGPTWebV2RuntimeConfig,
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
				"~/.cline/chatgpt-web/config.json",
				"CHATGPT_WEB_CHROME_PATH",
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
		CHATGPT_WEB_URL,
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
			providerId: "chatgpt-web",
			pid: child.pid,
			debugPort: config.debugPort,
		});
	}

	try {
		await waitForEndpoint(config.debugPort, config.launchTimeoutMs);
	} catch (err) {
		throw new Error(
			`Failed to launch Chrome for ChatGPT Web: ${(err as Error).message}. ` +
				"If Chrome is already running with this profile, close it or set a different CHATGPT_WEB_PROFILE_DIR.",
		);
	}
	activeCdp = await connectCdp(config.debugPort, connectTimeoutMs);
	activeCdpKey = key;
	return activeCdp;
}

// ── Enhanced ChatGPT send script (from send_chatgpt.txt) ──────────────────────────
const SEND_MESSAGE_SOURCE = `
// ---------- 1. Toggle "Think" mode ----------
async function setChatGPTThink(enable) {
    const thinkBtn = Array.from(document.querySelectorAll('button')).find(btn => {
        const text = btn.textContent.trim();
        return text === 'Think' || text.includes('Think');
    });

    if (!thinkBtn) {
        console.warn('⚠️ Think button not found');
        return false;
    }

    const isPressed = thinkBtn.getAttribute('aria-pressed') === 'true';
    if (enable === isPressed) {
        console.log('🧠 Think already ' + (enable ? 'ON' : 'OFF'));
        return true;
    }

    thinkBtn.click();
    console.log('🧠 Think ' + (enable ? 'ENABLED' : 'DISABLED'));

    await new Promise(resolve => setTimeout(resolve, 300));
    return true;
}

// ---------- 2. Set text in ProseMirror contenteditable ----------
async function setChatGPTInput(message) {
    console.log('🔍 Step 1: Looking for input editor...');
    const editor = document.querySelector('#prompt-textarea');
    if (!editor) {
        console.error('❌ Input editor #prompt-textarea not found');
        return false;
    }
    console.log('✅ Found editor:', editor);

    // Focus the editor
    console.log('🔍 Step 2: Focusing editor...');
    editor.focus();

    // Clear existing content (select all)
    console.log('🔍 Step 3: Selecting existing content to clear...');
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);

    // Method 1: Use execCommand to insert text (works well with ProseMirror)
    console.log('🔍 Step 4: Inserting text via execCommand...');
    try {
        const success = document.execCommand('insertText', false, message);
        console.log('✍️ Text inserted via execCommand, success:', success);
    } catch (e) {
        console.warn('⚠️ execCommand failed, trying innerHTML fallback:', e);
        // Method 2: Fallback – set innerHTML and dispatch input event
        editor.innerHTML = '<p>' + message + '</p>';
        editor.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: message
        }));
        console.log('✍️ Text inserted via innerHTML fallback');
    }

    // Dispatch a secondary input event to ensure React state updates
    console.log('🔍 Step 5: Dispatching secondary input event for React...');
    editor.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: message
    }));

    // Wait for the send button to become enabled
    console.log('🔍 Step 6: Waiting 500ms for send button to enable...');
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log('✅ setChatGPTInput completed successfully');
    return true;
}

// ---------- 3. Click the send button ----------
async function clickChatGPTSend() {
    const selectors = [
        'button[data-testid="send-button"]',
        'button[aria-label="Send"]',
        'button[aria-label="Send message"]',
        'button[type="submit"]',
        'form button[type="submit"]',
        'button[class*="send"]'
    ];

    let sendBtn = null;
    // Try each selector with a small delay between attempts
    for (const sel of selectors) {
        sendBtn = document.querySelector(sel);
        if (sendBtn && !sendBtn.disabled) {
            break;
        }
        // Wait a bit before trying the next selector
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    // If not found, look for the icon arrow-up button
    if (!sendBtn || sendBtn.disabled) {
        sendBtn = Array.from(document.querySelectorAll('button')).find(btn => {
            const svg = btn.querySelector('svg');
            const label = (btn.getAttribute('aria-label') || '').toLowerCase();
            // Look for SVG with arrow-up or send icon
            if (svg) {
                const innerHTML = svg.innerHTML.toLowerCase();
                const hasArrow = innerHTML.includes('arrow') || innerHTML.includes('send') || innerHTML.includes('up');
                if (hasArrow || label.includes('send')) {
                    return !btn.disabled;
                }
            }
            return svg && label.includes('send') && !btn.disabled;
        });
    }

    if (!sendBtn || sendBtn.disabled) {
        console.warn('⚠️ Send button not found or disabled, trying Enter key');
        const editor = document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable="true"]');
        if (editor) {
            // Try both keydown and keypress events
            editor.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true
            }));
            editor.dispatchEvent(new KeyboardEvent('keypress', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true
            }));
            // Also try a simulated Enter on the textarea if it exists
            if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
                editor.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'Enter',
                    code: 'Enter',
                    keyCode: 13,
                    which: 13,
                    bubbles: true,
                    cancelable: true
                }));
            }
        }
        return true;
    }

    // Ensure the button is fully visible and clickable
    try {
        sendBtn.scrollIntoView({ block: 'center', behavior: 'instant' });
    } catch (e) {}

    // Simulate a full click
    sendBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    sendBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    sendBtn.click();
    console.log('🖱️ Send button clicked');
    return true;
}

// ---------- 4. Main function ----------
async function sendMessageToChatGPT(message, options) {
    options = options || {};
    const think = options.think !== undefined ? options.think : null; // true/false or null to skip

    // Toggle Think if requested
    if (think !== null) {
        await setChatGPTThink(think);
    }

    // Set the message text
    const inputSuccess = await setChatGPTInput(message);
    if (!inputSuccess) {
        console.error('❌ Failed to set input text');
        return false;
    }

    // Wait for send button to become enabled
    await new Promise(resolve => setTimeout(resolve, 500));

    // Send the message
    await clickChatGPTSend();
    console.log('✅ Message sent: ' + message);
    return true;
}
`;

function buildSendScript(
	prompt: string,
	options?: { think?: boolean },
): string {
	const opts = options || {};
	return `(async () => {
        ${SEND_MESSAGE_SOURCE}
        await sendMessageToChatGPT(${JSON.stringify(prompt)}, ${JSON.stringify(opts)});
    })(); true;`;
}

// ── Chat session persistence ──────────────────────────────────────────────────

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
		console.warn(`[chatgpt-web] failed to persist chat registry: ${error}`);
	}
}

export function lookupChatGPTChatSession(
	chatsFile: string,
	chatKey: string,
): string | undefined {
	return readChatRegistry(chatsFile)[chatKey]?.session_id;
}

export function recordChatGPTChatSession(
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

export function deleteChatGPTChatSession(
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

export function extractChatGPTSessionId(url: string): string | undefined {
	const match = /\/c\/([a-f0-9-]+)/.exec(url);
	return match?.[1] ?? undefined;
}

export function listChatGPTWebChats(): ChatGPTWebChatEntry[] {
	const config = resolveChatGPTWebV2Config();
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
 * Opens an existing ChatGPT Web chat in the browser driven by this provider.
 * This is what the CLI `/findchat` command calls after you pick a chat.
 */
export async function openChatGPTWebChat(
	sessionId: string,
): Promise<{ sessionId: string; url: string }> {
	const config = resolveChatGPTWebV2Config();
	const cdp = await connectBrowser(config);
	const targets = await cdp.send("Target.getTargets");
	let pageTarget = targets.targetInfos?.find(
		(t: any) => t.type === "page" && t.url?.startsWith("https://chatgpt.com"),
	);
	if (!pageTarget) {
		const result = await cdp.send("Target.createTarget", {
			url: CHATGPT_WEB_URL,
		});
		await sleep(2000);
		const newTargets = await cdp.send("Target.getTargets");
		pageTarget = newTargets.targetInfos?.find(
			(t: any) => t.targetId === result.targetId,
		);
		if (!pageTarget) {
			throw new Error("Failed to create ChatGPT page");
		}
	}
	const attachResult = await cdp.send("Target.attachToTarget", {
		targetId: pageTarget.targetId,
		flatten: true,
	});
	const cdpSessionId = attachResult.sessionId;
	await navigateChatGPTChat(cdp, cdpSessionId, { fresh: false, sessionId });
	return {
		sessionId,
		url: `https://chatgpt.com/c/${sessionId}`,
	};
}

// ── SSE parser for ChatGPT ──────────────────────────────────────────────────────

function consumeChatGPTSse(
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
		// ChatGPT SSE parsing: see consumeChatGPTSse doc below.
		let fullText = "";

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
			if (typeof parsed.v === "string") {
				if (parsed.o === "patch") continue;
				fullText += parsed.v;
				continue;
			}

			// message.content.parts[] is ChatGPT's normal terminal payload.
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

// ── Composer ready ─────────────────────────────────────────────────────────────

async function waitForComposerReady(
	cdp: CdpClient,
	sessionId: string,
	config: ChatGPTWebV2RuntimeConfig,
	logger?: BasicLogger,
): Promise<void> {
	const pageFullyLoaded = `(() => {
        if (document.readyState !== 'complete') return false;
        // Prioritize the visible ProseMirror div over the hidden fallback textarea
        var ta = document.querySelector('div#prompt-textarea') || 
                 document.querySelector('div[contenteditable="true"][role="textbox"]') || 
                 document.querySelector('textarea:not([style*="display: none"])');
        if (!ta) return false;
        // For divs, ensure they are actually contenteditable
        if (ta.tagName === 'DIV' && !ta.isContentEditable) return false;
        var s = window.getComputedStyle(ta);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
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
			if (config.debug) logger?.debug("[chatgpt-web] page fully loaded");
			await sleep(1500);
			return;
		}

		if (!hintLogged) {
			hintLogged = true;
			logger?.log(
				"ChatGPT Web: waiting for the chatgpt.com page to finish loading " +
					`(up to ${Math.round(config.loginTimeoutMs / 1000)}s). If the Chrome window shows a login page, log in now.`,
				{ severity: "info", providerId: "chatgpt-web" },
			);
		}

		if (Date.now() >= deadline) {
			throw new Error(
				"ChatGPT Web: chatgpt.com did not finish loading within " +
					`${Math.round(config.loginTimeoutMs / 1000)}s. Please log in to chatgpt.com in the Chrome window.`,
			);
		}
		await sleep(500);
	}
}

// ── Chat navigation (mirrors deepseek-web-v2's navigateDeepSeekChat) ───────────

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
 * Point the ChatGPT tab at a specific chat (load an old conversation) or at a
 * fresh composer (new chat). Skips navigating when the tab is already on the
 * destination — that is what avoids a needless full page reload on every
 * follow-up turn of the same conversation. `forceReload` skips that shortcut
 * to recover from a rate-limit block, where the page needs a real refresh to
 * accept messages again even though the URL is unchanged.
 */
async function navigateChatGPTChat(
	cdp: CdpClient,
	cdpSessionId: string,
	target: { sessionId?: string; fresh: boolean },
	logger?: BasicLogger,
	forceReload = false,
): Promise<void> {
	const destination = target.fresh
		? CHATGPT_WEB_URL
		: target.sessionId
			? `https://chatgpt.com/c/${target.sessionId}`
			: CHATGPT_WEB_URL;

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
			`[chatgpt-web] already on ${destination} — skipping navigation (no reload)`,
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
		`[chatgpt-web] ${target.fresh ? "opening a new ChatGPT chat" : `loading ChatGPT chat ${target.sessionId}`}`,
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

// ── Send and capture (CDP Network domain — mirrors deepseek-web-v2) ────────────
//
// Drives the SAME tab/session `doGenerate` already attached to over CDP,
// instead of launching a second, disconnected Playwright browser on the same
// profile dir (the previous approach — that second browser competed for the
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
	config: ChatGPTWebV2RuntimeConfig,
	logger?: BasicLogger,
	sendOptions?: { think?: boolean },
	isToolTurn = false,
	signal?: AbortSignal,
): Promise<{
	text: string;
	finishReason: LanguageModelV2FinishReason;
	usage: { inputTokens: number; outputTokens: number; totalTokens: number };
	rateLimited?: boolean;
}> {
	const debugLog = (msg: string) => {
		if (config.debug) logger?.debug(`[chatgpt-web] ${msg}`);
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
		if (!url.includes(CHATGPT_API_ENDPOINT)) return;
		if (event.response?.status !== 200) return;
		completionRequestId = event.requestId;
		debugLog(`completion response received (${url})`);
	};
	const onLoadingFinished = async (event: any, eventSessionId?: string) => {
		if (eventSessionId !== cdpSessionId) return;
		if (event.requestId !== completionRequestId) return;
		debugLog("completion body fully written — reading it");
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
				`[chatgpt-web] failed to read response body: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			bodyResolve?.();
		}
	};

	cdp.on("Network.responseReceived", onResponseReceived);
	cdp.on("Network.loadingFinished", onLoadingFinished);

	try {
		// Enable the Network domain ONCE per CDP session and leave it on for
		// the session's lifetime. The old code re-enabled here and re-disabled
		// in `finally` every turn — that toggle churn (plus re-attaching) could
		// drop a completion response and surface as "Model returned empty
		// response". Keeping the domain enabled is stable and harmless: the
		// listeners are still scoped/unregistered per turn.
		if (!chatgptNetworkEnabledSessions.has(cdpSessionId)) {
			await cdp.send("Network.enable", {}, cdpSessionId);
			chatgptNetworkEnabledSessions.add(cdpSessionId);
		}

		// Randomized human-like pacing before sending, plus an extra random
		// amount on tool-request turns (the fastest back-to-back pattern in an
		// agent run) — dodges chatgpt.com's own anti-abuse frequency throttle
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
			// Distinguish a real timeout (the body never arrived) from a
			// listener gap. An empty captured body after the wait is exactly the
			// condition that used to be returned as empty text and then bubbled
			// up as the opaque "Model returned empty response".
			throw new Error(
				`[chatgpt-web] no completion response captured for the last message. ` +
					`${completionRequestId ? "A response was seen but its body could not be read." : "No ChatGPT completion response was observed."} ` +
					"Check that chatgpt.com is logged in and not rate-limited in the browser profile.",
			);
		}

		let fullText = "";
		const finishReason: LanguageModelV2FinishReason = "stop";
		let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
		consumeChatGPTSse(
			capturedBody,
			(chunk) => {
				fullText += chunk;
			},
			() => {},
			(err) => {
				logger?.error?.(`[chatgpt-web] SSE parse error: ${err.message}`);
			},
			(nextUsage) => {
				usage = nextUsage;
			},
		);

		// ChatGPT's web SSE stream often omits a `usage` payload, leaving the
		// numbers at zero. The Python reference automation estimates tokens from
		// the captured text instead (tiktoken cl100k_base, falling back to
		// max(words, chars/4)), and deepseek-web-v2 uses the repo-wide
		// `estimateTokens` (chars / 3). Do the same here so the context bar,
		// per-turn metrics, and session totals show real numbers.
		if (usage.totalTokens === 0) {
			const inputTokens = estimateTokens(prompt.length);
			const outputTokens = estimateTokens(fullText.length);
			usage = {
				inputTokens,
				outputTokens,
				totalTokens: inputTokens + outputTokens,
			};
		}

		// Flag a throttled reply so the caller can back off / report it, and
		// arm a one-shot recovery reload so the next turn forces a page
		// refresh to clear the temporarily-blocked composer.
		const rateLimited = isRateLimitText(fullText);
		if (rateLimited) {
			requestChatGPTThrottleRecoveryReload();
			logger?.log?.(
				"[chatgpt-web] ChatGPT throttled the request (rate-limit reply detected). " +
					"Next message will reload the page to recover, and sending is paced. " +
					"Consider raising CHATGPT_WEB_MIN/MAX_SEND_DELAY_MS.",
			);
		}
		return { text: fullText, finishReason, usage, rateLimited };
	} finally {
		// Unregister only this turn's listeners. Leave the Network domain
		// enabled for the session — disabling it here was the other half of the
		// per-turn toggle that made capture flaky.
		cdp.off("Network.responseReceived", onResponseReceived);
		cdp.off("Network.loadingFinished", onLoadingFinished);
	}
}

// ── Main provider ─────────────────────────────────────────────────────────────

interface ChatGPTCompletionResult {
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
 * Build the flat prompt sent to chatgpt.com, mirroring deepseek-web-v2's
 * `buildPrompt`: the real web client keeps its own server-side conversation
 * state, so the system prompt is sent verbatim on the conversation's first
 * turn (via `buildLeanConversation`'s own first-turn passthrough) and dropped
 * on every follow-up turn in the SAME ChatGPT chat — re-added only when
 * `reInjectSystem` is true (a brand-new ChatGPT chat, e.g. right after a
 * compaction opens a fresh one).
 */
function buildChatGPTPrompt(
	prompt: LanguageModelV2Prompt,
	reInjectSystem: boolean,
	preserveCompactionContext: boolean,
): string {
	const conversation = buildLeanConversation(prompt, preserveCompactionContext);
	const systemMessage = prompt.find((m) => m.role === "system");
	const alreadyHasSystem = conversation.some((m) => m.role === "system");
	const promptOptions = {
		historyWindow: 10,
		userLabel: "Previous user message",
		lastUserLabel: currentUserLabel(conversation),
		toolResultLabel: "Tool result",
	};
	if (
		reInjectSystem &&
		systemMessage &&
		!alreadyHasSystem &&
		conversation.length > 0
	) {
		return messagesToPrompt([systemMessage, ...conversation], promptOptions);
	}
	return messagesToPrompt(conversation, promptOptions);
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
	usage: ChatGPTCompletionResult["usage"],
): ChatGPTCompletionResult {
	const functionTools = (options.tools ?? []).filter(
		(tool): tool is LanguageModelV2FunctionTool => tool.type === "function",
	);
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
	const fallback = parseFallbackToolUses(
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

function createChatGPTWebModel(
	modelId: string,
	logger?: BasicLogger,
): LanguageModelV2 {
	// Re-resolved on every turn, not captured once: `/profile` can switch the
	// active browser profile between turns, which changes the user-data-dir,
	// the debug port and the chat registry. A model built before the switch
	// would otherwise keep driving the old profile's Chrome.
	let runtimeConfig = resolveChatGPTWebV2Config();

	const debugLog = (msg: string) => {
		if (runtimeConfig.debug) logger?.debug(`[chatgpt-web] ${msg}`);
	};

	// Shared by doGenerate/doStream (mirrors deepseek-web-v2's doCompletion):
	// drives the CDP session, sends the prompt, captures + parses the SSE
	// body, and recovers `<tool>` calls the model emitted — one code path so
	// both entry points behave identically instead of doStream being a thin,
	// divergent wrapper around doGenerate.
	async function runCompletion(
		options: LanguageModelV2CallOptions,
	): Promise<ChatGPTCompletionResult> {
		runtimeConfig = resolveChatGPTWebV2Config();
		debugLog("runCompletion called");

		// A reply the user pasted back with `/paste` after a network error ate
		// the real one. Short-circuit before touching the browser: the text is
		// already the model's answer, it just needs the same tool parsing a
		// captured reply gets.
		const injected = consumePendingInjectedReply("chatgpt-web");
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
			(t: any) => t.type === "page" && t.url?.startsWith("https://chatgpt.com"),
		);

		if (!pageTarget) {
			const result = await cdp.send("Target.createTarget", {
				url: CHATGPT_WEB_URL,
			});
			await sleep(2000);
			const newTargets = await cdp.send("Target.getTargets");
			pageTarget = newTargets.targetInfos?.find(
				(t: any) => t.targetId === result.targetId,
			);
			if (!pageTarget) {
				throw new Error("Failed to create ChatGPT page");
			}
		}

		// Reuse the already-attached session for this page target when we can:
		// the page target + its CDP session stay alive across turns, so
		// re-attaching every turn (and re-enabling the Network domain) was a
		// source of capture flakiness. Only (re-)attach when the target changed
		// or we don't have a cached session for it yet.
		let cdpSessionId: string | null = activeChatGPTCdpSessionId;
		if (
			!cdpSessionId ||
			activeChatGPTTargetId !== pageTarget.targetId ||
			!cdp.isOpen()
		) {
			const attachResult = await cdp.send("Target.attachToTarget", {
				targetId: pageTarget.targetId,
				flatten: true,
			});
			const newSessionId = attachResult.sessionId as string;
			cdpSessionId = newSessionId;
			activeChatGPTTargetId = pageTarget.targetId;
			activeChatGPTCdpSessionId = newSessionId;
			// A brand-new session needs the Network domain enabled fresh.
			chatgptNetworkEnabledSessions.delete(newSessionId);
		}
		if (!cdpSessionId) {
			throw new Error(
				"[chatgpt-web] failed to attach a CDP session to the ChatGPT page",
			);
		}

		// Chat continuity: this CLI conversation is keyed by its first user
		// message. A fresh key (no mapped ChatGPT chat yet) means this call opens
		// a brand-new web chat, e.g. right after a compaction where the
		// compaction summary becomes the first user message.
		// Which web chat does this call go to? Normally the hash of the
		// conversation's first user message; during compaction, the chat the
		// last ordinary turn used, because the standalone summarize request
		// would otherwise hash to an empty chat of its own. See
		// `tool-pipeline/chat-target.ts` for the full /compact hand-off.
		const chatKey = resolveChatKey("chatgpt-web", () =>
			chatKeyFromPrompt(options.prompt),
		);
		let existingChatGPTSession = lookupChatGPTChatSession(
			runtimeConfig.chatsFile,
			chatKey,
		);
		if (!existingChatGPTSession && chatKey.length !== 16) {
			existingChatGPTSession = chatKey;
			recordChatGPTChatSession(runtimeConfig.chatsFile, chatKey, chatKey);
		}
		const isNewChat = existingChatGPTSession === undefined;

		const forceReload = consumeChatGPTThrottleRecoveryReload();
		await navigateChatGPTChat(
			cdp,
			cdpSessionId,
			existingChatGPTSession
				? { sessionId: existingChatGPTSession, fresh: false }
				: { fresh: true },
			logger,
			forceReload,
		);

		await waitForComposerReady(cdp, cdpSessionId, runtimeConfig, logger);

		// Re-inject the system prompt only when this turn opens a brand-new
		// ChatGPT chat — every other turn in the SAME chat sends no system
		// prompt at all, since the web client already has it server-side.
		// (Unlike deepseek-web-v2 this has no token-threshold re-injection:
		// ChatGPT's SSE responses don't expose an equivalent cumulative
		// accumulated-context figure to gate that on.)
		let promptText = buildChatGPTPrompt(options.prompt, isNewChat, isNewChat);

		// The web chat is stateful: everything the user typed is already in it.
		// The current instruction still goes out — `messagesToPrompt` labels it
		// `User:` (or `Note:` on an iteration turn) — but every OLDER
		// `Previous user message:` block is dropped, so an instruction is sent
		// once and never re-sent on each round of a tool loop. Anything the user
		// wants restated goes through `/note`.
		promptText = stripPreviousUserBlock(promptText);

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
		let parsed: ChatGPTCompletionResult;
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

			parsed = parseCapturedReply(result.text, options, result.usage);
			if (
				parsed.toolCalls.length === 0 &&
				parsed.retryPrompt &&
				attempt < MAX_TOOL_REJECTION_RETRIES
			) {
				logger?.log(
					`[chatgpt-web] all tool calls rejected, resending correction into chat (attempt ${attempt + 1}/${MAX_TOOL_REJECTION_RETRIES})`,
					{ severity: "warn" },
				);
				sendPrompt = parsed.retryPrompt;
				continue;
			}
			break;
		}

		// After sending, the SPA routes to `/c/<id>`; capture it so the next
		// turn (or a resume) can reopen this same ChatGPT chat.
		const pageUrl = await readPageUrl(cdp, cdpSessionId);
		const chatgptSession = extractChatGPTSessionId(pageUrl);
		if (chatgptSession) {
			recordChatGPTChatSession(
				runtimeConfig.chatsFile,
				chatKey,
				chatgptSession,
			);
		}

		return parsed;
	}

	function finishReasonFor(
		text: string,
		toolCalls: ChatGPTCompletionResult["toolCalls"],
	): LanguageModelV2FinishReason {
		return toolCalls.length > 0 ? "tool-calls" : text ? "stop" : "unknown";
	}

	const provider: LanguageModelV2 = {
		specificationVersion: "v2",
		provider: "chatgpt-web",
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
				logger?.error?.(`[chatgpt-web] doGenerate error: ${err.message}`);
				throw err;
			}
		},

		async doStream(options: LanguageModelV2CallOptions) {
			const { text, toolCalls, usage } = await runCompletion(options);
			const id = `chatgpt-web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

// ── Provider factory ──────────────────────────────────────────────────────────

export function createChatGPTWebProvider(
	_config: GatewayResolvedProviderConfig,
	context?: GatewayProviderContext,
): ProviderFactoryResult {
	const logger = context?.logger;
	return {
		model: (modelId: string) => createChatGPTWebModel(modelId, logger),
	};
}

export function createChatGPTWebProviderFactory() {
	return { id: "chatgpt-web", create: createChatGPTWebProvider };
}

// ── Module factory (used by ai-sdk.ts) ────────────────────────────────────────

export function createChatGPTWebProviderModule(
	config: GatewayResolvedProviderConfig,
	context?: GatewayProviderContext,
): ProviderFactoryResult {
	return createChatGPTWebProvider(config, context);
}
