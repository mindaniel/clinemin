import type { BasicLogger } from "@cline/shared";
import { isSameChatLocation } from "../deepseek-web-v2";
import { pressTemporaryChatButton } from "../tool-pipeline/temporary-chat";
import type { CdpClient } from "./browser";
import { copilotChatUrl } from "./chat-registry";
import type { CopilotWebV2RuntimeConfig } from "./config";
import { COPILOT_WEB_URL, sleep } from "./config";

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
 * Point the Copilot tab at a specific chat (load an old conversation) or at a
 * fresh composer (new chat). Skips navigating when the tab is already on the
 * destination — that is what avoids a needless full page reload on every
 * follow-up turn of the same conversation. `forceReload` skips that shortcut
 * to recover from a rate-limit block, where the page needs a real refresh to
 * accept messages again even though the URL is unchanged.
 */
export async function navigateCopilotChat(
	cdp: CdpClient,
	cdpSessionId: string,
	target: { sessionId?: string; fresh: boolean },
	logger?: BasicLogger,
	forceReload = false,
): Promise<void> {
	const destination = target.fresh
		? COPILOT_WEB_URL
		: target.sessionId
			? copilotChatUrl(target.sessionId)
			: COPILOT_WEB_URL;

	const currentUrl = (await readPageUrl(cdp, cdpSessionId)) || "";
	const alreadyThere = isSameChatLocation(currentUrl, destination);

	if (alreadyThere && !forceReload) {
		logger?.debug?.(
			`[copilot-web] already on ${destination} — skipping navigation (no reload)`,
		);
		if (target.fresh) {
			await pressTemporaryChatButton("copilot-web", cdp, cdpSessionId, logger);
		}
		await sleep(300);
		return;
	}

	logger?.debug?.(
		`[copilot-web] ${target.fresh ? "opening a new Copilot chat" : `loading Copilot chat ${target.sessionId}`}`,
	);
	await cdp.send(
		"Runtime.evaluate",
		{
			expression: `(() => { window.location.href = ${JSON.stringify(destination)}; })()`,
			returnByValue: true,
		},
		cdpSessionId,
	);
	// Give the SPA time to route to the target chat and hydrate before
	// `waitForComposerReady` confirms the composer is usable.
	await sleep(1500);
	if (target.fresh) {
		await pressTemporaryChatButton("copilot-web", cdp, cdpSessionId, logger);
	}
}

export async function waitForComposerReady(
	cdp: CdpClient,
	sessionId: string,
	config: CopilotWebV2RuntimeConfig,
	logger?: BasicLogger,
): Promise<void> {
	const pageFullyLoaded = `(() => {
        if (document.readyState !== 'complete') return false;
        // Copilot's composer is a contenteditable span, not a textarea.
        var ed = document.querySelector('#m365-chat-editor-target-element, [contenteditable="true"][aria-label*="Copilot" i]');
        if (!ed || ed.getAttribute('aria-disabled') === 'true') return false;
        if (ed.offsetWidth === 0 || ed.offsetHeight === 0) return false;
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
			if (config.debug) logger?.debug("[copilot-web] page fully loaded");
			await sleep(1500);
			return;
		}

		if (!hintLogged) {
			hintLogged = true;
			logger?.log(
				"Copilot Web: waiting for the copilot.com page to finish loading " +
					`(up to ${Math.round(config.loginTimeoutMs / 1000)}s). If the Chrome window shows a login page, log in now (no window? run /login).`,
				{ severity: "info", providerId: "copilot-web" },
			);
		}

		if (Date.now() >= deadline) {
			throw new Error(
				"Copilot Web: copilot.com did not finish loading within " +
					`${Math.round(config.loginTimeoutMs / 1000)}s. Please sign in to Copilot in the browser window.`,
			);
		}
		await sleep(500);
	}
}
