/**
 * Getting a Chrome we can drive, and a Kimi page that is ready to type into.
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
	Kimi_WEB_URL,
	type KimiWebV2RuntimeConfig,
	sleep,
} from "./config";

export type { CdpClient };

// ── CDP Client ────────────────────────────────────────────────────────────────

let activeCdp: CdpClient | null = null;
let activeCdpKey: string | null = null;

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
	return connectCdpForProvider(port, timeoutMs, "kimi-web");
}

export async function connectBrowser(
	config: KimiWebV2RuntimeConfig,
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
		// Attaching to a browser someone else launched. We do not own it and
		// must never kill it, but the claim tells whoever DOES own it not to
		// close it out from under this session. See browser-claims.ts.
		claimBrowserPort(config.debugPort);
		activeCdp = await connectCdp(config.debugPort, connectTimeoutMs);
		activeCdpKey = key;
		return activeCdp;
	}

	const executablePath = config.chromePath ?? findChromePath();
	if (!executablePath) {
		throw new Error(
			browserNotFoundMessage(
				"~/.cline/kimi-web/config.json",
				"Kimi_WEB_CHROME_PATH",
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
		Kimi_WEB_URL,
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
			providerId: "kimi-web",
			pid: child.pid,
			debugPort: config.debugPort,
		});
	}

	try {
		await waitForEndpoint(config.debugPort, config.launchTimeoutMs);
	} catch (err) {
		throw new Error(
			`Failed to launch Chrome for Kimi Web: ${(err as Error).message}. ` +
				"If Chrome is already running with this profile, close it or set a different Kimi_WEB_PROFILE_DIR.",
		);
	}
	activeCdp = await connectCdp(config.debugPort, connectTimeoutMs);
	activeCdpKey = key;
	return activeCdp;
}

// ── Composer ready ─────────────────────────────────────────────────────────────

export async function waitForComposerReady(
	cdp: CdpClient,
	sessionId: string,
	config: KimiWebV2RuntimeConfig,
	logger?: BasicLogger,
): Promise<void> {
	const pageFullyLoaded = `(() => {
        if (document.readyState !== 'complete') return false;
        // Primary check: Kimi's actual contenteditable chat input editor
        var kimiEditor = document.querySelector('.chat-input-editor[contenteditable="true"]');
        if (kimiEditor && kimiEditor.offsetWidth > 0 && kimiEditor.offsetHeight > 0) {
            return true;
        }
        var candidates = Array.from(document.querySelectorAll('textarea, input[type="text"], .chat-input'));
        for (var i = 0; i < candidates.length; i++) {
            var ta = candidates[i];
            if (!ta || ta.disabled || ta.readOnly) continue;
            // Exclude Monaco/code-block editors rendered inside assistant
            // responses. Kimi wraps code blocks in .Kimi-markdown-code and the
            // Monaco editor contains a readonly .ime-text-area textarea that
            // used to be mistaken for the chat composer.
            if (ta.closest('.Kimi-markdown-code, .monaco-editor, [class*="markdown-code"], pre')) continue;
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
			if (config.debug) logger?.debug("[kimi-web] page fully loaded");
			await sleep(1500);
			return;
		}

		if (!hintLogged) {
			hintLogged = true;
			logger?.log(
				"Kimi Web: waiting for the www.kimi.ai page to finish loading " +
					`(up to ${Math.round(config.loginTimeoutMs / 1000)}s). If the Chrome window shows a login page, log in now.`,
				{ severity: "info", providerId: "kimi-web" },
			);
		}

		if (Date.now() >= deadline) {
			throw new Error(
				"Kimi Web: www.kimi.ai did not finish loading within " +
					`${Math.round(config.loginTimeoutMs / 1000)}s. Please log in to www.kimi.ai in the Chrome window.`,
			);
		}
		await sleep(500);
	}
}
