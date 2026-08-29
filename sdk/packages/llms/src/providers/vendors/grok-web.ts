/**
 * Grok Web ("grok-web") provider.
 *
 * Drives the real Grok web client (chat.Grok.ai) through your installed Chrome
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
import { stripPreviousUserBlock } from "./tool-pipeline/previous-user-dedupe";
import { validateToolCalls } from "./tool-pipeline/tool-dispatcher";
import type { ProviderFactoryResult } from "./types";

const CONFIG_DIR = path.join(os.homedir(), ".cline", "grok-web");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const Grok_WEB_URL = "https://chat.Grok.ai/";
const Grok_API_ENDPOINT = "/api/v2/chat/completions";

const DEFAULT_DEBUG_PORT = 9223;
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
 * the two must never share recovery state). When Grok rate-limits a turn, the
 * page can be left blocked; the next `runCompletion` forces a full reload even
 * if the URL already matches to clear it. Consumed (reset) after one reload.
 */
let GrokRecoverFromThrottle = false;

function requestGrokThrottleRecoveryReload(): void {
	GrokRecoverFromThrottle = true;
}

function consumeGrokThrottleRecoveryReload(): boolean {
	const shouldReload = GrokRecoverFromThrottle;
	GrokRecoverFromThrottle = false;
	return shouldReload;
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
}

interface ChatSessionRecord {
	session_id: string;
	first_seen: string;
	last_active: string;
}

export interface GrokWebChatEntry {
	chatKey: string;
	sessionId: string;
	firstSeen: string;
	lastActive: string;
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
	config: GrokWebV2RuntimeConfig,
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
				"~/.cline/grok-web/config.json",
				"Grok_WEB_CHROME_PATH",
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
		Grok_WEB_URL,
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
			providerId: "grok-web",
			pid: child.pid,
			debugPort: config.debugPort,
		});
	}

	try {
		await waitForEndpoint(config.debugPort, config.launchTimeoutMs);
	} catch (err) {
		throw new Error(
			`Failed to launch Chrome for Grok Web: ${(err as Error).message}. ` +
				"If Chrome is already running with this profile, close it or set a different Grok_WEB_PROFILE_DIR.",
		);
	}
	activeCdp = await connectCdp(config.debugPort, connectTimeoutMs);
	activeCdpKey = key;
	return activeCdp;
}

