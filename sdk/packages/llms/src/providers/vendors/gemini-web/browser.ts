/**
 * Getting a Chrome we can drive, and a Gemini page that is ready to type into.
 *
 * `activeCdp` is deliberately module state: one socket per debug port, reused
 * across turns. `/profile` can change the port between turns, so the key is
 * checked before the cached socket is handed back.
 */

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
import {
	type CdpClient,
	connectCdp as connectCdpForProvider,
	isEndpointUp,
	waitForEndpoint,
} from "../tool-pipeline/cdp-client";
import {
	CONFIG_DIR,
	GEMINI_WEB_URL,
	type GeminiWebV2RuntimeConfig,
	sleep,
} from "./config";

export type { CdpClient };

// ── CDP Client ────────────────────────────────────────────────────────────────

const cdpConnections = new Map<string, CdpClient>();

/**
 * Connect with this provider's name attached.
 *
 * The shared client takes the provider id so a retry logs which vendor it came
 * from; binding it here keeps every call site in this file unchanged.
 * See tool-pipeline/cdp-client.ts.
 */
export function connectCdp(
	port: number,
	timeoutMs: number,
): Promise<CdpClient> {
	return connectCdpForProvider(port, timeoutMs, "gemini-web");
}

export async function connectBrowser(
	config: GeminiWebV2RuntimeConfig,
): Promise<CdpClient> {
	const key = `${config.debugPort}`;
	const existing = cdpConnections.get(key);
	if (existing && existing.isOpen()) {
		return existing;
	}

	const connectTimeoutMs = Math.max(config.launchTimeoutMs, 30000);

	if (await isEndpointUp(config.debugPort)) {
		// Attaching to a browser someone else launched. We do not own it and
		// must never kill it, but the claim tells whoever DOES own it not to
		// close it out from under this session. See browser-claims.ts.
		claimBrowserPort(config.debugPort);
		const cdp = await connectCdp(config.debugPort, connectTimeoutMs);
		cdpConnections.set(key, cdp);
		return cdp;
	}

	const executablePath = config.chromePath ?? findChromePath();
	if (!executablePath) {
		throw new Error(
			browserNotFoundMessage(
				"~/.cline/gemini-web/config.json",
				"GEMINI_WEB_CHROME_PATH",
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
		GEMINI_WEB_URL,
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
			providerId: "gemini-web",
			pid: child.pid,
			debugPort: config.debugPort,
		});
	}

	try {
		await waitForEndpoint(config.debugPort, config.launchTimeoutMs);
	} catch (err) {
		throw new Error(
			`Failed to launch Chrome for Gemini Web: ${(err as Error).message}. ` +
				"If Chrome is already running with this profile, close it or set a different GEMINI_WEB_PROFILE_DIR.",
		);
	}
	const cdp = await connectCdp(config.debugPort, connectTimeoutMs);
	cdpConnections.set(key, cdp);
	return cdp;
}

// ── Composer ready ─────────────────────────────────────────────────────────────

export async function waitForComposerReady(
	cdp: CdpClient,
	sessionId: string,
	config: GeminiWebV2RuntimeConfig,
	logger?: BasicLogger,
): Promise<void> {
	const pageFullyLoaded = `(() => {
        if (document.readyState !== 'complete') return false;
        // Gemini's chat input is a contenteditable div with role textbox
        const editor = document.querySelector('[contenteditable="true"][role="textbox"]') ||
                       document.querySelector('.ql-editor.textarea.new-input-ui') ||
                       document.querySelector('[data-test-id="textarea-inner"] .ql-editor');
        if (editor && editor.offsetWidth > 0 && editor.offsetHeight > 0) {
            return true;
        }
        // Fallback: any visible input/textarea
        const candidates = Array.from(document.querySelectorAll('textarea, input[type="text"]'));
        for (const el of candidates) {
            if (!el || el.disabled || el.readOnly) continue;
            const s = window.getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden') continue;
            if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;
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
