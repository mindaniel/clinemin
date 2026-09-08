import type { BasicLogger } from "@cline/shared";
import { isSameChatLocation } from "../deepseek-web-v2";
import type { CdpClient } from "./browser";
import type { ClaudeWebV2RuntimeConfig } from "./config";
import { CLAUDE_WEB_URL, sleep } from "./config";

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
 * Point the Claude tab at a specific chat (load an old conversation) or at a
 * fresh composer (new chat). Skips navigating when the tab is already on the
 * destination — that is what avoids a needless full page reload on every
 * follow-up turn of the same conversation. `forceReload` skips that shortcut
 * to recover from a rate-limit block, where the page needs a real refresh to
 * accept messages again even though the URL is unchanged.
 */
export async function navigateClaudeChat(
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

export async function waitForComposerReady(
	cdp: CdpClient,
	sessionId: string,
	config: ClaudeWebV2RuntimeConfig,
	logger?: BasicLogger,
): Promise<void> {
	// Ready means "there is a composer we can actually type into", which is not
	// the same as "some editor-shaped element exists".
	//
	// claude.ai's /new route renders a disabled `textarea#static-composer-input`
	// placeholder ahead of the real contenteditable in document order. A single
	// `querySelector` with a union of selectors returns the first match in
	// DOCUMENT order, not selector order, so it always picked the disabled
	// placeholder, the `.disabled` guard rejected it, and this loop ran out the
	// full login timeout — the browser opened, nothing was ever typed, and two
	// minutes later the turn failed. Scan every candidate and take the first
	// usable one instead.
	const pageFullyLoaded = `(() => {
        if (document.readyState !== 'complete') return false;
        var els = document.querySelectorAll('[data-testid="chat-input"], #prompt-textarea, div[contenteditable="true"], textarea, input[type="text"]');
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (el.disabled) continue;
            if (el.getAttribute('contenteditable') === 'false') continue;
            var s = window.getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden') continue;
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
