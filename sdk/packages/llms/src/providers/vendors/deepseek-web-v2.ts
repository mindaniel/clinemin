import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	LanguageModelV2,
	LanguageModelV2CallOptions,
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
	consumeDeepSeekSse,
	type DeepSeekWebUsageEstimate,
	estimateDeepSeekWebUsage,
	messagesToPrompt,
	parseDeepSeekToolCalls,
	resolveModelOptions,
} from "./deepseek-web";
import { validateToolCalls } from "./tool-pipeline/tool-dispatcher";
import type { ProviderFactoryResult } from "./types";

/**
 * DeepSeek Web v2 ("deepseek-web-v2") provider.
 *
 * Where v1 drives chat.deepseek.com's HTTP API directly (userToken, PoW
 * solver, /api/v0/chat/completion), v2 drives the *real web client* through
 * your installed Chrome via the DevTools Protocol — no userToken, no PoW, no
 * fake headers. Auth comes from the Chrome profile: log in to
 * chat.deepseek.com once and the session persists.
 *
 * Flow:
 *   1. Connect to Chrome over CDP (or launch it with a dedicated profile at
 *      `--remote-debugging-port=<port>`), mirroring the reference browser.py
 *      (real_chrome_profile + port 9222).
 *   2. Open (or reuse) a chat.deepseek.com tab.
 *   3. Send the prompt by evaluating the same page-side logic as
 *      sendmessage.js: pick the radio model ('default' | 'expert' | 'vision'),
 *      toggle "Deep thinking", type into `textarea[name="search"]`, click send.
 *   4. Capture the `chat/completion` SSE body with the CDP Network domain
 *      (mirroring the reference `browser.py`: `page.on("response")` + body
 *      read after `loadingFinished`), parse the `p`/`v` envelope with the same
 *      parser v1 uses, and stream text/reasoning back to the CLI.
 *
 * Tool calling uses the same `<tool>{json}</tool>` prompt contract as v1.
 *
 * Chat continuity (mirrors start_continue_chat.py): each CLI conversation is
 * keyed by a hash of its first user message and mapped to a DeepSeek web chat
 * in `~/.cline/deepseek-web-v2/chats.json`. A brand-new CLI conversation opens
 * a fresh DeepSeek composer; a follow-up or resumed CLI chat reopens its mapped
 * DeepSeek chat via `https://chat.deepseek.com/a/chat/s/<session_id>`.
 *
 * Configuration lives in `~/.cline/deepseek-web-v2/config.json` (mirroring the
 * llamacpp runtime pattern) with env overrides:
 *   DEEPSEEK_WEB_V2_CHROME_PATH / PROFILE_DIR / DEBUG_PORT / HEADLESS /
 *   DEBUG / LAUNCH_TIMEOUT_MS / RESPONSE_TIMEOUT_MS / LOGIN_TIMEOUT_MS /
 *   TOOL_PROMPT_MODE / TOOL_PROMPT_THRESHOLD_CHARS / CHATS_FILE.
 *
 * Message pacing (to avoid DeepSeek's "Messages too frequent" frequency
 * throttle): the provider sleeps a randomized `[MIN,MAX]` amount before each
 * send, plus an extra random delay on tool-request turns. Tune via
 *   MIN_SEND_DELAY_MS / MAX_SEND_DELAY_MS /
 *   TOOL_TURN_EXTRA_MIN_MS / TOOL_TURN_EXTRA_MAX_MS.
 *
 * When DeepSeek rate-limits, its reported `accumulated_token_usage` can drop
 * (a server-side rollback). The provider tracks context strictly
 * monotonically so that drop doesn't erase the system-prompt re-injection
 * thresholds or under-report usage.
 *
 * `headless` defaults to false — Chrome opens as a visible window so first-time
 * login and debugging are possible. Set `headless: true` (or
 * DEEPSEEK_WEB_V2_HEADLESS=true) once you trust the setup. `debug: true` logs
 * the page's console and the CDP capture progress through the gateway logger.
 *
 * Before sending, the provider waits until the composer is actually usable
 * (SPA hydrated + logged in) for up to `loginTimeoutMs` (default 120s), so a
 * first run — where you log in in the Chrome window — works without racing the
 * page load. The send step verifies the prompt was really typed and submitted
 * instead of assuming it was.
 */

const DEEPSEEK_WEB_URL = "https://chat.deepseek.com/";

const CONFIG_DIR = path.join(os.homedir(), ".cline", "deepseek-web-v2");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const DEFAULT_DEBUG_PORT = 9222;
const DEFAULT_LAUNCH_TIMEOUT_MS = 20_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 120_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 120_000;
const DEFAULT_TOOL_PROMPT_THRESHOLD_CHARS = 20_000;
/**
 * Where the CLI-conversation -> DeepSeek web chat mapping is persisted, so a
 * resumed/forked CLI chat reopens its original DeepSeek web conversation
 * (mirrors the `chat_sessions.json` in the reference `start_continue_chat.py`).
 */
const DEFAULT_CHATS_FILE = path.join(CONFIG_DIR, "chats.json");

/**
 * One-shot "recover from a throttle/block" signal. When DeepSeek rate-limited
 * the last turn ("Messages too frequent"), the page can be left in a stale or
 * temporarily-blocked state. On the next `runCompletion` we FORCE a page reload
 * even if the URL already matches the target chat — this clears the blocked
 * page and lets the composer work normally again. The flag is consumed (reset)
 * after one forced reload so healthy turns still skip reloading.
 */
let recoverFromThrottle = false;

/** Mark that the next turn must force a page reload to clear a throttle block. */
export function requestThrottleRecoveryReload(): void {
	recoverFromThrottle = true;
}

/** `true` exactly once, then reset — i.e. consume the pending recovery reload. */
export function consumeThrottleRecoveryReload(): boolean {
	const shouldReload = recoverFromThrottle;
	recoverFromThrottle = false;
	return shouldReload;
}

const DEFAULT_MIN_SEND_DELAY_MS = 800;
const DEFAULT_MAX_SEND_DELAY_MS = 2_800;
/** Extra randomized delay added when the turn is itself a tool-call turn. */
const DEFAULT_TOOL_TURN_EXTRA_MIN_MS = 1_500;
const DEFAULT_TOOL_TURN_EXTRA_MAX_MS = 4_500;

/** Whether the full `<tool>` contract + tool list is sent on every turn. */
export type ToolPromptMode = "lean" | "always";

export interface DeepSeekWebV2RuntimeConfig {
	chromePath?: string;
	profileDir?: string;
	debugPort: number;
	headless: boolean;
	debug: boolean;
	launchTimeoutMs: number;
	responseTimeoutMs: number;
	/** How long to wait for the composer to become usable (login + hydration). */
	loginTimeoutMs: number;
	/**
	 * Path to the persistent chat-session registry (CLI chat key -> DeepSeek
	 * web `session_id`). Overridable via DEEPSEEK_WEB_V2_CHATS_FILE so multiple
	 * profiles/processes don't fight over the same mapping.
	 */
	chatsFile: string;
	/**
	 * Legacy: accepted for backward compatibility with existing config files.
	 * The tool-contract block is no longer prepended (the system prompt itself
	 * carries the `<tool>` protocol and tool list), so this no longer changes
	 * the prompt.
	 */
	toolPromptMode: ToolPromptMode;
	/** Legacy: accepted for backward compatibility; no longer used. */
	toolPromptThresholdChars: number;
	/**
	 * Lower bound of the random sleep applied before each message send.
	 * Randomized (with `maxSendDelayMs`) so sends don't look machine-gunned.
	 */
	minSendDelayMs: number;
	/** Upper bound of the random sleep applied before each message send. */
	maxSendDelayMs: number;
	/**
	 * Lower bound of the EXTRA random sleep added on turns that are themselves
	 * tool-request turns (the fastest back-to-back pattern in an agent run).
	 */
	toolTurnExtraMinMs: number;
	/** Upper bound of the EXTRA random sleep added on tool-request turns. */
	toolTurnExtraMaxMs: number;
}

