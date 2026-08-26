/**
 * Claude Web ("claude-web") provider.
 *
 * Drives the real Claude web client (claude.ai) through your installed Chrome
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
	consumeChatKeyOverride,
	recordActiveChatKey,
} from "./tool-pipeline/chat-target";
import {
	realUserMessageKey,
	stripPreviousUserBlock,
} from "./tool-pipeline/previous-user-dedupe";
import { validateToolCalls } from "./tool-pipeline/tool-dispatcher";
import type { ProviderFactoryResult } from "./types";

const CONFIG_DIR = path.join(os.homedir(), ".cline", "claude-web");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const DEFAULT_CHATS_FILE = path.join(CONFIG_DIR, "chats.json");
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One-shot "recover from a throttle/block" signal, mirroring deepseek-web-v2's
 * own flag (kept separate — this provider drives an unrelated tab/profile, so
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
	const port =
		Number(process.env.CLAUDE_WEB_DEBUG_PORT ?? fileConfig.debugPort) ||
		DEFAULT_DEBUG_PORT;
	return {
		chromePath: process.env.CLAUDE_WEB_CHROME_PATH || fileConfig.chromePath,
		profileDir: process.env.CLAUDE_WEB_PROFILE_DIR || fileConfig.profileDir,
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
			DEFAULT_CHATS_FILE,
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

function findChromePath(): string | undefined {
	const programFiles = process.env.PROGRAMFILES;
	const programFilesX86 = process.env["PROGRAMFILES(X86)"];
	const localAppData = process.env.LOCALAPPDATA;
	const candidates = [
		programFiles
			? path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe")
			: undefined,
		programFilesX86
			? path.join(
					programFilesX86,
					"Google",
					"Chrome",
					"Application",
					"chrome.exe",
				)
			: undefined,
		localAppData
			? path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe")
			: undefined,
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
	];
	return candidates.find((p) => p !== undefined && fs.existsSync(p));
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

	const connectTimeoutMs = Math.max(config.launchTimeoutMs, 30000);

	if (await isEndpointUp(config.debugPort)) {
		activeCdp = await connectCdp(config.debugPort, connectTimeoutMs);
		activeCdpKey = key;
		return activeCdp;
	}

	const executablePath = config.chromePath ?? findChromePath();
	if (!executablePath) {
		throw new Error(
			"Could not find Chrome. Set chromePath in ~/.cline/claude-web/config.json or CLAUDE_WEB_CHROME_PATH.",
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

// ── Enhanced Claude send script (from send_claude.txt) ──────────────────────────
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
        console.error('❌ Input editor not found. Available inputs:', Array.from(document.querySelectorAll('textarea, div[contenteditable="true"]')).map(e => e.tagName + (e.className ? '.'+e.className : '')));
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
            'button[aria-label*="发送" i]',
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
        console.log('✅ Send button clicked');
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
        console.log('✅ Enter key dispatched as fallback');
        return true;
    }
    
    console.warn('❌ Send button not found and Enter key failed');
    return false;
}

// ---------- 3. Main function ----------
async function sendMessageToClaude(message, options) {
    options = options || {};
    const inputSuccess = await setClaudeInput(message);
    if (!inputSuccess) {
        console.error('❌ Failed to set input');
        return false;
    }

    await new Promise(resolve => setTimeout(resolve, 500));

    const sendSuccess = await clickClaudeSend();
    if (sendSuccess) {
        console.log('✅ Message sent successfully: ' + message.substring(0, 50) + '...');
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

// ── SSE parser for Claude ──────────────────────────────────────────────────────

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
): void {
	try {
		// Claude SSE parsing: Anthropic content block format.
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
			if (parsed.type === "content_block_delta") {
				const d = parsed.delta;
				if (d && d.type === "text_delta" && typeof d.text === "string")
					fullText += d.text;
			} else if (parsed.type === "content_block_start") {
				const b = parsed.content_block;
				if (b && b.type === "text" && typeof b.text === "string")
					fullText += b.text;
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
 * Point the Claude tab at a specific chat (load an old conversation) or at a
 * fresh composer (new chat). Skips navigating when the tab is already on the
 * destination — that is what avoids a needless full page reload on every
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
			`[claude-web] already on ${destination} — skipping navigation (no reload)`,
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
	config: ClaudeWebV2RuntimeConfig,
	logger?: BasicLogger,
	sendOptions?: { think?: boolean },
	isToolTurn = false,
): Promise<{
	text: string;
	finishReason: LanguageModelV2FinishReason;
	usage: { inputTokens: number; outputTokens: number; totalTokens: number };
	rateLimited?: boolean;
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
				`[claude-web] failed to read response body: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			bodyResolve?.();
		}
	};

	cdp.on("Network.responseReceived", onResponseReceived);
	cdp.on("Network.loadingFinished", onLoadingFinished);

	try {
		await cdp.send("Network.enable", {}, cdpSessionId);

		// Randomized human-like pacing before sending, plus an extra random
		// amount on tool-request turns (the fastest back-to-back pattern in an
		// agent run) — dodges claude.ai's own anti-abuse frequency throttle
		// the same way deepseek-web-v2 dodges DeepSeek's.
		const sendDelay = computeSendDelay(config, { isToolTurn });
		debugLog(
			`pacing: waiting ${sendDelay}ms before send (toolTurn=${String(isToolTurn)})`,
		);
		await sleep(sendDelay);

		await cdp.send(
			"Runtime.evaluate",
			{
				expression: buildSendScript(prompt, sendOptions),
				returnByValue: true,
				awaitPromise: true,
			},
			cdpSessionId,
		);

		const timeoutPromise = new Promise<void>((resolve) => {
			setTimeout(resolve, config.responseTimeoutMs);
		});
		await Promise.race([bodyCaptured, timeoutPromise]);

		if (!capturedBody) {
			return {
				text: "",
				finishReason: "stop",
				usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
			};
		}

		let fullText = "";
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
		);

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
		return { text: fullText, finishReason, usage, rateLimited };
	} finally {
		cdp.off("Network.responseReceived", onResponseReceived);
		cdp.off("Network.loadingFinished", onLoadingFinished);
		await cdp.send("Network.disable", {}, cdpSessionId).catch(() => {});
	}
}

// ── Main provider ─────────────────────────────────────────────────────────────

interface ClaudeCompletionResult {
	text: string;
	toolCalls: { name: string; arguments: Record<string, unknown> }[];
	usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

/**
 * Build the flat prompt sent to claude.ai, mirroring deepseek-web-v2's
 * `buildPrompt`: the real web client keeps its own server-side conversation
 * state, so the system prompt is sent verbatim on the conversation's first
 * turn (via `buildLeanConversation`'s own first-turn passthrough) and dropped
 * on every follow-up turn in the SAME Claude chat — re-added only when
 * `reInjectSystem` is true (a brand-new Claude chat, e.g. right after a
 * compaction opens a fresh one).
 */