// ── Enhanced Grok send script (from send_Grok.txt) ──────────────────────────
const SEND_MESSAGE_SOURCE = `
// ---------- Helper: Select thinking mode ----------
async function selectThinkingMode(mode) {
    // mode: 'auto' | 'fast' | 'thinking'
    // Find the thinking mode toggle/button
    const selectors = [
        'button[aria-label*="Think" i]',
        'button[aria-label*="思考" i]',
        '[role="button"][aria-label*="Think" i]',
        '.thinking-toggle',
        '.deep-thinking-toggle'
    ];
    let btn = null;
    for (const sel of selectors) {
        btn = document.querySelector(sel);
        if (btn) break;
    }
    if (!btn) {
        console.warn('⚠️ Thinking mode toggle not found');
        return false;
    }
    // Click to toggle to desired mode (simple toggle: if mode is 'thinking' and not active, click; if mode is 'fast' and active, click)
    const isActive = btn.classList.contains('active') || btn.getAttribute('aria-pressed') === 'true';
    const targetActive = mode === 'thinking';
    if (isActive !== targetActive) {
        btn.click();
        console.log('🔄 Toggled thinking mode to', mode);
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    return true;
}

// ---------- Helper: Select model ----------
async function selectModel(modelName) {
    if (!modelName) return true;
    
    // Find the model selector button
    const modelBtn = document.querySelector('button[aria-label*="Model" i], button[aria-label*="模型" i], .model-selector, [role="button"][aria-label*="Model"], .chat-header-model');
    if (!modelBtn) {
        console.warn('⚠️ Model selector button not found');
        return false;
    }
    
    // Normalize strings for robust comparison (remove hyphens, spaces, underscores)
    const normalize = (str) => str.toLowerCase().replace(/[-_s]/g, '');
    const targetModel = normalize(modelName);
    
    // Check text content, aria-label, title, and common data attributes
    const currentText = normalize(modelBtn.textContent || '');
    const currentLabel = normalize(modelBtn.getAttribute('aria-label') || modelBtn.getAttribute('title') || '');
    const dataModel = normalize(modelBtn.getAttribute('data-model') || modelBtn.getAttribute('data-value') || '');
    
    // Avoid false positives from generic words like "model" or "模型"
    const genericWords = ['model', '模型', 'choose', 'select'];
    const isGeneric = genericWords.some(w => currentText === normalize(w));
    
    // Check if the target model is already reflected in the UI
    const isMatch = 
        currentText.includes(targetModel) || 
        (currentText.length > 2 && targetModel.includes(currentText)) ||
        currentLabel.includes(targetModel) ||
        dataModel.includes(targetModel);
        
    if (!isGeneric && isMatch) {
        console.log('✅ Model already selected:', modelName, '(UI shows:', modelBtn.textContent.trim(), ')');
        return true;
    }
    
    modelBtn.click();
    await new Promise(resolve => setTimeout(resolve, 400));
    
    // Find the model option in dropdown
    const options = document.querySelectorAll('[role="option"], .model-option, li');
    for (const opt of options) {
        if (normalize(opt.textContent || '').includes(targetModel) || targetModel.includes(normalize(opt.textContent || ''))) {
            opt.click();
            console.log('✅ Selected model:', modelName);
            await new Promise(resolve => setTimeout(resolve, 300));
            return true;
        }
    }
    
    console.warn('⚠️ Model not found in dropdown:', modelName);
    // Close dropdown
    document.body.click();
    return false;
}

// ---------- Robust Send Button Clicker ----------
async function clickSendButton(timeout) {
    timeout = timeout || 3000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const selectors = [
            'button[type="submit"]',
            'button[aria-label*="Send" i]',
            'button[aria-label*="发送" i]',
            'button[class*="send"]',
            'button[class*="send-btn"]',
            '.ant-btn-primary',
            'button[class*="ant-btn-primary"]',
            '[role="button"][aria-label*="Send" i]',
            '[role="button"][aria-label*="发送" i]'
        ];
        for (const sel of selectors) {
            const btn = document.querySelector(sel);
            if (btn && !btn.disabled && btn.offsetWidth > 0) {
                btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                btn.click();
                console.log('🖱️ Clicked send button:', sel);
                return true;
            }
        }
        // Check for button with icon arrow up
        const arrowButton = document.querySelector('button svg[class*="send"]')?.closest('button');
        if (arrowButton && arrowButton.offsetWidth > 0) {
            arrowButton.click();
            console.log('🖱️ Clicked send button (icon)');
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    console.warn('⚠️ Send button not found, falling back to Enter');
    return false;
}

// ---------- Main send function ----------
async function sendMessageToGrok(message, options) {
    options = options || {};
    const { thinkingMode, model } = options;

    // Apply thinking mode if specified
    if (thinkingMode) {
        await selectThinkingMode(thinkingMode);
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Model selection disabled on purpose: sending a message should not touch
    // the model picker. Whatever model the Grok web UI already has selected is
    // the one we use.
    // if (model) {
    //     await selectModel(model);
    //     await new Promise(resolve => setTimeout(resolve, 500));
    // }
    void model;

    // Find input field. IMPORTANT: never pick a textarea that belongs to a
    // rendered code block (Grok wraps those in .Grok-markdown-code / Monaco and
    // embeds a readonly .ime-text-area). Falling through to a bare textarea is
    // what made the assistant code box get mistaken for the composer.
    const inputField = (() => {
        const preferred = document.querySelector('textarea[placeholder*="消息" i], textarea[placeholder*="Message" i], [contenteditable="true"]');
        if (preferred && !preferred.disabled && !preferred.readOnly) {
            const bad = preferred.closest && preferred.closest('.Grok-markdown-code, .monaco-editor, [class*="markdown-code"], pre');
            if (!bad) return preferred;
        }
        const all = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]'));
        for (const el of all) {
            if (el.disabled || el.readOnly) continue;
            if (el.closest && el.closest('.Grok-markdown-code, .monaco-editor, [class*="markdown-code"], pre')) continue;
            const s = window.getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden') continue;
            if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;
            return el;
        }
        return null;
    })();
    if (!inputField) {
        console.error('❌ Input field not found');
        return false;
    }

    // Focus and set text
    inputField.focus();
    if (inputField.tagName === 'TEXTAREA') {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        if (nativeSetter) {
            nativeSetter.call(inputField, message);
        } else {
            inputField.value = message;
        }
        inputField.dispatchEvent(new Event('input', { bubbles: true }));
        inputField.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (inputField.isContentEditable) {
        inputField.textContent = message;
        inputField.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Wait for React state update
    await new Promise(resolve => setTimeout(resolve, 300));

    // Attempt to click send button
    const sendSuccess = await clickSendButton();
    if (sendSuccess) {
        console.log('✅ Sent:', message);
        return true;
    }

    // Fallback: try pressing Enter
    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
    inputField.dispatchEvent(enterEvent);
    console.log('✅ Sent with Enter:', message);
    return true;
}
`;