function readConfigFile(): Partial<DeepSeekWebV2RuntimeConfig> {
	try {
		return JSON.parse(
			fs.readFileSync(CONFIG_FILE, "utf-8"),
		) as Partial<DeepSeekWebV2RuntimeConfig>;
	} catch {
		return {};
	}
}

/**
 * Env vars win over the config file, mirroring the llamacpp runtime pattern so
 * scripted/CI runs can override without editing files.
 */
export function resolveDeepSeekWebV2Config(): DeepSeekWebV2RuntimeConfig {
	const fileConfig = readConfigFile();
	const port =
		Number(process.env.DEEPSEEK_WEB_V2_DEBUG_PORT ?? fileConfig.debugPort) ||
		DEFAULT_DEBUG_PORT;
	return {
		chromePath:
			process.env.DEEPSEEK_WEB_V2_CHROME_PATH || fileConfig.chromePath,
		profileDir:
			process.env.DEEPSEEK_WEB_V2_PROFILE_DIR || fileConfig.profileDir,
		debugPort: port,
		headless:
			process.env.DEEPSEEK_WEB_V2_HEADLESS !== undefined
				? process.env.DEEPSEEK_WEB_V2_HEADLESS !== "false"
				: (fileConfig.headless ?? false),
		debug:
			process.env.DEEPSEEK_WEB_V2_DEBUG !== undefined
				? process.env.DEEPSEEK_WEB_V2_DEBUG !== "false"
				: (fileConfig.debug ?? false),
		launchTimeoutMs:
			Number(
				process.env.DEEPSEEK_WEB_V2_LAUNCH_TIMEOUT_MS ??
					fileConfig.launchTimeoutMs,
			) || DEFAULT_LAUNCH_TIMEOUT_MS,
		responseTimeoutMs:
			Number(
				process.env.DEEPSEEK_WEB_V2_RESPONSE_TIMEOUT_MS ??
					fileConfig.responseTimeoutMs,
			) || DEFAULT_RESPONSE_TIMEOUT_MS,
		loginTimeoutMs:
			Number(
				process.env.DEEPSEEK_WEB_V2_LOGIN_TIMEOUT_MS ??
					fileConfig.loginTimeoutMs,
			) || DEFAULT_LOGIN_TIMEOUT_MS,
		toolPromptMode:
			(process.env.DEEPSEEK_WEB_V2_TOOL_PROMPT_MODE ??
				fileConfig.toolPromptMode) === "always"
				? "always"
				: "lean",
		toolPromptThresholdChars:
			Number(
				process.env.DEEPSEEK_WEB_V2_TOOL_PROMPT_THRESHOLD_CHARS ??
					fileConfig.toolPromptThresholdChars,
			) || DEFAULT_TOOL_PROMPT_THRESHOLD_CHARS,
		minSendDelayMs:
			Number(
				process.env.DEEPSEEK_WEB_V2_MIN_SEND_DELAY_MS ??
					fileConfig.minSendDelayMs,
			) || DEFAULT_MIN_SEND_DELAY_MS,
		maxSendDelayMs:
			Number(
				process.env.DEEPSEEK_WEB_V2_MAX_SEND_DELAY_MS ??
					fileConfig.maxSendDelayMs,
			) || DEFAULT_MAX_SEND_DELAY_MS,
		toolTurnExtraMinMs:
			Number(
				process.env.DEEPSEEK_WEB_V2_TOOL_TURN_EXTRA_MIN_MS ??
					fileConfig.toolTurnExtraMinMs,
			) || DEFAULT_TOOL_TURN_EXTRA_MIN_MS,
		toolTurnExtraMaxMs:
			Number(
				process.env.DEEPSEEK_WEB_V2_TOOL_TURN_EXTRA_MAX_MS ??
					fileConfig.toolTurnExtraMaxMs,
			) || DEFAULT_TOOL_TURN_EXTRA_MAX_MS,
		chatsFile:
			process.env.DEEPSEEK_WEB_V2_CHATS_FILE ||
			fileConfig.chatsFile ||
			DEFAULT_CHATS_FILE,
	};
}

/**
 * Random integer in the inclusive `[min, max]` range. `rng` is injectable so
 * tests can pin a deterministic value; defaults to `Math.random`.
 */
export function randomInRange(
	min: number,
	max: number,
	rng: () => number = Math.random,
): number {
	// Guard against inverted / degenerate ranges so the delay is always sane.
	const low = Math.min(min, max);
	const high = Math.max(min, max);
	if (high <= low) return low;
	return Math.floor(low + rng() * (high - low + 1));
}

/**
 * Compute the randomized sleep to apply before sending one message to the
 * DeepSeek web UI. Every send waits a random `[min,max]` amount; tool-request
 * turns (the most rapid-fire pattern in an agent run) get an extra random
 * delay on top, making the pacing irregular enough to dodge the
 * "Messages too frequent" throttle while still being clearly randomized.
 *
 * `rng` is injectable for deterministic tests (defaults to `Math.random`).
 */
export function computeSendDelay(
	config: Pick<
		DeepSeekWebV2RuntimeConfig,
		| "minSendDelayMs"
		| "maxSendDelayMs"
		| "toolTurnExtraMinMs"
		| "toolTurnExtraMaxMs"
	>,
	opts: { isToolTurn: boolean },
	rng: () => number = Math.random,
): number {
	const base = randomInRange(config.minSendDelayMs, config.maxSendDelayMs, rng);
	if (!opts.isToolTurn) return base;
	const extra = randomInRange(
		config.toolTurnExtraMinMs,
		config.toolTurnExtraMaxMs,
		rng,
	);
	return base + extra;
}

/**
 * Human-ish markers DeepSeek uses to say "slow down". Used to detect a
 * throttled reply so the provider can log/back off instead of misinterpreting
 * it as a normal (possibly shorter-context) completion.
 */
const RATE_LIMIT_TEXT_RE =
	/Messages too frequent|Try again later|too many requests|rate.limit|slow down/i;

/** Return `true` when `text` looks like a DeepSeek anti-abuse / throttle reply. */
export function isRateLimitText(text: string): boolean {
	return RATE_LIMIT_TEXT_RE.test(text);
}

/** Locate an installed Chrome/Chromium binary (same candidate list as the reference browser.py). */
export function findChromePath(): string | undefined {
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
		"/usr/bin/chromium-browser",
	];
	return candidates.find((p) => p !== undefined && fs.existsSync(p));
}

/**
 * Derive a stable key for a CLI conversation from its first user message. All
 * turns of one CLI chat share the same first user message (the transcript is
 * preserved across turns and restarts), so this key is auto-consistent across
 * follow-ups and resumes — and a brand-new CLI chat (new first prompt) yields a
 * brand-new key that starts a fresh DeepSeek web chat. This mirrors the "small
 * message" identity in start_continue_chat.py: same conversation -> same chat.
 */
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

/** A persisted mapping entry for one CLI conversation -> one DeepSeek web chat. */
interface ChatSessionRecord {
	session_id: string;
	first_seen: string;
	last_active: string;
}