function buildClaudePrompt(
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
		lastUserLabel: continuationLabel(conversation),
		toolResultLabel: "Tool result",
	};

	// Use a simpler system prompt for claude-web provider
	const simpleSystemPrompt =
		"Help me with this problem. Do not give me multiple codes options, just 1 option. You can give me command on how to search for code, or function, or read what file, using powershell commands. I will then paste you the results of what have been done that I followed you.";

	const customSystemMessage = systemMessage
		? {
				...systemMessage,
				content: simpleSystemPrompt,
			}
		: undefined;

	if (
		reInjectSystem &&
		customSystemMessage &&
		!alreadyHasSystem &&
		conversation.length > 0
	) {
		return messagesToPrompt(
			[customSystemMessage, ...conversation],
			promptOptions,
		);
	}
	return messagesToPrompt(conversation, promptOptions);
}

function createClaudeWebModel(
	modelId: string,
	logger?: BasicLogger,
): LanguageModelV2 {
	const runtimeConfig = resolveClaudeWebV2Config();

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
	// body, and recovers `<tool>` calls the model emitted — one code path so
	// both entry points behave identically instead of doStream being a thin,
	// divergent wrapper around doGenerate.
	async function runCompletion(
		options: LanguageModelV2CallOptions,
	): Promise<ClaudeCompletionResult> {
		debugLog("runCompletion called");

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

		const attachResult = await cdp.send("Target.attachToTarget", {
			targetId: pageTarget.targetId,
			flatten: true,
		});
		const cdpSessionId = attachResult.sessionId;

		// Chat continuity: this CLI conversation is keyed by its first user
		// message. A fresh key (no mapped Claude chat yet) means this call opens
		// a brand-new web chat, e.g. right after a compaction where the
		// compaction summary becomes the first user message.
		// Which web chat does this call go to? Normally the hash of the
		// conversation's first user message; during compaction, the chat the
		// last ordinary turn used, because the standalone summarize request
		// would otherwise hash to an empty chat of its own. See
		// `tool-pipeline/chat-target.ts` for the full /compact hand-off.
		const routedChatKey = consumeChatKeyOverride("claude-web");
		const chatKey = routedChatKey ?? chatKeyFromPrompt(options.prompt);
		if (!routedChatKey) {
			recordActiveChatKey("claude-web", chatKey);
		}
		const existingClaudeSession = lookupClaudeChatSession(
			runtimeConfig.chatsFile,
			chatKey,
		);
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
		// Claude chat — every other turn in the SAME chat sends no system
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

		const result = await sendAndCapture(
			cdp,
			cdpSessionId,
			promptText,
			runtimeConfig,
			logger,
			{},
			functionTools.length > 0,
		);

		debugLog(`Received response (${result.text.length} chars)`);

		// After sending, the SPA routes to `/c/<id>`; capture it so the next
		// turn (or a resume) can reopen this same Claude chat.
		const pageUrl = await readPageUrl(cdp, cdpSessionId);
		const claudeSession = extractClaudeSessionId(pageUrl);
		if (claudeSession) {
			recordClaudeChatSession(runtimeConfig.chatsFile, chatKey, claudeSession);
		}

		if (functionTools.length === 0) {
			return { text: result.text, toolCalls: [], usage: result.usage };
		}

		const toolNames = functionTools.map((t) => t.name);
		const { cleanedContent, toolCalls } = parseDeepSeekToolCalls(
			result.text,
			toolNames,
		);
		const looseCalls =
			toolCalls.length === 0
				? parseLooseDeepSeekToolCalls(result.text, toolNames)
				: toolCalls;
		if (looseCalls.length > 0) {
			const { tools: validatedCalls, retryPrompt } =
				validateToolCalls(looseCalls);
			const displayText = retryPrompt
				? `${cleanedContent}\n\n${retryPrompt}`.trim()
				: cleanedContent;
			return {
				text: displayText,
				toolCalls: validatedCalls,
				usage: result.usage,
			};
		}

		// The web model often ignores the `<tool>` contract and answers with
		// plain text (a plan, code fences, install commands). Convert the
		// visible structure of the reply into real tool calls so the agent
		// actually executes them, same as deepseek-web-v2's fallback.
		const fallback = parseFallbackToolUses(
			cleanedContent,
			lastUserText(options.prompt),
			toolNames,
		);
		return {
			text: fallback.cleanedText,
			toolCalls: fallback.toolUses,
			usage: result.usage,
		};
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

// ── Provider factory ──────────────────────────────────────────────────────────

export function createClaudeWebProvider(
	_config: GatewayResolvedProviderConfig,
	context?: GatewayProviderContext,
): ProviderFactoryResult {
	const logger = context?.logger;
	return {
		model: (modelId: string) => createClaudeWebModel(modelId, logger),
	};
}

export function createClaudeWebProviderFactory() {
	return { id: "claude-web", create: createClaudeWebProvider };
}

// ── Module factory (used by ai-sdk.ts) ────────────────────────────────────────

export function createClaudeWebProviderModule(
	config: GatewayResolvedProviderConfig,
	context?: GatewayProviderContext,
): ProviderFactoryResult {
	return createClaudeWebProvider(config, context);
}