function buildSendScript(
	prompt: string,
	options?: { model?: string; thinkingMode?: string },
): string {
	const opts = options || {};
	return `(async () => {
        ${SEND_MESSAGE_SOURCE}
        await sendMessageToGrok(${JSON.stringify(prompt)}, ${JSON.stringify(opts)});
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
		console.warn(`[grok-web] failed to persist chat registry: ${error}`);
	}
}

export function lookupGrokChatSession(
	chatsFile: string,
	chatKey: string,
): string | undefined {
	return readChatRegistry(chatsFile)[chatKey]?.session_id;
}

export function recordGrokChatSession(
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

export function deleteGrokChatSession(
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

export function extractGrokSessionId(url: string): string | undefined {
	const match = /\/c\/([a-f0-9-]+)/.exec(url);
	return match?.[1] ?? undefined;
}

export function listGrokWebChats(): GrokWebChatEntry[] {
	const config = resolveGrokWebV2Config();
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
 * Opens an existing Grok Web chat in the browser driven by this provider.
 * This is what the CLI `/findchat` command calls after you pick a chat.
 */
export async function openGrokWebChat(
	sessionId: string,
): Promise<{ sessionId: string; url: string }> {
	const config = resolveGrokWebV2Config();
	const cdp = await connectBrowser(config);
	const targets = await cdp.send("Target.getTargets");
	let pageTarget = targets.targetInfos?.find(
		(t: any) => t.type === "page" && t.url?.startsWith("https://chat.Grok.ai"),
	);
	if (!pageTarget) {
		const result = await cdp.send("Target.createTarget", { url: Grok_WEB_URL });
		await sleep(2000);
		const newTargets = await cdp.send("Target.getTargets");
		pageTarget = newTargets.targetInfos?.find(
			(t: any) => t.targetId === result.targetId,
		);
		if (!pageTarget) {
			throw new Error("Failed to create Grok page");
		}
	}
	const attachResult = await cdp.send("Target.attachToTarget", {
		targetId: pageTarget.targetId,
		flatten: true,
	});
	const cdpSessionId = attachResult.sessionId;
	await navigateGrokChat(cdp, cdpSessionId, { fresh: false, sessionId });
	return {
		sessionId,
		url: `https://chat.Grok.ai/c/${sessionId}`,
	};
}

// ── SSE parser for Grok ──────────────────────────────────────────────────────

