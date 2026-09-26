import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BasicLogger } from "@cline/shared";
import { claimBrowserPort } from "../tool-pipeline/browser-claims";
import {
	browserNotFoundMessage,
	findChromePath,
} from "../tool-pipeline/browser-path";
import { registerLaunchedBrowser } from "../tool-pipeline/browser-processes";
import { retryOnMissingExecutionContext } from "../tool-pipeline/cdp-execution-context";
import { getPooledCdp, setPooledCdp } from "../tool-pipeline/cdp-pool";
import {
	CONFIG_DIR,
	DEEPSEEK_WEB_URL,
	type DeepSeekWebV2RuntimeConfig,
	sleep,
} from "./config";

// ── Browser session (raw CDP over WebSocket) ───────────────────────────────

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
/**
 * A CDP request parameter set or reply payload.
 *
 * Shaped by the Chrome DevTools Protocol, not by us: `send("Target.getTargets")`
 * returns something quite different from `send("Runtime.evaluate")`, and every
 * caller narrows the result itself at the point of use. One alias with one
 * suppression, rather than the same escape hatch repeated at ten signatures.
 */
// biome-ignore lint/suspicious/noExplicitAny: CDP payloads are protocol-shaped, narrowed per call site.
type CdpPayload = any;

export class CdpClient {
	private ws: WebSocket;
	private id = 0;
	private pending = new Map<
		number,
		{ resolve: (v: CdpPayload) => void; reject: (e: Error) => void }
	>();
	private listeners = new Map<
		string,
		Set<(params: CdpPayload, sessionId?: string) => void>
	>();

	constructor(wsUrl: string) {
		this.ws = new WebSocket(wsUrl);
		this.ws.addEventListener("message", (event) => {
			const msg = JSON.parse(event.data as string);
			const p = msg.id ? this.pending.get(msg.id) : undefined;
			if (p) {
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

	// Wrapped so a page that is mid-navigation — no execution context yet —
	// waits the moment out instead of failing the turn with nothing typed.
	// See tool-pipeline/cdp-execution-context.ts.
	send(
		method: string,
		params: CdpPayload = {},
		sessionId?: string,
	): Promise<CdpPayload> {
		return retryOnMissingExecutionContext(
			method,
			() => this.sendOnce(method, params, sessionId),
			sleep,
			"deepseek-web-v2",
		);
	}

	private sendOnce(
		method: string,
		params: CdpPayload = {},
		sessionId?: string,
	): Promise<CdpPayload> {
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

	on(
		method: string,
		cb: (params: CdpPayload, sessionId?: string) => void,
	): void {
		if (!this.listeners.has(method)) this.listeners.set(method, new Set());
		this.listeners.get(method)?.add(cb);
	}

	off(
		method: string,
		cb: (params: CdpPayload, sessionId?: string) => void,
	): void {
		this.listeners.get(method)?.delete(cb);
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
export async function connectBrowser(
	config: DeepSeekWebV2RuntimeConfig,
): Promise<CdpClient> {
	// Connections are pooled per port, so two sessions on two profiles each
	// keep their own socket. A single cached slot made them close each
	// other's on every turn. See tool-pipeline/cdp-pool.ts.
	const pooled = getPooledCdp<CdpClient>("deepseek-web-v2", config.debugPort);
	if (pooled) return pooled;

	const connectTimeoutMs = Math.max(config.launchTimeoutMs, 30_000);

	if (await isEndpointUp(config.debugPort)) {
		// Attaching to a browser someone else launched. We do not own it and
		// must never kill it, but the claim tells whoever DOES own it not to
		// close it out from under this session. See browser-claims.ts.
		claimBrowserPort(config.debugPort);
		const cdp = await connectCdp(config.debugPort, connectTimeoutMs);
		setPooledCdp("deepseek-web-v2", config.debugPort, cdp);
		return cdp;
	}

	const executablePath = config.chromePath ?? findChromePath();
	if (!executablePath) {
		throw new Error(
			browserNotFoundMessage(
				"~/.cline/deepseek-web-v2/config.json",
				"DEEPSEEK_WEB_V2_CHROME_PATH",
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
		DEEPSEEK_WEB_URL,
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
			providerId: "deepseek-web-v2",
			pid: child.pid,
			debugPort: config.debugPort,
		});
	}

	try {
		await waitForEndpoint(config.debugPort, config.launchTimeoutMs);
	} catch (err) {
		throw new Error(
			`Failed to launch Chrome for DeepSeek Web v2: ${(err as Error).message}. ` +
				"If Chrome is already running with this profile, close it or set a different DEEPSEEK_WEB_V2_PROFILE_DIR.",
		);
	}

	const cdp = await connectCdp(config.debugPort, connectTimeoutMs);
	setPooledCdp("deepseek-web-v2", config.debugPort, cdp);
	return cdp;
}

/** Attach to the chat.deepseek.com tab, reusing an open one or creating it. */
export async function ensureDeepSeekPage(
	cdp: CdpClient,
): Promise<{ targetId: string; sessionId: string }> {
	const { targetInfos } = await cdp.send("Target.getTargets");
	let target = targetInfos.find(
		(t: CdpPayload) => t.type === "page" && t.url.includes("chat.deepseek.com"),
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
export async function readPageUrl(
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
	// The query string is dropped as well as the fragment: every provider keeps
	// the chat id in the path, and pages add their own parameters after a reply
	// (Grok appends `?rid=<response id>`). Comparing those made every follow-up
	// turn look like a different chat and reloaded the tab each time.
	const normalize = (url: string): string =>
		((url || "").split(/[?#]/)[0] ?? "").replace(/\/+$/, "");
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
export async function navigateDeepSeekChat(
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
	//
	// Retry this check briefly: a call that lands right after the previous
	// turn just finished (e.g. compaction firing immediately after a
	// response, with no human typing delay in between) can race the SPA's
	// client-side router still updating `window.location` to the session
	// URL. A single instantaneous read can catch that in-between state and
	// wrongly conclude we're not there yet, triggering a needless reload —
	// which then requires re-fetching and re-rendering history before the
	// composer is safe to type into. Re-checking a few times avoids that
	// reload path entirely for what is really just the next message in the
	// same, already-open chat.
	let currentUrl = (await readPageUrl(cdp, cdpSessionId)) || "";
	let alreadyThere = isSameChatLocation(currentUrl, destination);
	for (let attempt = 0; !alreadyThere && attempt < 4; attempt += 1) {
		await sleep(150);
		currentUrl = (await readPageUrl(cdp, cdpSessionId)) || "";
		alreadyThere = isSameChatLocation(currentUrl, destination);
	}
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
export async function waitForComposerReady(
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

export async function withTimeout<T>(
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