/** A DeepSeek web chat `session_id` from a `a/chat/s/<session_id>` URL, if any. */
export function parseSessionIdFromUrl(url: string): string | undefined {
	const match = /\/a\/chat\/s\/([^/?#]+)/.exec(url);
	return match?.[1] ?? undefined;
}

function readChatRegistry(
	chatsFile: string,
): Record<string, ChatSessionRecord> {
	try {
		return JSON.parse(fs.readFileSync(chatsFile, "utf-8")) as Record<
			string,
			ChatSessionRecord
		>;
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
		// Never let a persistence failure break the conversation.
		console.warn(
			`[deepseek-web-v2] failed to persist chat registry to ${chatsFile}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/** Look up the DeepSeek web chat previously mapped to this CLI conversation. */
export function lookupChatSession(
	chatsFile: string,
	chatKey: string,
): string | undefined {
	return readChatRegistry(chatsFile)[chatKey]?.session_id;
}

/**
 * Record (or keep mapping) a DeepSeek web chat for a CLI conversation and
 * touch its `last_active`.
 */
export function recordChatSession(
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A ReadableStream we can push bytes into from the CDP IO.read loop. */
interface PushSink {
	stream: ReadableStream<Uint8Array>;
	push(chunk: Uint8Array): void;
	close(): void;
	error(err: unknown): void;
}

function createPushSink(): PushSink {
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let closed = false;
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
		cancel() {
			closed = true;
		},
	});
	return {
		stream,
		push(chunk) {
			if (closed) return;
			try {
				controller?.enqueue(chunk);
			} catch {
				// sink already errored/closed — ignore late pushes
			}
		},
		close() {
			if (closed) return;
			closed = true;
			try {
				controller?.close();
			} catch {
				// ignore
			}
		},
		error(err) {
			if (closed) return;
			closed = true;
			try {
				controller?.error(err);
			} catch {
				// ignore
			}
		},
	};
}

// ── Page-side send script (transcribed from sendmessage.js) ─────────────────

/**
 * The same UI-driving code as the reference `sendmessage.js` (functions only —
 * the trailing demo calls are omitted). Evaluated inside chat.deepseek.com via
 * `page.evaluate`. Selectors intentionally mirror the working reference.
 */
const SEND_MESSAGE_SOURCE = `
function selectModel(modelType) {
    var validModels = ['default', 'expert', 'vision'];
    if (validModels.indexOf(modelType) === -1) {
        console.warn('Invalid model type: ' + modelType + '. Using current.');
        return false;
    }
    var radioGroup = document.querySelector('[role="radiogroup"]');
    if (!radioGroup) {
        console.warn('Model selection not found');
        return false;
    }
    var buttons = radioGroup.querySelectorAll('[role="radio"]');
    var found = false;
    buttons.forEach(function (button) {
        var model = button.getAttribute('data-model-type');
        if (model === modelType) {
            var isChecked = button.getAttribute('aria-checked') === 'true';
            if (!isChecked) {
                button.click();
                console.log('Model set to: ' + modelType);
            } else {
                console.log('Model already: ' + modelType);
            }
            found = true;
        }
    });
    if (!found) console.warn('Model button for "' + modelType + '" not found');
    return found;
}

function toggleDeepThinking(enable) {
    var buttons = document.querySelectorAll('.ds-toggle-button');
    var found = false;
    buttons.forEach(function (button) {
        var label = button.querySelector('._6dbc175');
        if (label && label.textContent.trim() === 'Deep thinking') {
            var isSelected = button.classList.contains('ds-toggle-button--selected');
            if ((enable && !isSelected) || (!enable && isSelected)) {
                button.click();
                console.log('Deep thinking ' + (enable ? 'ENABLED' : 'DISABLED'));
            } else {
                console.log('Deep thinking already ' + (enable ? 'ENABLED' : 'DISABLED'));
            }
            found = true;
        }
    });
    if (!found) console.warn('Deep thinking toggle not found');
}

function findSendButton() {
    var filled = document.querySelector('.ds-button--filled');
    if (filled) {
        var filledButton = filled.closest('[role="button"]');
        if (filledButton) return filledButton;
    }
    var icon = document.querySelector('.ds-button__icon svg[viewBox="0 0 16 16"]');
    if (icon) {
        var iconButton = icon.closest('[role="button"]');
        if (iconButton) return iconButton;
    }
    return null;
}

function sendMessageToDeepSeek(message, options) {
    options = options || {};
    var model = options.model !== undefined ? options.model : null;
    var deepThinking = options.deepThinking !== undefined ? options.deepThinking : null;

    var textarea = document.querySelector('textarea[name="search"]');
    if (!textarea) {
        console.error('Textarea not found');
        return false;
    }

    // Apply model selection / Deep Thinking toggle before typing.
    if (model !== null) selectModel(model);
    if (deepThinking !== null) toggleDeepThinking(deepThinking);

    // Type after any clicks settle, then submit 300ms later. This mirrors the
    // reference sendmessage.js exactly — fire-and-forget from the caller's
    // perspective; the caller verifies the outcome via the DOM afterwards.
    setTimeout(function () {
        var nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        nativeSetter.call(textarea, message);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        setTimeout(function () {
            var sendBtn = findSendButton();
            if (sendBtn) {
                sendBtn.click();
                console.log('Sent: "' + message + '"');
            } else {
                textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                console.log('Sent with Enter: "' + message + '"');
            }
        }, 300);
    }, (model !== null || deepThinking !== null) ? 400 : 0);

    return true;
}
`;

/**
 * Build a self-contained page expression that defines the send script and
 * immediately sends `prompt` with the given model options. The message/options
 * are embedded as JSON string literals so the expression is valid without
 * `eval`/`new Function` (which page CSP could block).
 *
 * The page-side send is fire-and-forget (mirrors the reference `sendmessage.js`):
 * typing and the send click happen inside `setTimeout` callbacks after the
 * expression resolves. The caller verifies the outcome by polling the DOM
 * afterwards instead of trusting the evaluate result.
 */
export function buildSendScript(
	prompt: string,
	options: { modelType: string; deepThinking: boolean | null },
): string {
	const opts: Record<string, unknown> = { model: options.modelType };
	if (options.deepThinking !== null) {
		opts.deepThinking = options.deepThinking;
	}
	return `(() => {
${SEND_MESSAGE_SOURCE}
sendMessageToDeepSeek(${JSON.stringify(prompt)}, ${JSON.stringify(opts)});
return true;
})()`;
}

/**
 * Map a model id to the web UI's radio model + Deep Thinking toggle state.
 * `deepThinking` is `null` when the toggle should be left untouched (vision).
 */
export function resolveV2ModelOptions(modelId: string): {
	modelType: string;
	deepThinking: boolean | null;
} {
	const m = modelId.toLowerCase();
	if (m.includes("vision")) return { modelType: "vision", deepThinking: null };
	const { modelType, thinkingEnabled } = resolveModelOptions(modelId);
	return { modelType, deepThinking: thinkingEnabled };
}

// ── Browser session (raw CDP over WebSocket) ───────────────────────────────

/** The active CDP browser connection, reused across turns. */
let activeCdp: CdpClient | undefined;
let activeCdpKey: string | undefined;

async function isEndpointUp(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
			signal: AbortSignal.timeout(800),
		});
		return res.ok;
	} catch {
		return false;
	}
}

async function waitForEndpoint(port: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await isEndpointUp(port)) return;
		await sleep(300);
	}
	throw new Error(
		`Chrome did not open a DevTools endpoint on port ${port} within ${Math.round(timeoutMs / 1000)}s.`,
	);
}

/**
 * A minimal CDP client over Chrome's raw DevTools websocket. Playwright's
 * `connectOverCDP` is incompatible with current Chrome builds (websocket
 * handshake fails), so the provider drives the browser directly — the same
 * transport `browser.py` relies on for network monitoring.
 */
export class CdpClient {
	private ws: WebSocket;
	private id = 0;
	private pending = new Map<
		number,
		{ resolve: (v: any) => void; reject: (e: Error) => void }
	>();
	private listeners = new Map<
		string,
		Set<(params: any, sessionId?: string) => void>
	>();

	constructor(wsUrl: string) {
		this.ws = new WebSocket(wsUrl);
		this.ws.addEventListener("message", (event) => {
			const msg = JSON.parse(event.data as string);
			if (msg.id && this.pending.has(msg.id)) {
				const p = this.pending.get(msg.id)!;
				this.pending.delete(msg.id);
				if (msg.error)
					p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
				else p.resolve(msg.result);
			} else if (msg.method) {
				const cbs = this.listeners.get(msg.method);
				if (cbs) for (const cb of cbs) cb(msg.params, msg.sessionId);
			}
		});
	}

	isOpen(): boolean {
		return this.ws.readyState === WebSocket.OPEN;
	}

	async waitOpen(): Promise<void> {
		if (this.ws.readyState === WebSocket.OPEN) return;
		await new Promise<void>((resolve, reject) => {
			const t = setTimeout(
				() => reject(new Error("CDP websocket open timeout")),
				8_000,
			);
			this.ws.addEventListener("open", () => {
				clearTimeout(t);
				resolve();
			});
			this.ws.addEventListener("error", () => {
				clearTimeout(t);
				reject(new Error("CDP websocket error during open"));
			});
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
			}, 30_000);
		});
	}

	on(method: string, cb: (params: any, sessionId?: string) => void): void {
		if (!this.listeners.has(method)) this.listeners.set(method, new Set());
		this.listeners.get(method)?.add(cb);
	}

	close(): void {
		this.ws.close();
	}
}

/**
 * Connect to the browser's raw CDP websocket, retrying while it comes up. The
 * HTTP endpoint can answer before the browser websocket accepts connections,
 * so retry with backoff instead of failing on a single attempt.
 */
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

/**
 * Return a raw CDP connection to Chrome on the configured debug port, launching
 * a dedicated-profile Chrome if nothing is listening yet. Reuses the cached
 * connection across turns while its websocket stays open.
 */
async function connectBrowser(
	config: DeepSeekWebV2RuntimeConfig,
): Promise<CdpClient> {
	const key = `${config.debugPort}`;
	if (activeCdp && activeCdpKey === key && activeCdp.isOpen()) {
		return activeCdp;
	}

	const connectTimeoutMs = Math.max(config.launchTimeoutMs, 30_000);

	if (await isEndpointUp(config.debugPort)) {
		activeCdp = await connectCdp(config.debugPort, connectTimeoutMs);
		activeCdpKey = key;
		return activeCdp;
	}

	const executablePath = config.chromePath ?? findChromePath();
	if (!executablePath) {
		throw new Error(
			"Could not find Chrome. Set chromePath in ~/.cline/deepseek-web-v2/config.json or DEEPSEEK_WEB_V2_CHROME_PATH.",
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
		DEEPSEEK_WEB_URL,
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
			`Failed to launch Chrome for DeepSeek Web v2: ${(err as Error).message}. ` +
				"If Chrome is already running with this profile, close it or set a different DEEPSEEK_WEB_V2_PROFILE_DIR.",
		);
	}

	activeCdp = await connectCdp(config.debugPort, connectTimeoutMs);
	activeCdpKey = key;
	return activeCdp;
}

/** Attach to the chat.deepseek.com tab, reusing an open one or creating it. */
async function ensureDeepSeekPage(
	cdp: CdpClient,
): Promise<{ targetId: string; sessionId: string }> {
	const { targetInfos } = await cdp.send("Target.getTargets");
	let target = targetInfos.find(
		(t: any) => t.type === "page" && t.url.includes("chat.deepseek.com"),
	);
	if (!target) {
		const created = await cdp.send("Target.createTarget", {
			url: DEEPSEEK_WEB_URL,
		});
		target = { targetId: created.targetId };
	}
	const { sessionId } = await cdp.send("Target.attachToTarget", {
		targetId: target.targetId,
		flatten: true,
	});
	return { targetId: target.targetId, sessionId };
}

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
 * Decide whether navigating to `destination` would be a no-op because the tab
 * is already there. Normalizes by stripping a trailing slash and any fragment,
 * so harmless differences (e.g. `https://chat.deepseek.com/` vs
 * `https://chat.deepseek.com#x`) don't force a needless full page reload.
 */
export function isSameChatLocation(
	currentUrl: string,
	destination: string,
): boolean {
	const normalize = (url: string): string =>
		(url || "").replace(/\/+$/, "").split("#")[0] ?? "";
	return (
		normalize(currentUrl) === normalize(destination) &&
		normalize(destination) !== ""
	);
}

/**
 * Point the DeepSeek tab at a specific chat (load an old conversation) or at a
 * fresh composer (new chat). After navigating, the caller's
 * `waitForComposerReady` poll confirms the SPA reached a usable composer.
 *
 * IMPORTANT: if the tab is ALREADY on the target URL, we do NOT navigate. This
 * is what avoids a needless full page reload on every follow-up turn of the
 * same conversation — a reload that raced the CDP network-capture listener and
 * could cause "message was not typed into the composer within 10s" (especially
 * with slow internet). The SPA routes between chats client-side, so skipping a
 * same-URL reload is safe and still reaches the right composer.
 *
 * EXCEPTION: pass `forceReload: true` to skip the "already there" shortcut and
 * force a page refresh regardless. Used to recover from a DeepSeek
 * "Messages too frequent" throttle — the blocked page needs a reload to clear
 * before it can accept messages again, even though the URL is unchanged.
 */
async function navigateDeepSeekChat(
	cdp: CdpClient,
	cdpSessionId: string,
	target: { sessionId?: string; fresh: boolean },
	logger?: BasicLogger,
	forceReload = false,
): Promise<void> {
	const destination = target.fresh
		? DEEPSEEK_WEB_URL
		: target.sessionId
			? `https://chat.deepseek.com/a/chat/s/${target.sessionId}`
			: DEEPSEEK_WEB_URL;

	// Read the current location first; if we're already on the destination, skip
	// the navigation entirely (no page reload) — unless we are recovering from a
	// throttle, which requires a real reload to clear the blocked page.
	const currentUrl = (await readPageUrl(cdp, cdpSessionId)) || "";
	const alreadyThere = isSameChatLocation(currentUrl, destination);
	const reloadAnyway = forceReload;

	if (alreadyThere && !reloadAnyway) {
		if (logger) {
			logger.debug(
				`[deepseek-web-v2] already on ${destination} — skipping navigation (no reload)`,
			);
		}
		// Still perform the defensive "new chat" click for a fresh composer so we
		// don't accidentally type into a previously opened conversation, but only
		// when the composer is empty (no navigation / no reload is triggered).
		if (target.fresh) {
			await cdp.send(
				"Runtime.evaluate",
				{
					expression: `(() => {
						const ta = document.querySelector('textarea[name="search"]');
						if (ta && !ta.value) {
							const clickTargets = [
								'input[placeholder*="new chat" i]',
								'button[aria-label*="New chat" i]',
								'.ds-icon-button[aria-label*="chat" i]',
								'[data-testid*="new-chat" i]',
							];
							for (const sel of clickTargets) {
								const el = document.querySelector(sel);
								if (el) { el.click(); return true; }
							}
						}
						return false;
					})()`,
					returnByValue: true,
				},
				cdpSessionId,
			);
		}
		await sleep(300);
		return;
	}

	if (logger) {
		logger.debug(
			`[deepseek-web-v2] ${target.fresh ? "opening a new DeepSeek chat" : `loading DeepSeek chat ${target.sessionId}`}`,
		);
	}
	await cdp.send(
		"Runtime.evaluate",
		{
			expression: `(() => { window.location.href = ${JSON.stringify(
				destination,
			)}; })()`,
			returnByValue: true,
		},
		cdpSessionId,
	);
	// For a brand-new chat, navigate to the base URL *and* click DeepSeek's
	// "New chat" control so we don't accidentally keep typing into the most
	// recently opened conversation. Kept defensive: if the selector changes,
	// sending into whatever composer is shown still works.
	if (target.fresh) {
		await cdp.send(
			"Runtime.evaluate",
			{
				expression: `(() => {
					const ta = document.querySelector('textarea[name="search"]');
					if (ta && !ta.value) {
						const clickTargets = [
							'input[placeholder*="new chat" i]',
							'button[aria-label*="New chat" i]',
							'.ds-icon-button[aria-label*="chat" i]',
							'[data-testid*="new-chat" i]',
						];
						for (const sel of clickTargets) {
							const el = document.querySelector(sel);
							if (el) { el.click(); return true; }
						}
					}
					return false;
				})()`,
				returnByValue: true,
			},
			cdpSessionId,
		);
	}
	// Give the SPA time to route to the target chat and hydrate before the
	// generic `waitForComposerReady` poll below confirms the composer is usable.
	await sleep(1500);
}

/**
 * Wait until chat.deepseek.com is FULLY loaded and logged in before sending:
 * document readyState complete, the composer textarea visible + enabled, AND
 * the send button rendered (SPA fully hydrated). Then a short settle delay so
 * no request races a still-initializing page. On first run the user has to log
 * in in the Chrome window, so this polls for up to `loginTimeoutMs` and
 * surfaces a hint instead of racing the page load.
 */
async function waitForComposerReady(
	cdp: CdpClient,
	sessionId: string,
	config: DeepSeekWebV2RuntimeConfig,
	logger?: BasicLogger,
): Promise<void> {
	const debugLog = (message: string): void => {
		if (config.debug) logger?.debug(`[deepseek-web-v2] ${message}`);
	};
	const pageFullyLoaded = `(() => {
		if (document.readyState !== 'complete') return false;
		const ta = document.querySelector('textarea[name="search"]');
		if (!ta || ta.disabled) return false;
		const s = window.getComputedStyle(ta);
		if (s.display === 'none' || s.visibility === 'hidden') return false;
		const hasSend =
			!!document.querySelector('.ds-button--filled') ||
			!!document.querySelector('.ds-button__icon svg[viewBox="0 0 16 16"]');
		return hasSend;
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
			// The page may be mid-navigation (e.g. the login redirect) — keep waiting.
		}
		if (ready) {
			debugLog("page fully loaded + logged in — sending prompt");
			// Let hydration/network settle before typing.
			await sleep(1500);
			return;
		}
		if (!hintLogged) {
			hintLogged = true;
			logger?.log(
				"DeepSeek Web v2: waiting for the chat.deepseek.com page to finish loading " +
					`(up to ${Math.round(config.loginTimeoutMs / 1000)}s). If the Chrome window shows a login page, log in now.`,
				{ severity: "info", providerId: "deepseek-web-v2" },
			);
		}
		if (Date.now() >= deadline) {
			throw new Error(
				"DeepSeek Web v2: chat.deepseek.com did not finish loading within " +
					`${Math.round(config.loginTimeoutMs / 1000)}s. If the Chrome window shows a login page, log in to ` +
					"chat.deepseek.com once — the session persists in the profile. If it shows a rate-limit or " +
					"CAPTCHA page, resolve it and try again.",
			);
		}
		await sleep(500);
	}
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(
				new Error(
					`DeepSeek Web v2 timed out after ${Math.round(timeoutMs / 1000)}s waiting for a chat/completion response. ` +
						"Check that chat.deepseek.com is logged in and not rate-limited in the browser profile.",
				),
			);
		}, timeoutMs);
		const abort = () => reject(new DOMException("Aborted", "AbortError"));
		if (signal) {
			if (signal.aborted) {
				clearTimeout(timer);
				reject(new DOMException("Aborted", "AbortError"));
				return;
			}
			signal.addEventListener("abort", abort, { once: true });
		}
		promise.then(
			(value) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				reject(err);
			},
		);
	});
}

// ── Completion capture (Network domain — mirrors browser.py page.on("response")) ─

/**
 * Send `prompt` through the real chat.deepseek.com UI and stream the
 * `chat/completion` SSE body back through `onText` / `onReasoning`.
 *
 * The response is observed with the CDP Network domain, exactly like
 * `browser.py`'s `page.on("response")` listener: the request is NOT paused or
 * interfered with, and the body is only read after `Network.loadingFinished`
 * confirms it is fully written (`Network.getResponseBody`).
 */
async function streamCompletionFromPage(input: {
	cdp: CdpClient;
	sessionId: string;
	config: DeepSeekWebV2RuntimeConfig;
	prompt: string;
	modelType: string;
	deepThinking: boolean | null;
	thinkingEnabled: boolean;
	/**
	 * `true` when this turn is expected to request tool calls. Tool turns are
	 * the most rapid-fire pattern in an agent run, so they get an extra
	 * randomized delay before sending to dodge DeepSeek's frequency throttle.
	 */
	isToolTurn: boolean;
	onText?: (text: string) => void;
	onReasoning?: (text: string) => void;
	signal?: AbortSignal;
	logger?: BasicLogger;
}): Promise<{
	text: string;
	reasoning: string;
	accumulatedTokenUsage?: number;
	rateLimited?: boolean;
}> {
	const {
		cdp,
		sessionId,
		config,
		prompt,
		modelType,
		deepThinking,
		thinkingEnabled,
		isToolTurn,
		onText,
		onReasoning,
		signal,
		logger,
	} = input;

	const debugLog = (message: string): void => {
		if (config.debug) logger?.debug(`[deepseek-web-v2] ${message}`);
	};

	const sink = createPushSink();
	const sseDone = consumeDeepSeekSse(
		sink.stream,
		onText,
		onReasoning,
		thinkingEnabled,
	);

	let result: {
		text: string;
		reasoning: string;
		accumulatedTokenUsage?: number;
		rateLimited?: boolean;
	} = { text: "", reasoning: "" };
	// Request id of the chat/completion response, set when headers arrive.
	let completionRequestId: string | undefined;

	// Observe the completion response like browser.py's page.on("response") —
	// the Network domain watches without pausing the request, and the body is
	// only read after `loadingFinished` confirms it is fully written.
	cdp.on("Network.responseReceived", (event: any) => {
		const url: string = event.response?.url ?? "";
		if (!url.includes("chat/completion")) return;
		if (event.response?.status !== 200) return;
		completionRequestId = event.requestId;
		debugLog(`completion response received (${url})`);
	});
	cdp.on("Network.loadingFinished", async (event: any) => {
		if (event.requestId !== completionRequestId) return;
		debugLog("completion body fully written — reading it");
		try {
			const { body, base64Encoded } = await cdp.send(
				"Network.getResponseBody",
				{ requestId: event.requestId },
				sessionId,
			);
			sink.push(
				base64Encoded
					? Buffer.from(body, "base64")
					: new TextEncoder().encode(body),
			);
			sink.close();
			debugLog(`completion body captured (${body.length} chars)`);
		} catch (err) {
			sink.error(err);
		}
	});

	try {
		await cdp.send("Network.enable", {}, sessionId);

		if (signal?.aborted) {
			throw new DOMException("Aborted", "AbortError");
		}

		// Randomized human-like pacing — the fix for DeepSeek's "Messages too
		// frequent" throttle. Wait a random `[min,max]` before firing, plus an
		// extra random amount on tool-request turns (the fastest back-to-back
		// pattern). Simply sleeping a fixed amount still looks machine-gunned.
		const sendDelay = computeSendDelay(config, { isToolTurn });
		debugLog(
			`pacing: waiting ${sendDelay}ms before send (toolTurn=${String(isToolTurn)})`,
		);
		await sleep(sendDelay);

		debugLog(
			`sending prompt (${prompt.length} chars, model=${modelType}, deepThinking=${String(deepThinking)})`,
		);
		// Fire-and-forget page script (mirrors the reference sendmessage.js) —
		// typing and the send click happen in setTimeout callbacks after this
		// evaluate returns, so we verify from the Node side below.
		await cdp.send(
			"Runtime.evaluate",
			{
				expression: buildSendScript(prompt, { modelType, deepThinking }),
				returnByValue: true,
				awaitPromise: true,
			},
			sessionId,
		);

		// The reference script types the message and the composer clears on
		// submit. Poll the DOM (without touching the page's React state) until
		// the prompt appears — that is the definitive "typed" signal, and it
		// turns the silent 120s hang into a clear error when it never happens.
		const readValue = `(document.querySelector('textarea[name="search"]')?.value ?? '')`;
		let sawTyped = false;
		const typedDeadline = Date.now() + 10_000;
		while (Date.now() < typedDeadline) {
			const r = await cdp.send(
				"Runtime.evaluate",
				{ expression: readValue, returnByValue: true },
				sessionId,
			);
			const value: string = r.result?.value ?? "";
			if (value === prompt) sawTyped = true;
			if (sawTyped && value === "") break; // typed, then submitted (cleared)
			await sleep(100);
		}
		if (!sawTyped) {
			throw new Error(
				"DeepSeek Web v2: the message was not typed into the composer within 10s. " +
					"If the Chrome window is showing a login, rate-limit or CAPTCHA page, resolve it and retry.",
			);
		}
		debugLog("prompt typed into the composer");

		result = await withTimeout(sseDone, config.responseTimeoutMs, signal);
		// Flag a throttled reply so the caller can back off / report it instead
		// of treating a shorter-context completion as a real context reset. Also
		// arm a one-shot recovery reload so the next turn forces a page refresh
		// to clear the temporarily-blocked composer ("Messages too frequent").
		if (isRateLimitText(result.text)) {
			result.rateLimited = true;
			requestThrottleRecoveryReload();
			logger?.log?.(
				'[deepseek-web-v2] DeepSeek throttled the request: "Messages too frequent" detected. ' +
					"Next message will reload the page to recover, and sending is paced. " +
					"Consider raising DEEPSEEK_WEB_V2_MIN/MAX_SEND_DELAY_MS.",
			);
		}
		debugLog(
			`completion done: ${result.text.length} chars text, ${result.reasoning.length} chars reasoning` +
				(result.accumulatedTokenUsage !== undefined
					? `, accumulated token usage=${result.accumulatedTokenUsage}`
					: ""),
		);
	} finally {
		await cdp.send("Network.disable", {}, sessionId).catch(() => {});
		sink.close();
	}

	return result;
}

async function runCompletion(input: {
	modelId: string;
	prompt: string;
	chatKey: string;
	/** `true` when this turn requests tool calls → extra pacing delay. */
	isToolTurn: boolean;
	onText?: (text: string) => void;
	onReasoning?: (text: string) => void;
	signal?: AbortSignal;
	logger?: BasicLogger;
}): Promise<{
	text: string;
	reasoning: string;
	accumulatedTokenUsage?: number;
	rateLimited?: boolean;
}> {
	const {
		modelId,
		prompt,
		chatKey,
		isToolTurn,
		onText,
		onReasoning,
		signal,
		logger,
	} = input;
	const config = resolveDeepSeekWebV2Config();
	const { modelType, deepThinking } = resolveV2ModelOptions(modelId);

	if (signal?.aborted) {
		throw new DOMException("Aborted", "AbortError");
	}

	const cdp = await connectBrowser(config);
	const { sessionId } = await ensureDeepSeekPage(cdp);

	// Persist chat continuity (mirror start_continue_chat.py): a CLI conversation
	// that already has a mapped DeepSeek web chat reopens that chat; a brand-new
	// CLI conversation opens a fresh DeepSeek composer.
	//
	// If the previous turn was throttled ("Messages too frequent"), the page may
	// be temporarily blocked — force a real reload this once (consume the
	// flag) so the blocked page clears and the composer works normally again,
	// even if the URL already matches the target chat.
	const existingDeepSeekSession = lookupChatSession(config.chatsFile, chatKey);
	const forceReload = consumeThrottleRecoveryReload();
	if (existingDeepSeekSession) {
		await navigateDeepSeekChat(
			cdp,
			sessionId,
			{
				sessionId: existingDeepSeekSession,
				fresh: false,
			},
			logger,
			forceReload,
		);
	} else {
		await navigateDeepSeekChat(
			cdp,
			sessionId,
			{ fresh: true },
			logger,
			forceReload,
		);
	}

	await waitForComposerReady(cdp, sessionId, config, logger);

	const result = await streamCompletionFromPage({
		cdp,
		sessionId,
		config,
		prompt,
		modelType,
		deepThinking,
		thinkingEnabled: deepThinking === true,
		isToolTurn,
		onText,
		onReasoning,
		signal,
		logger,
	});

	// After sending, the SPA routes to `/a/chat/s/<session_id>`; capture it so
	// the next turn (or a resume) can reopen this same DeepSeek chat.
	const pageUrl = await readPageUrl(cdp, sessionId);
	const deepSeekSession = parseSessionIdFromUrl(pageUrl);
	if (deepSeekSession) {
		recordChatSession(config.chatsFile, chatKey, deepSeekSession);
		if (config.debug) {
			logger?.debug(
				`[deepseek-web-v2] mapped CLI chat ${chatKey} -> DeepSeek session ${deepSeekSession}`,
			);
		}
	}

	return result;
}

// ── LanguageModelV2 adapter ─────────────────────────────────────────────────

interface ParsedToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

/** File extension for a markdown code-fence language tag. */
function extensionForLanguage(lang?: string): string {
	const map: Record<string, string> = {
		python: ".py",
		py: ".py",
		javascript: ".js",
		js: ".js",
		jsx: ".jsx",
		typescript: ".ts",
		ts: ".ts",
		tsx: ".tsx",
		bash: ".sh",
		sh: ".sh",
		shell: ".sh",
		powershell: ".ps1",
		ps1: ".ps1",
		json: ".json",
		yaml: ".yaml",
		yml: ".yaml",
		markdown: ".md",
		md: ".md",
		html: ".html",
		css: ".css",
		go: ".go",
		rust: ".rs",
		rs: ".rs",
		java: ".java",
		c: ".c",
		cpp: ".cpp",
		csharp: ".cs",
		cs: ".cs",
		ruby: ".rb",
		rb: ".rb",
		php: ".php",
		sql: ".sql",
		text: ".txt",
	};
	return map[lang ?? ""] ?? ".txt";
}

/** Best-effort filename for a code block, from nearby text, the prompt, or a generated name. */
function inferFileName(
	fullText: string,
	blockIndex: number,
	prompt: string,
	lang: string,
	index: number,
): string {
	const namePattern =
		/\b([\w-]+\.(?:py|js|ts|tsx|jsx|sh|ps1|json|ya?ml|md|txt|html|css|go|rs|java|c|cpp|cs|rb|php|sql))\b/i;
	// Search a window around the block ("save it as x.py" usually follows it).
	const around = fullText.slice(
		Math.max(0, blockIndex - 200),
		blockIndex + 300,
	);
	const inReply = namePattern.exec(around);
	if (inReply) return inReply[1];
	const inPrompt = namePattern.exec(prompt);
	if (inPrompt) return inPrompt[1];
	return `output_${index + 1}${extensionForLanguage(lang)}`;
}

/** The text of the last user message in the prompt, for filename hints. */
function lastUserText(prompt: LanguageModelV2Prompt): string {
	for (let i = prompt.length - 1; i >= 0; i--) {
		const message = prompt[i];
		if (message.role !== "user") continue;
		const parts = message.content as Array<{ type?: string; text?: string }>;
		return parts
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n")
			.trim();
	}
	return "";
}

/**
 * Fallback when the web model ignored the `<tool>` contract and answered with
 * plain text (a plan, code fences, install commands). Convert the visible
 * structure of the reply into real tool calls the agent can execute:
 *
 *  - markdown code fences      → `editor` (create the file with that content)
 *  - `pip install ...` lines   → `run_commands`
 *
 * Only emits calls for tools that are actually available, and strips the
 * converted code fences from the visible text so the file content isn't shown
 * twice.
 */
export function parseFallbackToolUses(
	text: string,
	prompt: string,
	availableToolNames: string[],
): { cleanedText: string; toolUses: ParsedToolCall[] } {
	const toolUses: ParsedToolCall[] = [];
	const hasEditor = availableToolNames.includes("editor");
	const hasRunCommands = availableToolNames.includes("run_commands");

	// `pip install ...` (and similar) → run_commands
	if (hasRunCommands) {
		const installPattern =
			/(?:^|\n)\s*(?:pip|pip3|python\s+-m\s+pip)\s+install\s+[^\n]+/gi;
		const installs = [...text.matchAll(installPattern)].map((m) =>
			m[0].replace(/^\s*\n/, "").trim(),
		);
		if (installs.length > 0) {
			toolUses.push({
				name: "run_commands",
				arguments: { commands: installs },
			});
		}
	}

	// markdown code fences → editor (create file)
	if (hasEditor) {
		const fencePattern = /```([\w+-]*)\s*\n([\s\S]*?)```/g;
		let index = 0;
		for (;;) {
			const match = fencePattern.exec(text);
			if (match === null) break;
			const lang = (match[1] ?? "").toLowerCase();
			const code = match[2].replace(/\s+$/, "");
			if (!code.trim()) {
				index++;
				continue;
			}
			const filename = inferFileName(text, match.index, prompt, lang, index);
			toolUses.push({
				name: "editor",
				arguments: { path: filename, new_text: code },
			});
			index++;
		}
	}

	let cleanedText = text;
	if (hasEditor) {
		cleanedText = cleanedText.replace(
			/```[\w+-]*\s*\n[\s\S]*?```/g,
			"[code saved to a file]",
		);
	}

	return { cleanedText: cleanedText.trim(), toolUses };
}

/**
 * The prefix of the auto-generated context-compaction summary user message
 * (see `buildSummaryMessage` in compacton-shared.ts). After a manual `/compact`
 * or an auto-compaction, this message becomes the first user message of the
 * working context and must NOT be dropped by the lean-conversation trimmer,
 * otherwise the fresh DeepSeek web chat would lose all prior conversation
 * context.
 *
 * Note: `metadata.kind === "compaction_summary"` does NOT survive the runtime's
 * message formatting (it is stripped before the prompt reaches the provider),
 * so the leading user message's text is the reliable signal available here.
 */
const COMPACTION_SUMMARY_PREFIX = "Context summary:";

/**
 * True when the leading user message is the auto-generated context-compaction
 * summary (its text opens with `COMPACTION_SUMMARY_PREFIX`). This identifies a
 * compaction-transition turn, where the DeepSeek web chat was reopened/refreshed
 * and must be re-seeded with the compacted context.
 */
function hasLeadingCompactionSummary(prompt: LanguageModelV2Prompt): boolean {
	for (const message of prompt) {
		if (message.role !== "user") continue;
		// The compaction summary is the FIRST user message. Return based on its
		// text; do not keep scanning for a later user message.
		const content = Array.isArray(message.content)
			? message.content
					.map((block) => ("text" in block ? block.text : ""))
					.join("\n")
			: message.content;
		return (
			typeof content === "string" &&
			content.trim().startsWith(COMPACTION_SUMMARY_PREFIX)
		);
	}
	return false;
}

/**
 * Trim the prompt for the DeepSeek web chat. The real web client keeps its own
 * server-side conversation state, so re-sending the full transcript every turn
 * is redundant and causes the model to echo back its own prior output.
 *
 * Behavior:
 *  - First turn (`[system, user]` and nothing else) is sent verbatim so the
 *    model receives the system prompt exactly once.
 *  - Every follow-up turn drops the system prompt, all prior assistant/user
 *    messages, and keeps ONLY:
 *      * the most recent user message (the current prompt), and
 *      * any `tool` result messages that come after that user message (the
 *        results of the agent's latest tool calls).
 *  - Compaction-transition turns are special-cased: when a `compaction_summary`
 *    user message leads the prompt, that summary is retained as the leading
 *    context so the fresh DeepSeek web chat (which has no prior server-side
 *    state) is re-seeded with what was compacted. The summary is kept alongside
 *    the current user prompt and any trailing tool results.
 */
function buildLeanConversation(
	prompt: LanguageModelV2Prompt,
	preserveCompactionContext = false,
): LanguageModelV2Prompt {
	const nonSystem = prompt.filter((m) => m.role !== "system");

	// A first turn is exactly a single user message (with no other roles).
	const isFirstTurn = nonSystem.length === 1 && nonSystem[0].role === "user";
	if (isFirstTurn) return prompt;

	// Find the index of the last user message.
	let lastUserIndex = -1;
	for (let i = nonSystem.length - 1; i >= 0; i--) {
		if (nonSystem[i].role === "user") {
			lastUserIndex = i;
			break;
		}
	}

	// Compaction-transition turn: a fresh DeepSeek web chat is about to be
	// opened (it has no prior server-side state), so the compaction summary
	// must be carried over as leading context to seed the new chat with what
	// was compacted. The summary is the FIRST user message; keep it in front of
	// the current prompt. On later turns the web chat already holds the summary
	// server-side, so `preserveCompactionContext` is false and it is dropped.
	const firstUserIndex = nonSystem.findIndex((m) => m.role === "user");
	const hasCompactionSummary =
		preserveCompactionContext &&
		firstUserIndex >= 0 &&
		hasLeadingCompactionSummary(nonSystem);

	// Keep the last user message plus every tool result after it.
	const kept: LanguageModelV2Prompt = [];
	if (hasCompactionSummary && lastUserIndex > firstUserIndex) {
		kept.push(nonSystem[firstUserIndex]);
	}
	if (lastUserIndex >= 0) kept.push(nonSystem[lastUserIndex]);
	for (let i = lastUserIndex + 1; i < nonSystem.length; i++) {
		if (nonSystem[i].role === "tool") kept.push(nonSystem[i]);
	}

	// Fallback (no user message at all): keep only trailing tool results.
	if (kept.length === 0) {
		for (let i = nonSystem.length - 1; i >= 0; i--) {
			if (nonSystem[i].role === "tool") {
				kept.unshift(nonSystem[i]);
			} else {
				break;
			}
		}
	}

	return kept;
}

/**
 * Context-token thresholds (as reported by DeepSeek's `accumulated_token_usage`)
 * at which the system prompt is re-injected on the next turn, so the model
 * doesn't forget the `<tool>` protocol and real tool names over a long session.
 */
const SYSTEM_REINJECT_THRESHOLDS = [200_000, 500_000, 700_000];

/**
 * Build the flat prompt sent to the web chat.
 *
 * The runtime-composed system prompt (sdk/packages/shared/src/prompt/system.ts)
 * already contains the `<tool>` calling protocol and the available tool list,
 * so no separate tool-contract block is prepended — the chat shows exactly the
 * system prompt + conversation.
 *
 * The system prompt is sent on the first turn, dropped on follow-up turns
 * (the web client keeps its own server-side state, so re-sending the full
 * transcript causes echo), but re-injected whenever the accumulated context
 * passed a `SYSTEM_REINJECT_THRESHOLDS` level in the previous turn.
 */
export function buildPrompt(
	prompt: LanguageModelV2Prompt,
	_tools: LanguageModelV2FunctionTool[] | undefined,
	reInjectSystem = false,
	preserveCompactionContext = false,
): string {
	const conversation = buildLeanConversation(prompt, preserveCompactionContext);
	const systemMessage = prompt.find((m) => m.role === "system");
	// Avoid doubling the system prompt: on a first turn the lean conversation
	// already carries it, so only prepend it again for follow-up turns (where
	// `buildLeanConversation` strips it) — e.g. after a compaction opens a fresh
	// DeepSeek chat or a re-inject threshold is crossed.
	const alreadyHasSystem = conversation.some((m) => m.role === "system");
	if (
		reInjectSystem &&
		systemMessage &&
		!alreadyHasSystem &&
		conversation.length > 0
	) {
		return messagesToPrompt([systemMessage, ...conversation]);
	}
	return messagesToPrompt(conversation);
}

function finishReasonFor(
	text: string,
	toolCalls: ParsedToolCall[],
): LanguageModelV2FinishReason {
	return toolCalls.length > 0 ? "tool-calls" : text ? "stop" : "unknown";
}

function createDeepSeekWebV2Model(
	modelId: string,
	logger?: BasicLogger,
): LanguageModelV2 {
	// Tracks the last reported accumulated context tokens so a threshold cross
	// re-injects the system prompt on the next turn.
	let lastAccumulatedTokenUsage: number | undefined;
	// Highest threshold already re-injected, so each threshold fires once.
	let reinjectedThroughThreshold = 0;

	const doCompletion = async (
		options: LanguageModelV2CallOptions,
		onText?: (text: string) => void,
		onReasoning?: (text: string) => void,
	): Promise<{
		text: string;
		reasoning: string;
		toolCalls: ParsedToolCall[];
		usage: DeepSeekWebUsageEstimate;
	}> => {
		const functionTools = (options.tools ?? []).filter(
			(tool): tool is LanguageModelV2FunctionTool => tool.type === "function",
		);
		// The CLI conversation is keyed by its first user message. A fresh key
		// (no mapped DeepSeek chat yet) means this call opens a brand-new web
		// chat — e.g. right after a compaction, where the newly-generated
		// `compaction_summary` becomes the first user message and the compacted
		// context moves into a fresh DeepSeek chat.
		const chatKey = chatKeyFromPrompt(options.prompt);
		const isNewChat =
			lookupChatSession(resolveDeepSeekWebV2Config().chatsFile, chatKey) ===
			undefined;
		// Re-inject the system prompt exactly once per threshold cross (e.g.
		// ~200k, ~500k, ~700k accumulated context), so the model re-learns the
		// <tool> protocol and real tool names without hammering every turn.
		// A brand-new chat also re-injects it, because a fresh DeepSeek chat has
		// no prior context and must be re-taught the tool contract.
		const toReinject = SYSTEM_REINJECT_THRESHOLDS.find(
			(threshold) =>
				(lastAccumulatedTokenUsage ?? 0) >= threshold &&
				threshold > reinjectedThroughThreshold,
		);
		const shouldReinject = toReinject !== undefined || isNewChat;
		const prompt = buildPrompt(
			options.prompt,
			functionTools,
			shouldReinject,
			// Preserve the compaction summary only when this call opens the fresh
			// DeepSeek web chat (the first turn after /compact). On later turns the
			// new chat already holds the summary in its server-side conversation
			// state, so it must not be re-sent.
			isNewChat,
		);
		const { text, reasoning, accumulatedTokenUsage, rateLimited } =
			await runCompletion({
				modelId,
				prompt,
				chatKey,
				// This turn requests tool calls when function tools are wired up —
				// so it is exactly the rapid-fire pattern that needs extra pacing.
				isToolTurn: functionTools.length > 0,
				onText,
				onReasoning,
				signal: options.abortSignal,
				logger,
			});
		// Track the context strictly monotonically. DeepSeek's reported
		// `accumulated_token_usage` can DROP when it rejects/rolls back a
		// rate-limited message (the user-visible "tokens reset to lower"). If we
		// blindly record that lower value we'd lose the system-prompt
		// re-injection thresholds and under-report context. Only ever move
		// forward; a new chat (fresh key, no history) legitimately restarts.
		if (accumulatedTokenUsage !== undefined) {
			if (
				lastAccumulatedTokenUsage === undefined ||
				accumulatedTokenUsage > lastAccumulatedTokenUsage ||
				isNewChat
			) {
				lastAccumulatedTokenUsage = accumulatedTokenUsage;
			} else if (rateLimited) {
				logger?.debug?.(
					`[deepseek-web-v2] ignoring lower accumulated_token_usage ${accumulatedTokenUsage} (kept ${lastAccumulatedTokenUsage}) — likely a post-rate-limit rollback`,
				);
			}
		}
		if (toReinject !== undefined && toReinject > reinjectedThroughThreshold) {
			reinjectedThroughThreshold = toReinject;
		}

		// When DeepSeek reports the real cumulative context-token count for this
		// conversation, prefer it over the heuristic; otherwise fall back to the
		// chars/3 estimate. `accumulated_token_usage` is the total input context,
		// so it maps to `inputTokens` and `totalTokens` = input + this turn's output.
		const estimated = estimateDeepSeekWebUsage(prompt, `${text}${reasoning}`);
		const usage: DeepSeekWebUsageEstimate =
			accumulatedTokenUsage !== undefined
				? {
						inputTokens: accumulatedTokenUsage,
						outputTokens: estimated.outputTokens,
						totalTokens: accumulatedTokenUsage + estimated.outputTokens,
					}
				: estimated;

		if (functionTools.length > 0) {
			const toolNames = functionTools.map((t) => t.name);
			const { cleanedContent, toolCalls } = parseDeepSeekToolCalls(
				text,
				toolNames,
			);
			// The web model often ignores the <tool> contract and answers with
			// plain text (a plan, code fences, install commands). If no
			// structured call came back, convert the visible reply into real
			// tool calls so the agent actually executes them.
			if (toolCalls.length === 0) {
				const fallback = parseFallbackToolUses(
					cleanedContent,
					lastUserText(options.prompt),
					toolNames,
				);
				return {
					text: fallback.cleanedText,
					reasoning,
					toolCalls: fallback.toolUses,
					usage,
				};
			}

			// Python-validation gate: drop any editor call with malformed
			// `new_text` and route a precise retry prompt back to the model so it
			// re-emits a corrected <tool> block instead of executing bad code.
			const { tools: validated, retryPrompt } = validateToolCalls(toolCalls);
			const routedText = retryPrompt
				? `${cleanedContent}\n\n${retryPrompt}`.trim()
				: cleanedContent;
			return { text: routedText, reasoning, toolCalls: validated, usage };
		}
		return { text, reasoning, toolCalls: [], usage };
	};

	return {
		specificationVersion: "v2",
		provider: "deepseek-web-v2",
		modelId,
		supportedUrls: {},
		doGenerate: async (options) => {
			const { text, reasoning, toolCalls, usage } = await doCompletion(options);
			const content: Array<
				| { type: "text"; text: string }
				| { type: "reasoning"; text: string }
				| {
						type: "tool-call";
						toolCallId: string;
						toolName: string;
						input: string;
				  }
			> = [];
			if (reasoning) content.push({ type: "reasoning", text: reasoning });
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
				usage: {
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					totalTokens: usage.totalTokens,
				},
				warnings: [],
			};
		},
		doStream: async (options) => {
			const id = `deepseek-web-v2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const textChunks: string[] = [];
			const reasoningChunks: string[] = [];
			const functionTools = (options.tools ?? []).filter(
				(tool): tool is LanguageModelV2FunctionTool => tool.type === "function",
			);

			// The web client has no per-token tool streaming; buffer the reply so
			// `<tool>` blocks can be parsed and stripped before emitting.
			const completion = await doCompletion(
				options,
				(t) => textChunks.push(t),
				(r) => reasoningChunks.push(r),
			);

			const reasoningText = reasoningChunks.join("");
			const rawText = textChunks.join("");
			const { cleanedContent, toolCalls } =
				functionTools.length > 0
					? parseDeepSeekToolCalls(
							rawText,
							functionTools.map((t) => t.name),
						)
					: { cleanedContent: rawText, toolCalls: [] };

			// Python-validation gate (same as doCompletion's non-streaming path):
			// drop editor calls with malformed `new_text` and surface the retry
			// prompt as text so the correction feeds back to the model instead of
			// executing bad code.
			const { tools: validatedCalls, retryPrompt } =
				validateToolCalls(toolCalls);
			const displayText = retryPrompt
				? `${cleanedContent}\n\n${retryPrompt}`.trim()
				: cleanedContent;

			const parts: LanguageModelV2StreamPart[] = [
				{ type: "stream-start", warnings: [] },
				{ type: "response-metadata", id },
			];
			if (reasoningText) {
				parts.push({ type: "reasoning-start", id });
				parts.push({ type: "reasoning-delta", id, delta: reasoningText });
				parts.push({ type: "reasoning-end", id });
			}
			if (displayText) {
				parts.push({ type: "text-start", id });
				parts.push({ type: "text-delta", id, delta: displayText });
				parts.push({ type: "text-end", id });
			}
			for (let i = 0; i < validatedCalls.length; i++) {
				const input = JSON.stringify(validatedCalls[i].arguments);
				parts.push({
					type: "tool-input-start",
					id,
					toolName: validatedCalls[i].name,
				});
				parts.push({ type: "tool-input-delta", id, delta: input });
				parts.push({ type: "tool-input-end", id });
				parts.push({
					type: "tool-call",
					toolCallId: `call-${Date.now()}-${i}`,
					toolName: validatedCalls[i].name,
					input,
				});
			}
			parts.push({
				type: "finish",
				finishReason: finishReasonFor(displayText, validatedCalls),
				usage: {
					inputTokens: completion.usage.inputTokens,
					outputTokens: completion.usage.outputTokens,
					totalTokens: completion.usage.totalTokens,
				},
			});

			let index = 0;
			const stream = new ReadableStream<LanguageModelV2StreamPart>({
				pull(controller) {
					if (index < parts.length) {
						controller.enqueue(parts[index++]);
						return;
					}
					controller.close();
				},
				cancel() {
					index = parts.length;
				},
			});

			return { stream, warnings: [] };
		},
	};
}

export function createDeepSeekWebV2ProviderModule(
	_config: GatewayResolvedProviderConfig,
	context: GatewayProviderContext,
): ProviderFactoryResult {
	return {
		model: (modelId) => createDeepSeekWebV2Model(modelId, context.logger),
	};
}
