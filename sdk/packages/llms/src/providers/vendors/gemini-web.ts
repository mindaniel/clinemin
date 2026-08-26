/**
 * Gemini Web ("gemini-web") provider.
 *
 * Drives the real Gemini web client (gemini.google.com) through your installed Chrome
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

const CONFIG_DIR = path.join(os.homedir(), ".cline", "gemini-web");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const DEFAULT_CHATS_FILE = path.join(CONFIG_DIR, "chats.json");
const GEMINI_WEB_URL = "https://gemini.google.com/";
const GEMINI_API_ENDPOINT = "/StreamGenerate";

const DEFAULT_DEBUG_PORT = 9226;
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
 * the two must never share recovery state). When Gemini rate-limits a turn, the
 * page can be left blocked; the next `runCompletion` forces a full reload even
 * if the URL already matches to clear it. Consumed (reset) after one reload.
 */
let geminiRecoverFromThrottle = false;

function requestGeminiThrottleRecoveryReload(): void {
	geminiRecoverFromThrottle = true;
}

function consumeGeminiThrottleRecoveryReload(): boolean {
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

interface ChatSessionRecord {
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

function readConfigFile(): Partial<GeminiWebV2RuntimeConfig> {
	try {
		return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
	} catch {
		return {};
	}
}

export function resolveGeminiWebV2Config(): GeminiWebV2RuntimeConfig {
	const fileConfig = readConfigFile();
	const port =
		Number(process.env.GEMINI_WEB_DEBUG_PORT ?? fileConfig.debugPort) ||
		DEFAULT_DEBUG_PORT;
	return {
		chromePath: process.env.GEMINI_WEB_CHROME_PATH || fileConfig.chromePath,
		profileDir: process.env.GEMINI_WEB_PROFILE_DIR || fileConfig.profileDir,
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
			DEFAULT_CHATS_FILE,
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
	config: GeminiWebV2RuntimeConfig,
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
			"Could not find Chrome. Set chromePath in ~/.cline/gemini-web/config.json or GEMINI_WEB_CHROME_PATH.",
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
		GEMINI_WEB_URL,
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
			`Failed to launch Chrome for Gemini Web: ${(err as Error).message}. ` +
				"If Chrome is already running with this profile, close it or set a different GEMINI_WEB_PROFILE_DIR.",
		);
	}
	activeCdp = await connectCdp(config.debugPort, connectTimeoutMs);
	activeCdpKey = key;
	return activeCdp;
}

// ── Enhanced Gemini send script (from send_gemini.txt) ──────────────────────────
const SEND_MESSAGE_SOURCE = `
// ---------- 1. Set text in Quill editor ----------
async function setGeminiInput(message) {
    const editor = document.querySelector('.ql-editor.textarea.new-input-ui') ||
                   document.querySelector('[data-test-id="textarea-inner"] .ql-editor') ||
                   document.querySelector('[contenteditable="true"][role="textbox"]');
    if (!editor) {
        console.error('Input editor not found');
        return false;
    }

    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);

    try {
        document.execCommand('insertText', false, message);
    } catch (e) {
        editor.innerHTML = '<p>' + message + '</p>';
    }

    editor.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: message
    }));

    await new Promise(resolve => setTimeout(resolve, 300));
    return true;
}

// ---------- 2. Click the send button ----------
async function waitForSendButton(timeout) {
    timeout = timeout || 4000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const selectors = [
            '[data-test-id="send-button"]',
            'button[aria-label*="Send"]',
            'button[class*="send"]',
            'button[type="submit"]'
        ];
        for (const sel of selectors) {
            const btn = document.querySelector(sel);
            if (btn && !btn.disabled) return btn;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    return null;
}

async function clickGeminiSend() {
    const sendBtn = await waitForSendButton();
    if (sendBtn) {
        sendBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        sendBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        sendBtn.click();
    } else {
        const editor = document.querySelector('.ql-editor.textarea.new-input-ui') ||
                       document.querySelector('[contenteditable="true"][role="textbox"]');
        if (editor) {
            editor.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true
            }));
        }
    }
    return true;
}

// ---------- 3. Main function ----------
async function sendMessageToGemini(message, options) {
    options = options || {};
    const inputSuccess = await setGeminiInput(message);
    if (!inputSuccess) return false;
    await new Promise(resolve => setTimeout(resolve, 500));
    await clickGeminiSend();
    console.log('Message sent');
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
        await sendMessageToGemini(${JSON.stringify(prompt)}, ${JSON.stringify(opts)});
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
		console.warn(`[gemini-web] failed to persist chat registry: ${error}`);
	}
}

export function lookupGeminiChatSession(
	chatsFile: string,
	chatKey: string,
): string | undefined {
	return readChatRegistry(chatsFile)[chatKey]?.session_id;
}

export function recordGeminiChatSession(
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

export function deleteGeminiChatSession(
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

export function extractGeminiSessionId(url: string): string | undefined {
	const match = /\/app\/([a-f0-9]+)/.exec(url);
	return match?.[1] ?? undefined;
}

export function listGeminiWebChats(): GeminiWebChatEntry[] {
	const config = resolveGeminiWebV2Config();
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
 * Opens an existing Gemini Web chat in the browser driven by this provider.
 * This is what the CLI `/findchat` command calls after you pick a chat.
 */
export async function openGeminiWebChat(
	sessionId: string,
): Promise<{ sessionId: string; url: string }> {
	const config = resolveGeminiWebV2Config();
	const cdp = await connectBrowser(config);
	const targets = await cdp.send("Target.getTargets");
	let pageTarget = targets.targetInfos?.find(
		(t: any) =>
			t.type === "page" && t.url?.startsWith("https://gemini.google.com"),
	);
	if (!pageTarget) {
		const result = await cdp.send("Target.createTarget", {
			url: GEMINI_WEB_URL,
		});
		await sleep(2000);
		const newTargets = await cdp.send("Target.getTargets");
		pageTarget = newTargets.targetInfos?.find(
			(t: any) => t.targetId === result.targetId,
		);
		if (!pageTarget) {
			throw new Error("Failed to create Gemini page");
		}
	}
	const attachResult = await cdp.send("Target.attachToTarget", {
		targetId: pageTarget.targetId,
		flatten: true,
	});
	const cdpSessionId = attachResult.sessionId;
	await navigateGeminiChat(cdp, cdpSessionId, { fresh: false, sessionId });
	return {
		sessionId,
		url: `https://gemini.google.com/app/${sessionId}`,
	};
}

