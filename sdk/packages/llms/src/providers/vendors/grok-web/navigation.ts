import type { BasicLogger } from "@cline/shared";
import { isSameChatLocation } from "../deepseek-web-v2";
import type { CdpClient } from "./browser";
import type { GrokWebV2RuntimeConfig } from "./config";
import { Grok_WEB_URL, sleep } from "./config";

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
 * Point the Grok tab at a specific chat (load an old conversation) or at a
 * fresh composer (new chat). Skips navigating when the tab is already on the
 * destination — that is what avoids a needless full page reload on every
 * follow-up turn of the same conversation. `forceReload` skips that shortcut
 * to recover from a rate-limit block, where the page needs a real refresh to
 * accept messages again even though the URL is unchanged.
 */
export async function navigateGrokChat(
	cdp: CdpClient,
	cdpSessionId: string,
	target: { sessionId?: string; fresh: boolean },
	logger?: BasicLogger,
	forceReload = false,
): Promise<void> {
	const destination = target.fresh
		? Grok_WEB_URL
		: target.sessionId
			? `https://grok.com/c/${target.sessionId}`
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

export async function waitForComposerReady(
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
				"Grok Web: waiting for the grok.com page to finish loading " +
					`(up to ${Math.round(config.loginTimeoutMs / 1000)}s). If the Chrome window shows a login page, log in now.`,
				{ severity: "info", providerId: "grok-web" },
			);
		}

		if (Date.now() >= deadline) {
			throw new Error(
				"Grok Web: grok.com did not finish loading within " +
					`${Math.round(config.loginTimeoutMs / 1000)}s. Please log in to grok.com in the Chrome window.`,
			);
		}
		await sleep(500);
	}
}
