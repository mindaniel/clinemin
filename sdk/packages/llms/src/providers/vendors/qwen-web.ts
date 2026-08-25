/**
 * Qwen Web ("qwen-web") provider.
 *
 * Drives the real Qwen web client (chat.qwen.ai) through your installed Chrome
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
    LanguageModelV2Prompt,
    LanguageModelV2StreamPart,
} from "@ai-sdk/provider";
import type {
    BasicLogger,
    GatewayProviderContext,
    GatewayResolvedProviderConfig,
} from "@cline/shared";

import type { ProviderFactoryResult } from "./types";

const CONFIG_DIR = path.join(os.homedir(), ".cline", "qwen-web");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const DEFAULT_CHATS_FILE = path.join(CONFIG_DIR, "chats.json");
const QWEN_WEB_URL = "https://chat.qwen.ai/";
const QWEN_API_ENDPOINT = "/api/v2/chat/completions";

const DEFAULT_DEBUG_PORT = 9222;
const DEFAULT_LAUNCH_TIMEOUT_MS = 30000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 120000;
const DEFAULT_LOGIN_TIMEOUT_MS = 120000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface QwenWebV2RuntimeConfig {
    chromePath?: string;
    profileDir?: string;
    debugPort: number;
    headless: boolean;
    debug: boolean;
    launchTimeoutMs: number;
    responseTimeoutMs: number;
    loginTimeoutMs: number;
    chatsFile: string;
}

interface ChatSessionRecord {
    session_id: string;
    first_seen: string;
    last_active: string;
}

export interface QwenWebChatEntry {
    chatKey: string;
    sessionId: string;
    firstSeen: string;
    lastActive: string;
}

function readConfigFile(): Partial<QwenWebV2RuntimeConfig> {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    } catch {
        return {};
    }
}

export function resolveQwenWebV2Config(): QwenWebV2RuntimeConfig {
    const fileConfig = readConfigFile();
    const port = Number(process.env.QWEN_WEB_DEBUG_PORT ?? fileConfig.debugPort) || DEFAULT_DEBUG_PORT;
    return {
        chromePath: process.env.QWEN_WEB_CHROME_PATH || fileConfig.chromePath,
        profileDir: process.env.QWEN_WEB_PROFILE_DIR || fileConfig.profileDir,
        debugPort: port,
        headless: process.env.QWEN_WEB_HEADLESS !== undefined
            ? process.env.QWEN_WEB_HEADLESS !== "false"
            : (fileConfig.headless ?? false),
        debug: process.env.QWEN_WEB_DEBUG !== undefined
            ? process.env.QWEN_WEB_DEBUG !== "false"
            : (fileConfig.debug ?? false),
        launchTimeoutMs: Number(process.env.QWEN_WEB_LAUNCH_TIMEOUT_MS ?? fileConfig.launchTimeoutMs) || DEFAULT_LAUNCH_TIMEOUT_MS,
        responseTimeoutMs: Number(process.env.QWEN_WEB_RESPONSE_TIMEOUT_MS ?? fileConfig.responseTimeoutMs) || DEFAULT_RESPONSE_TIMEOUT_MS,
        loginTimeoutMs: Number(process.env.QWEN_WEB_LOGIN_TIMEOUT_MS ?? fileConfig.loginTimeoutMs) || DEFAULT_LOGIN_TIMEOUT_MS,
        chatsFile: process.env.QWEN_WEB_CHATS_FILE || fileConfig.chatsFile || DEFAULT_CHATS_FILE,
    };
}

function findChromePath(): string | undefined {
    const programFiles = process.env.PROGRAMFILES;
    const programFilesX86 = process.env["PROGRAMFILES(X86)"];
    const localAppData = process.env.LOCALAPPDATA;
    const candidates = [
        programFiles ? path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe") : undefined,
        programFilesX86 ? path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe") : undefined,
        localAppData ? path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe") : undefined,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
    ];
    return candidates.find((p) => p !== undefined && fs.existsSync(p));
}

async function isEndpointUp(port: number): Promise<boolean> {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
        return res.ok;
    } catch {
        return false;
    }
}

// ── CDP Client ────────────────────────────────────────────────────────────────

class CdpClient {
    private ws: WebSocket;
    private id = 0;
    private pending = new Map<number, { resolve: (value: any) => void; reject: (reason: any) => void }>();
    private listeners = new Map<string, Set<(params: any, sessionId?: string) => void>>();

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
                            try { cb(msg.params, msg.sessionId); } catch { /* ignore */ }
                        }
                    }
                }
            } catch { /* ignore */ }
        });
    }

    waitOpen(): Promise<void> {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error("CDP websocket timeout")), 8000);
            const onOpen = () => { clearTimeout(t); resolve(); };
            const onError = () => { clearTimeout(t); reject(new Error("CDP websocket error")); };
            this.ws.addEventListener("open", onOpen);
            this.ws.addEventListener("error", onError);
        });
    }

    send(method: string, params: any = {}, sessionId?: string): Promise<any> {
        const id = ++this.id;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
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
            const version = (await (await fetch(`${endpoint}/json/version`)).json()) as { webSocketDebuggerUrl: string };
            const cdp = new CdpClient(version.webSocketDebuggerUrl);
            await cdp.waitOpen();
            return cdp;
        } catch (err) {
            lastError = err;
            await sleep(750);
        }
    }
    const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
    throw new Error(`Could not connect to Chrome DevTools at ${endpoint} within ${Math.round(timeoutMs / 1000)}s${detail}`);
}