function consumeGrokSse(
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
		// Thinking-enabled replies tag each delta with `phase` ("think" vs
		// "answer"); prefer the answer-phase text, but also collect every
		// delta regardless of phase as a fallback for replies that never set
		// `phase` at all (thinking disabled, or a differently-shaped
		// response) — matching a known-working reference capture that reads
		// `delta.content` unconditionally instead of gating on `phase`.
		let answerText = "";
		let anyText = "";

		for (const rawLine of body.split("\n")) {
			const line = rawLine.trim();
			if (!line.startsWith("data:")) continue;
			const data = line.slice(5).trim();
			if (!data) continue;
			if (data === "[DONE]") break;

			let parsed: any;
			try {
				parsed = JSON.parse(data);
			} catch {
				continue;
			}

			for (const choice of Array.isArray(parsed.choices)
				? parsed.choices
				: []) {
				const delta = choice?.delta;
				const deltaContent =
					typeof delta?.content === "string" ? delta.content : "";
				if (deltaContent) {
					anyText += deltaContent;
					if (delta.phase === "answer" || delta.phase === undefined) {
						answerText += deltaContent;
					}
				}
				const messageContent =
					typeof choice?.message?.content === "string"
						? choice.message.content
						: "";
				if (messageContent) {
					anyText += messageContent;
					answerText += messageContent;
				}
			}

			if (typeof parsed.content === "string" && parsed.content) {
				anyText += parsed.content;
				answerText += parsed.content;
			}
			if (typeof parsed.output === "string" && parsed.output) {
				anyText += parsed.output;
				answerText += parsed.output;
			} else if (
				typeof parsed.output?.content === "string" &&
				parsed.output.content
			) {
				anyText += parsed.output.content;
				answerText += parsed.output.content;
			}

			if (parsed.usage && onUsage) {
				onUsage({
					inputTokens: parsed.usage.input_tokens || 0,
					outputTokens: parsed.usage.output_tokens || 0,
					totalTokens: parsed.usage.total_tokens || 0,
				});
			}
		}

		const finalText = answerText || anyText;
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
	config: GrokWebV2RuntimeConfig,
	logger?: BasicLogger,
): Promise<void> {
	const pageFullyLoaded = `(() => {
        if (document.readyState !== 'complete') return false;
        var candidates = Array.from(document.querySelectorAll('textarea, input[type="text"], .chat-input'));
        for (var i = 0; i < candidates.length; i++) {
            var ta = candidates[i];
            if (!ta || ta.disabled || ta.readOnly) continue;
            // Exclude Monaco/code-block editors rendered inside assistant
            // responses. Grok wraps code blocks in .Grok-markdown-code and the
            // Monaco editor contains a readonly .ime-text-area textarea that
            // used to be mistaken for the chat composer.
            if (ta.closest('.Grok-markdown-code, .monaco-editor, [class*="markdown-code"], pre')) continue;
            var s = window.getComputedStyle(ta);
            if (s.display === 'none' || s.visibility === 'hidden') continue;
            if (ta.offsetWidth === 0 || ta.offsetHeight === 0) continue;
            return true;
        }
        return false;
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
			if (config.debug) logger?.debug("[grok-web] page fully loaded");
			await sleep(1500);
			return;
		}

		if (!hintLogged) {
			hintLogged = true;
			logger?.log(
				"Grok Web: waiting for the chat.Grok.ai page to finish loading " +
					`(up to ${Math.round(config.loginTimeoutMs / 1000)}s). If the Chrome window shows a login page, log in now.`,
				{ severity: "info", providerId: "grok-web" },
			);
		}

		if (Date.now() >= deadline) {
			throw new Error(
				"Grok Web: chat.Grok.ai did not finish loading within " +
					`${Math.round(config.loginTimeoutMs / 1000)}s. Please log in to chat.Grok.ai in the Chrome window.`,
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
 * Point the Grok tab at a specific chat (load an old conversation) or at a
 * fresh composer (new chat). Skips navigating when the tab is already on the
 * destination — that is what avoids a needless full page reload on every
 * follow-up turn of the same conversation. `forceReload` skips that shortcut
 * to recover from a rate-limit block, where the page needs a real refresh to
 * accept messages again even though the URL is unchanged.
 */
async function navigateGrokChat(
	cdp: CdpClient,
	cdpSessionId: string,
	target: { sessionId?: string; fresh: boolean },
	logger?: BasicLogger,
	forceReload = false,
): Promise<void> {
	const destination = target.fresh
		? Grok_WEB_URL
		: target.sessionId
			? `https://chat.Grok.ai/c/${target.sessionId}`
			: Grok_WEB_URL;

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
			`[grok-web] already on ${destination} — skipping navigation (no reload)`,
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
		`[grok-web] ${target.fresh ? "opening a new Grok chat" : `loading Grok chat ${target.sessionId}`}`,
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
	config: GrokWebV2RuntimeConfig,
	logger?: BasicLogger,
	sendOptions?: { model?: string; thinkingMode?: string },
	isToolTurn = false,
	signal?: AbortSignal,
): Promise<{
	text: string;
	finishReason: LanguageModelV2FinishReason;
	usage: { inputTokens: number; outputTokens: number; totalTokens: number };
	rateLimited?: boolean;
}> {
	const debugLog = (msg: string) => {
		if (config.debug) logger?.debug(`[grok-web] ${msg}`);
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
		if (!url.includes(Grok_API_ENDPOINT)) return;
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
				`[grok-web] failed to read response body: ${err instanceof Error ? err.message : String(err)}`,
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
		// agent run) — dodges chat.Grok.ai's own anti-abuse frequency throttle
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
			return {
				text: "",
				finishReason: "stop",
				usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
			};
		}

		let fullText = "";
		const finishReason: LanguageModelV2FinishReason = "stop";
		let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
		consumeGrokSse(
			capturedBody,
			(chunk) => {
				fullText += chunk;
			},
			() => {},
			(err) => {
				logger?.error?.(`[grok-web] SSE parse error: ${err.message}`);
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
			requestGrokThrottleRecoveryReload();
			logger?.log?.(
				"[grok-web] Grok throttled the request (rate-limit reply detected). " +
					"Next message will reload the page to recover, and sending is paced. " +
					"Consider raising Grok_WEB_MIN/MAX_SEND_DELAY_MS.",
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

interface GrokCompletionResult {
	text: string;
	toolCalls: { name: string; arguments: Record<string, unknown> }[];
	usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

/**
 * Build the flat prompt sent to chat.Grok.ai, mirroring deepseek-web-v2's
 * `buildPrompt`: the real web client keeps its own server-side conversation
 * state, so the system prompt is sent verbatim on the conversation's first
 * turn (via `buildLeanConversation`'s own first-turn passthrough) and dropped
 * on every follow-up turn in the SAME Grok chat — re-added only when
 * `reInjectSystem` is true (a brand-new Grok chat, e.g. right after a
 * compaction opens a fresh one).
 */
function buildGrokPrompt(
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

function createGrokWebModel(
	modelId: string,
	logger?: BasicLogger,
): LanguageModelV2 {
	// Re-resolved on every turn, not captured once: `/profile` can switch the
	// active browser profile between turns, which changes the user-data-dir,
	// the debug port and the chat registry. A model built before the switch
	// would otherwise keep driving the old profile's Chrome.
	let runtimeConfig = resolveGrokWebV2Config();

	const debugLog = (msg: string) => {
		if (runtimeConfig.debug) logger?.debug(`[grok-web] ${msg}`);
	};

	// Shared by doGenerate/doStream (mirrors deepseek-web-v2's doCompletion):
	// drives the CDP session, sends the prompt, captures + parses the SSE
	// body, and recovers `<tool>` calls the model emitted — one code path so
	// both entry points behave identically instead of doStream being a thin,
	// divergent wrapper around doGenerate.
	async function runCompletion(
		options: LanguageModelV2CallOptions,
	): Promise<GrokCompletionResult> {
		runtimeConfig = resolveGrokWebV2Config();
		debugLog("runCompletion called");

		// A reply the user pasted back with `/paste` after a network error ate
		// the real one. Short-circuit before touching the browser: the text is
		// already the model's answer, it just needs the same tool parsing a
		// captured reply gets. No retry loop — a paste is a fixed string, so
		// re-sending a correction into the chat would be meaningless here.
		const injected = consumePendingInjectedReply("grok-web");
		if (injected) {
			debugLog(`Using pasted reply (${injected.length} chars)`);
			return buildCompletionFromText(injected, options);
		}

		// Cancelled while queued — do not open a browser for a dead turn.
		throwIfAborted(options.abortSignal);

		const cdp = await connectBrowser(runtimeConfig);

		const targets = await cdp.send("Target.getTargets");
		let pageTarget = targets.targetInfos?.find(
			(t: any) =>
				t.type === "page" && t.url?.startsWith("https://chat.Grok.ai"),
		);

		if (!pageTarget) {
			const result = await cdp.send("Target.createTarget", {
				url: Grok_WEB_URL,
			});
			await sleep(2000);
			const newTargets = await cdp.send("Target.getTargets");
			pageTarget = newTargets.targetInfos?.find(
				(t: any) => t.targetId === result.targetId,
			);
			if (!pageTarget) {
				throw new Error("Failed to create Grok page");
			}
		}

		const attachResult = await cdp.send("Target.attachToTarget", {
			targetId: pageTarget.targetId,
			flatten: true,
		});
		const cdpSessionId = attachResult.sessionId;

		// Chat continuity: this CLI conversation is keyed by its first user
		// message. A fresh key (no mapped Grok chat yet) means this call opens
		// a brand-new web chat, e.g. right after a compaction where the
		// compaction summary becomes the first user message.
		// Which web chat does this call go to? Normally the hash of the
		// conversation's first user message; during compaction, the chat the
		// last ordinary turn used, because the standalone summarize request
		// would otherwise hash to an empty chat of its own. See
		// `tool-pipeline/chat-target.ts` for the full /compact hand-off.
		const chatKey = resolveChatKey("grok-web", () =>
			chatKeyFromPrompt(options.prompt),
		);
		let existingGrokSession = lookupGrokChatSession(
			runtimeConfig.chatsFile,
			chatKey,
		);
		if (!existingGrokSession && chatKey.length !== 16) {
			existingGrokSession = chatKey;
			recordGrokChatSession(runtimeConfig.chatsFile, chatKey, chatKey);
		}
		const isNewChat = existingGrokSession === undefined;

		const forceReload = consumeGrokThrottleRecoveryReload();
		await navigateGrokChat(
			cdp,
			cdpSessionId,
			existingGrokSession
				? { sessionId: existingGrokSession, fresh: false }
				: { fresh: true },
			logger,
			forceReload,
		);

		await waitForComposerReady(cdp, cdpSessionId, runtimeConfig, logger);

		// Re-inject the system prompt only when this turn opens a brand-new
		// Grok chat — every other turn in the SAME chat sends no system
		// prompt at all, since the web client already has it server-side.
		// (Unlike deepseek-web-v2 this has no token-threshold re-injection:
		// Grok's SSE responses don't expose an equivalent cumulative
		// accumulated-context figure to gate that on.)
		let promptText = buildGrokPrompt(options.prompt, isNewChat, isNewChat);

		// The web chat is stateful: everything the user typed is already in it.
		// The current instruction still goes out — `messagesToPrompt` labels it
		// `User:` (or `Note:` on an iteration turn) — but every OLDER
		// `Previous user message:` block is dropped, so an instruction is sent
		// once and never re-sent on each round of a tool loop. Anything the user
		// wants restated goes through `/note`.
		promptText = stripPreviousUserBlock(promptText);

		const thinkingMode =
			(options as any).thinking === true
				? "thinking"
				: modelId.includes("thinking") || modelId.includes("think")
					? "thinking"
					: "auto";
		const modelName = modelId;
		const functionTools = (options.tools ?? []).filter(
			(tool): tool is LanguageModelV2FunctionTool => tool.type === "function",
		);

		debugLog(
			`Sending prompt (${promptText.length} chars) with model=${modelName}, thinking=${thinkingMode}`,
		);

		// Bounded retry: when EVERY tool call in a reply gets rejected (e.g.
		// invalid Python in an `editor` call), the rejection note is OUR
		// commentary on what the model typed — Grok never sees it just because
		// we computed it locally, since it isn't part of its server-side chat
		// history. Resend it as a real follow-up message in the SAME chat so
		// the model actually sees the rejection and can self-correct, capped
		// so a persistently broken model can't loop forever.
		const MAX_TOOL_REJECTION_RETRIES = 2;
		const toolNames = functionTools.map((t) => t.name);
		let sendPrompt = promptText;
		let result: Awaited<ReturnType<typeof sendAndCapture>> | undefined;
		let finalText = "";
		let finalToolCalls: GrokCompletionResult["toolCalls"] = [];

		for (let attempt = 0; ; attempt++) {
			result = await sendAndCapture(
				cdp,
				cdpSessionId,
				sendPrompt,
				runtimeConfig,
				logger,
				{ model: modelName, thinkingMode: thinkingMode },
				functionTools.length > 0,
				options.abortSignal,
			);

			debugLog(`Received response (${result.text.length} chars)`);

			if (functionTools.length === 0) {
				finalText = result.text;
				finalToolCalls = [];
				break;
			}

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
				if (
					validatedCalls.length === 0 &&
					retryPrompt &&
					attempt < MAX_TOOL_REJECTION_RETRIES
				) {
					logger?.log(
						`[grok-web] all tool calls rejected, resending correction into chat (attempt ${attempt + 1}/${MAX_TOOL_REJECTION_RETRIES})`,
						{ severity: "warn" },
					);
					sendPrompt = retryPrompt;
					continue;
				}
				finalText = retryPrompt
					? `${cleanedContent}\n\n${retryPrompt}`.trim()
					: cleanedContent;
				finalToolCalls = validatedCalls;
				break;
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
			finalText = fallback.cleanedText;
			finalToolCalls = fallback.toolUses;
			break;
		}

		// After sending, the SPA routes to `/c/<id>`; capture it so the next
		// turn (or a resume) can reopen this same Grok chat.
		const pageUrl = await readPageUrl(cdp, cdpSessionId);
		const GrokSession = extractGrokSessionId(pageUrl);
		if (GrokSession) {
			recordGrokChatSession(runtimeConfig.chatsFile, chatKey, GrokSession);
		}

		return { text: finalText, toolCalls: finalToolCalls, usage: result.usage };
	}

	/**
	 * Turn a raw reply body into a completion result, running the same tool
	 * recovery ladder a live capture goes through: strict `<tool>` blocks,
	 * then loose ones, then the plain-prose fallback.
	 */
	function buildCompletionFromText(
		text: string,
		options: LanguageModelV2CallOptions,
	): GrokCompletionResult {
		const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
		const toolNames = (options.tools ?? [])
			.filter(
				(tool): tool is LanguageModelV2FunctionTool => tool.type === "function",
			)
			.map((tool) => tool.name);
		if (toolNames.length === 0) {
			return { text, toolCalls: [], usage };
		}

		const { cleanedContent, toolCalls } = parseDeepSeekToolCalls(
			text,
			toolNames,
		);
		const looseCalls =
			toolCalls.length === 0
				? parseLooseDeepSeekToolCalls(text, toolNames)
				: toolCalls;
		if (looseCalls.length > 0) {
			const { tools: validatedCalls, retryPrompt } =
				validateToolCalls(looseCalls);
			return {
				text: retryPrompt
					? `${cleanedContent}\n\n${retryPrompt}`.trim()
					: cleanedContent,
				toolCalls: validatedCalls,
				usage,
			};
		}

		const fallback = parseFallbackToolUses(
			cleanedContent,
			lastUserText(options.prompt),
			toolNames,
		);
		return { text: fallback.cleanedText, toolCalls: fallback.toolUses, usage };
	}

	function finishReasonFor(
		text: string,
		toolCalls: GrokCompletionResult["toolCalls"],
	): LanguageModelV2FinishReason {
		return toolCalls.length > 0 ? "tool-calls" : text ? "stop" : "unknown";
	}

	const provider: LanguageModelV2 = {
		specificationVersion: "v2",
		provider: "grok-web",
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
				logger?.error?.(`[grok-web] doGenerate error: ${err.message}`);
				throw err;
			}
		},

		async doStream(options: LanguageModelV2CallOptions) {
			const { text, toolCalls, usage } = await runCompletion(options);
			const id = `grok-web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

export function createGrokWebProvider(
	_config: GatewayResolvedProviderConfig,
	context?: GatewayProviderContext,
): ProviderFactoryResult {
	const logger = context?.logger;
	return {
		model: (modelId: string) => createGrokWebModel(modelId, logger),
	};
}

export function createGrokWebProviderFactory() {
	return { id: "grok-web", create: createGrokWebProvider };
}

// ── Module factory (used by ai-sdk.ts) ────────────────────────────────────────

export function createGrokWebProviderModule(
	config: GatewayResolvedProviderConfig,
	context?: GatewayProviderContext,
): ProviderFactoryResult {
	return createGrokWebProvider(config, context);
}