// ── SSE parser for Gemini ──────────────────────────────────────────────────────

function consumeGeminiSse(
	body: string,
	onChunk: (text: string) => void,
	onDone: () => void,
	onError: (err: Error) => void,
	_onUsage?: (usage: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
	}) => void,
): void {
	try {
		// Gemini returns length-prefixed JSON (each line starts with "[").
		// Assistant text lives in arrays whose first element is an "rc_"
		// string; the following element holds the list of text parts.
		const extractText = (obj: any): string | null => {
			if (typeof obj === "string") {
				const s = obj.trim();
				if (s.startsWith("[") || s.startsWith("{")) {
					try {
						return extractText(JSON.parse(s));
					} catch {
						return null;
					}
				}
				return null;
			}
			if (Array.isArray(obj)) {
				if (
					obj.length > 1 &&
					typeof obj[0] === "string" &&
					obj[0].startsWith("rc_") &&
					Array.isArray(obj[1])
				) {
					const parts = obj[1].filter((p: unknown) => typeof p === "string");
					if (parts.length) return parts.join("");
				}
				for (const item of obj) {
					const t = extractText(item);
					if (t) return t;
				}
				return null;
			}
			if (obj && typeof obj === "object") {
				for (const value of Object.values(obj)) {
					const t = extractText(value);
					if (t) return t;
				}
			}
			return null;
		};

		let bestText = "";
		for (const rawLine of body.split("\n")) {
			const line = rawLine.trim();
			if (!line || !line.startsWith("[")) continue;
			let data: any;
			try {
				data = JSON.parse(line);
			} catch {
				continue;
			}
			const text = extractText(data);
			if (text && text.length > bestText.length) bestText = text;
		}

		const finalText = bestText.trim();
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
	config: GeminiWebV2RuntimeConfig,
	logger?: BasicLogger,
): Promise<void> {
	const pageFullyLoaded = `(() => {
        if (document.readyState !== 'complete') return false;
        var ta = document.querySelector('.ql-editor.textarea.new-input-ui, [data-test-id="textarea-inner"] .ql-editor, [contenteditable="true"][role="textbox"]');
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
			if (config.debug) logger?.debug("[gemini-web] page fully loaded");
			await sleep(1500);
			return;
		}

		if (!hintLogged) {
			hintLogged = true;
			logger?.log(
				"Gemini Web: waiting for the gemini.google.com page to finish loading " +
					`(up to ${Math.round(config.loginTimeoutMs / 1000)}s). If the Chrome window shows a login page, log in now.`,
				{ severity: "info", providerId: "gemini-web" },
			);
		}

		if (Date.now() >= deadline) {
			throw new Error(
				"Gemini Web: gemini.google.com did not finish loading within " +
					`${Math.round(config.loginTimeoutMs / 1000)}s. Please log in to gemini.google.com in the Chrome window.`,
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
 * Point the Gemini tab at a specific chat (load an old conversation) or at a
 * fresh composer (new chat). Skips navigating when the tab is already on the
 * destination — that is what avoids a needless full page reload on every
 * follow-up turn of the same conversation. `forceReload` skips that shortcut
 * to recover from a rate-limit block, where the page needs a real refresh to
 * accept messages again even though the URL is unchanged.
 */
async function navigateGeminiChat(
	cdp: CdpClient,
	cdpSessionId: string,
	target: { sessionId?: string; fresh: boolean },
	logger?: BasicLogger,
	forceReload = false,
): Promise<void> {
	const destination = target.fresh
		? GEMINI_WEB_URL
		: target.sessionId
			? `https://gemini.google.com/app/${target.sessionId}`
			: GEMINI_WEB_URL;

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
			`[gemini-web] already on ${destination} — skipping navigation (no reload)`,
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
		`[gemini-web] ${target.fresh ? "opening a new Gemini chat" : `loading Gemini chat ${target.sessionId}`}`,
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
	config: GeminiWebV2RuntimeConfig,
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
		if (config.debug) logger?.debug(`[gemini-web] ${msg}`);
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
		if (!url.toLowerCase().includes(GEMINI_API_ENDPOINT.toLowerCase())) return;
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
				`[gemini-web] failed to read response body: ${err instanceof Error ? err.message : String(err)}`,
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
		// agent run) — dodges gemini.google.com's own anti-abuse frequency throttle
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
		consumeGeminiSse(
			capturedBody,
			(chunk) => {
				fullText += chunk;
			},
			() => {},
			(err) => {
				logger?.error?.(`[gemini-web] SSE parse error: ${err.message}`);
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
			requestGeminiThrottleRecoveryReload();
			logger?.log?.(
				"[gemini-web] Gemini throttled the request (rate-limit reply detected). " +
					"Next message will reload the page to recover, and sending is paced. " +
					"Consider raising GEMINI_WEB_MIN/MAX_SEND_DELAY_MS.",
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

interface GeminiCompletionResult {
	text: string;
	toolCalls: { name: string; arguments: Record<string, unknown> }[];
	usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

/**
 * Build the flat prompt sent to gemini.google.com, mirroring deepseek-web-v2's
 * `buildPrompt`: the real web client keeps its own server-side conversation
 * state, so the system prompt is sent verbatim on the conversation's first
 * turn (via `buildLeanConversation`'s own first-turn passthrough) and dropped
 * on every follow-up turn in the SAME Gemini chat — re-added only when
 * `reInjectSystem` is true (a brand-new Gemini chat, e.g. right after a
 * compaction opens a fresh one).
 */
function buildGeminiPrompt(
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

function createGeminiWebModel(
	modelId: string,
	logger?: BasicLogger,
): LanguageModelV2 {
	const runtimeConfig = resolveGeminiWebV2Config();

	const debugLog = (msg: string) => {
		if (runtimeConfig.debug) logger?.debug(`[gemini-web] ${msg}`);
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
	): Promise<GeminiCompletionResult> {
		debugLog("runCompletion called");

		const cdp = await connectBrowser(runtimeConfig);

		const targets = await cdp.send("Target.getTargets");
		let pageTarget = targets.targetInfos?.find(
			(t: any) =>
				t.type === "page" && t.url?.startsWith("https://gemini.google.com"),
		);

		if (!pageTarget) {
			const result = await cdp.send("Target.createTarget", {
				url: GEMINI_WEB_URL,
			});
			await sleep(2000);
			const newTargets = await cdp.send("Target.getTargets");
			pageTarget = newTargets.targetInfos?.find(
				(t: any) => t.targetId === result.targetId,
			);
			if (!pageTarget) {
				throw new Error("Failed to create Gemini page");
			}
		}

		const attachResult = await cdp.send("Target.attachToTarget", {
			targetId: pageTarget.targetId,
			flatten: true,
		});
		const cdpSessionId = attachResult.sessionId;

		// Chat continuity: this CLI conversation is keyed by its first user
		// message. A fresh key (no mapped Gemini chat yet) means this call opens
		// a brand-new web chat, e.g. right after a compaction where the
		// compaction summary becomes the first user message.
		// Which web chat does this call go to? Normally the hash of the
		// conversation's first user message; during compaction, the chat the
		// last ordinary turn used, because the standalone summarize request
		// would otherwise hash to an empty chat of its own. See
		// `tool-pipeline/chat-target.ts` for the full /compact hand-off.
		const routedChatKey = consumeChatKeyOverride("gemini-web");
		const chatKey = routedChatKey ?? chatKeyFromPrompt(options.prompt);
		if (!routedChatKey) {
			recordActiveChatKey("gemini-web", chatKey);
		}
		const existingGeminiSession = lookupGeminiChatSession(
			runtimeConfig.chatsFile,
			chatKey,
		);
		const isNewChat = existingGeminiSession === undefined;

		const forceReload = consumeGeminiThrottleRecoveryReload();
		await navigateGeminiChat(
			cdp,
			cdpSessionId,
			existingGeminiSession
				? { sessionId: existingGeminiSession, fresh: false }
				: { fresh: true },
			logger,
			forceReload,
		);

		await waitForComposerReady(cdp, cdpSessionId, runtimeConfig, logger);

		// Re-inject the system prompt only when this turn opens a brand-new
		// Gemini chat — every other turn in the SAME chat sends no system
		// prompt at all, since the web client already has it server-side.
		// (Unlike deepseek-web-v2 this has no token-threshold re-injection:
		// Gemini's SSE responses don't expose an equivalent cumulative
		// accumulated-context figure to gate that on.)
		let promptText = buildGeminiPrompt(options.prompt, isNewChat, isNewChat);

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
		// turn (or a resume) can reopen this same Gemini chat.
		const pageUrl = await readPageUrl(cdp, cdpSessionId);
		const geminiSession = extractGeminiSessionId(pageUrl);
		if (geminiSession) {
			recordGeminiChatSession(runtimeConfig.chatsFile, chatKey, geminiSession);
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
		toolCalls: GeminiCompletionResult["toolCalls"],
	): LanguageModelV2FinishReason {
		return toolCalls.length > 0 ? "tool-calls" : text ? "stop" : "unknown";
	}

	const provider: LanguageModelV2 = {
		specificationVersion: "v2",
		provider: "gemini-web",
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
				logger?.error?.(`[gemini-web] doGenerate error: ${err.message}`);
				throw err;
			}
		},

		async doStream(options: LanguageModelV2CallOptions) {
			const { text, toolCalls, usage } = await runCompletion(options);
			const id = `gemini-web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

export function createGeminiWebProvider(
	_config: GatewayResolvedProviderConfig,
	context?: GatewayProviderContext,
): ProviderFactoryResult {
	const logger = context?.logger;
	return {
		model: (modelId: string) => createGeminiWebModel(modelId, logger),
	};
}

export function createGeminiWebProviderFactory() {
	return { id: "gemini-web", create: createGeminiWebProvider };
}

// ── Module factory (used by ai-sdk.ts) ────────────────────────────────────────

export function createGeminiWebProviderModule(
	config: GatewayResolvedProviderConfig,
	context?: GatewayProviderContext,
): ProviderFactoryResult {
	return createGeminiWebProvider(config, context);
}