async function connectBrowser(config: QwenWebV2RuntimeConfig): Promise<CdpClient> {
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
        throw new Error("Could not find Chrome. Set chromePath in ~/.cline/qwen-web/config.json or QWEN_WEB_CHROME_PATH.");
    }
    const profileDir = config.profileDir ?? path.join(CONFIG_DIR, "profile");
    fs.mkdirSync(profileDir, { recursive: true });

    const args = [
        `--remote-debugging-port=${config.debugPort}`,
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-allow-origins=*",
        QWEN_WEB_URL,
    ];
    if (config.headless) args.push("--headless=new");

    const child = spawn(executablePath, args, {
        detached: true,
        stdio: "ignore",
        shell: process.platform === "win32",
    });
    child.unref();

    await sleep(3000);
    activeCdp = await connectCdp(config.debugPort, connectTimeoutMs);
    activeCdpKey = key;
    return activeCdp;
}

// ── Page-side send script ────────────────────────────────────────────────────

const SEND_MESSAGE_SOURCE = `
function findSendButton() {
    var selectors = [
        'button[type="submit"]',
        '.send-btn',
        '[data-testid="send-button"]',
        'button[aria-label*="Send" i]'
    ];
    for (var sel of selectors) {
        var el = document.querySelector(sel);
        if (el) return el;
    }
    return null;
}

function findTextarea() {
    var selectors = [
        'textarea',
        'textarea[placeholder*="message" i]',
        'input[type="text"]',
        '.chat-input'
    ];
    for (var sel of selectors) {
        var el = document.querySelector(sel);
        if (el && !el.disabled) return el;
    }
    return null;
}

function sendMessageToQwen(message) {
    var textarea = findTextarea();
    if (!textarea) {
        console.error('Textarea not found');
        return false;
    }
    textarea.focus();
    var nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    if (nativeSetter) {
        nativeSetter.call(textarea, message);
    } else {
        textarea.value = message;
    }
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    setTimeout(function() {
        var sendBtn = findSendButton();
        if (sendBtn) {
            sendBtn.click();
        } else {
            textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        }
    }, 300);
    return true;
}
`;

function buildSendScript(prompt: string): string {
    return `${SEND_MESSAGE_SOURCE} sendMessageToQwen(${JSON.stringify(prompt)}); true;`;
}

// ── Wait for composer ready ──────────────────────────────────────────────────

async function waitForComposerReady(
    cdp: CdpClient,
    sessionId: string,
    config: QwenWebV2RuntimeConfig,
    logger?: BasicLogger,
): Promise<void> {
    const pageFullyLoaded = `(() => {
        if (document.readyState !== 'complete') return false;
        var ta = document.querySelector('textarea, input[type="text"], .chat-input');
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
            const r = await cdp.send("Runtime.evaluate", {
                expression: pageFullyLoaded,
                returnByValue: true,
                awaitPromise: true,
            }, sessionId);
            ready = r.result?.value === true;
        } catch { /* ignore */ }

        if (ready) {
            if (config.debug) logger?.debug("[qwen-web] page fully loaded");
            await sleep(1500);
            return;
        }

        if (!hintLogged) {
            hintLogged = true;
            logger?.log(
                "Qwen Web: waiting for the chat.qwen.ai page to finish loading " +
                    `(up to ${Math.round(config.loginTimeoutMs / 1000)}s). If the Chrome window shows a login page, log in now.`,
                { severity: "info", providerId: "qwen-web" },
            );
        }

        if (Date.now() >= deadline) {
            throw new Error(
                "Qwen Web: chat.qwen.ai did not finish loading within " +
                    `${Math.round(config.loginTimeoutMs / 1000)}s. Please log in to chat.qwen.ai in the Chrome window.`,
            );
        }
        await sleep(500);
    }
}

// ── Chat session persistence ──────────────────────────────────────────────────

function readChatRegistry(chatsFile: string): Record<string, ChatSessionRecord> {
    try {
        return JSON.parse(fs.readFileSync(chatsFile, "utf-8"));
    } catch {
        return {};
    }
}

function writeChatRegistry(chatsFile: string, registry: Record<string, ChatSessionRecord>): void {
    try {
        fs.mkdirSync(path.dirname(chatsFile), { recursive: true });
        fs.writeFileSync(chatsFile, JSON.stringify(registry, null, 2), "utf-8");
    } catch (error) {
        console.warn(`[qwen-web] failed to persist chat registry: ${error}`);
    }
}

export function lookupQwenChatSession(chatsFile: string, chatKey: string): string | undefined {
    return readChatRegistry(chatsFile)[chatKey]?.session_id;
}

export function recordQwenChatSession(chatsFile: string, chatKey: string, sessionId: string): void {
    const registry = readChatRegistry(chatsFile);
    const existing = registry[chatKey];
    registry[chatKey] = {
        session_id: sessionId,
        first_seen: existing?.first_seen ?? new Date().toISOString(),
        last_active: new Date().toISOString(),
    };
    writeChatRegistry(chatsFile, registry);
}

export function deleteQwenChatSession(chatsFile: string, chatKey: string): void {
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
            ? message.content.map((block) => ("text" in block ? block.text : "")).join("\n")
            : message.content;
        firstUserText = typeof content === "string" ? content : "";
        break;
    }
    const normalized = firstUserText.trim().toLowerCase() || "<empty>";
    return createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}

export function extractQwenSessionId(url: string): string | undefined {
    const match = /\/c\/([a-f0-9-]+)/.exec(url);
    return match?.[1] ?? undefined;
}

export function listQwenWebChats(): QwenWebChatEntry[] {
    const config = resolveQwenWebV2Config();
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

// ── SSE parser for Qwen ──────────────────────────────────────────────────────

function consumeQwenSse(
    body: string,
    onChunk: (text: string) => void,
    onDone: () => void,
    onError: (err: Error) => void,
    onUsage?: (usage: { inputTokens: number; outputTokens: number; totalTokens: number }) => void,
): void {
    try {
        const lines = body.split("\n");
        for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") {
                onDone();
                return;
            }
            try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta;
                if (!delta) continue;
                if (delta.phase === "answer" && delta.content) {
                    onChunk(delta.content);
                }
                if (delta.status === "finished") {
                    onDone();
                    return;
                }
                // Capture usage if present
                if (parsed.usage && onUsage) {
                    onUsage({
                        inputTokens: parsed.usage.input_tokens || 0,
                        outputTokens: parsed.usage.output_tokens || 0,
                        totalTokens: parsed.usage.total_tokens || 0,
                    });
                }
            } catch {
                // Skip malformed JSON
            }
        }
        onDone();
    } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)));
    }
}

// ── Send and capture ──────────────────────────────────────────────────────────

async function sendAndCapture(
    cdp: CdpClient,
    cdpSessionId: string,
    prompt: string,
    config: QwenWebV2RuntimeConfig,
    logger?: BasicLogger,
): Promise<{ text: string; finishReason: LanguageModelV2FinishReason; usage: { inputTokens: number; outputTokens: number; totalTokens: number } }> {
    await cdp.send("Network.enable", {}, cdpSessionId);

    const responsePromise = new Promise<{ body: string }>((resolve) => {
        const handler = (params: any) => {
            if (params.response?.url?.includes(QWEN_API_ENDPOINT)) {
                const requestId = params.requestId;
                cdp.send("Network.getResponseBody", { requestId }, cdpSessionId)
                    .then((result: { body: string; base64Encoded: boolean }) => {
                        let body = result.body;
                        if (result.base64Encoded) {
                            body = Buffer.from(body, "base64").toString("utf-8");
                        }
                        resolve({ body });
                    })
                    .catch(() => resolve({ body: "" }));
            }
        };
        cdp.on("Network.responseReceived", handler);
        setTimeout(() => resolve({ body: "" }), config.responseTimeoutMs);
    });

    await waitForComposerReady(cdp, cdpSessionId, config, logger);

    await cdp.send("Runtime.evaluate", {
        expression: buildSendScript(prompt),
        returnByValue: true,
        awaitPromise: false,
    }, cdpSessionId);

    const response = await responsePromise;
    if (!response.body) {
        return { text: "", finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    }

    let fullText = "";
    let finishReason: LanguageModelV2FinishReason = "stop";
    let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    consumeQwenSse(
        response.body,
        (chunk) => { fullText += chunk; },
        () => {},
        (err) => { logger?.error?.(`[qwen-web] SSE parse error: ${err.message}`); },
        (u) => { usage = u; },
    );

    return { text: fullText, finishReason, usage };
}

// ── Main provider ─────────────────────────────────────────────────────────────

function createQwenWebModel(modelId: string, logger?: BasicLogger): LanguageModelV2 {
    const runtimeConfig = resolveQwenWebV2Config();

    const provider: LanguageModelV2 = {
        specificationVersion: "v2",
        provider: "qwen-web",
        modelId,
        supportedUrls: {} as Record<string, RegExp[]>,
        
        async doGenerate(options: LanguageModelV2CallOptions) {
            const debugLog = (msg: string) => {
                if (runtimeConfig.debug) logger?.debug(`[qwen-web] ${msg}`);
            };

            try {
                debugLog("doGenerate called");

                const cdp = await connectBrowser(runtimeConfig);

                const targets = await cdp.send("Target.getTargets");
                let pageTarget = targets.targetInfos?.find((t: any) => t.url?.startsWith("https://chat.qwen.ai"));

                if (!pageTarget) {
                    const result = await cdp.send("Target.createTarget", { url: QWEN_WEB_URL });
                    await sleep(2000);
                    const newTargets = await cdp.send("Target.getTargets");
                    pageTarget = newTargets.targetInfos?.find((t: any) => t.targetId === result.targetId);
                    if (!pageTarget) {
                        throw new Error("Failed to create Qwen page");
                    }
                }

                const attachResult = await cdp.send("Target.attachToTarget", {
                    targetId: pageTarget.targetId,
                    flatten: true,
                });
                const cdpSessionId = attachResult.sessionId;

                const promptText = options.prompt
                    .map((msg) => {
                        if (msg.role === "user" || msg.role === "assistant") {
                            return msg.content
                                .map((c) => ("text" in c ? c.text : ""))
                                .join("");
                        }
                        return "";
                    })
                    .filter(Boolean)
                    .join("\n");

                debugLog(`Sending prompt (${promptText.length} chars)`);

                const result = await sendAndCapture(cdp, cdpSessionId, promptText, runtimeConfig, logger);

                debugLog(`Received response (${result.text.length} chars)`);

                const content: LanguageModelV2Content[] = [{ type: "text", text: result.text }];

                return {
                    content,
                    finishReason: result.finishReason,
                    usage: result.usage,
                    warnings: [],
                };
            } catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                logger?.error?.(`[qwen-web] doGenerate error: ${err.message}`);
                throw err;
            }
        },

        async doStream(options: LanguageModelV2CallOptions) {
            const result = await this.doGenerate(options);
            const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
            const stream = new ReadableStream<LanguageModelV2StreamPart>({
                start(controller) {
                    if (text) {
                        controller.enqueue({ type: "text-delta", id: `text-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, delta: text });
                    }
                    controller.enqueue({ 
                        type: "finish", 
                        finishReason: result.finishReason,
                        usage: result.usage 
                    });
                    controller.close();
                },
            });
            return {
                stream,
                usage: result.usage,
            };
        },
    };

    return provider;
}

// ── Provider factory ──────────────────────────────────────────────────────────

export function createQwenWebProvider(
    _config: GatewayResolvedProviderConfig,
    context?: GatewayProviderContext,
): ProviderFactoryResult {
    const logger = context?.logger;
    return {
        model: (modelId: string) => createQwenWebModel(modelId, logger),
    };
}

export function createQwenWebProviderFactory() {
    return { id: "qwen-web", create: createQwenWebProvider };
}

// ── Module factory (used by ai-sdk.ts) ────────────────────────────────────────

export function createQwenWebProviderModule(
    config: GatewayResolvedProviderConfig,
    context?: GatewayProviderContext,
): ProviderFactoryResult {
    return createQwenWebProvider(config, context);
}
