/**
 * Navigating ChatGPT to the right chat.
 */

import type { CdpClient } from "./browser";
import {
	chatgptNetworkEnabledSessions,
	setActiveChatGPTCdpSessionId,
	setActiveChatGPTTargetId,
} from "./browser";
import { CHATGPT_WEB_URL } from "./config";
import type { TargetInfo } from "./types";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function navigateChatGPTChat(
	cdp: CdpClient,
	cdpSessionId: string,
	options: { fresh?: boolean; sessionId?: string },
): Promise<void> {
	const { fresh = false, sessionId } = options;

	if (fresh) {
		// Navigate to the main ChatGPT URL, which starts a new chat
		await cdp.send(
			"Runtime.evaluate",
			{
				expression: `window.location.href = ${JSON.stringify(CHATGPT_WEB_URL)};`,
				returnByValue: false,
			},
			cdpSessionId,
		);
		await sleep(3000);
		return;
	}

	if (sessionId) {
		// Check if we are already on the correct chat to avoid unnecessary reloads
		const currentUrl = await readPageUrl(cdp, cdpSessionId);
		const chatUrl = `https://chatgpt.com/c/${sessionId}`;
		if (currentUrl && currentUrl.includes(`/c/${sessionId}`)) {
			// Already on the correct chat, no need to navigate/reload
			return;
		}
		// Navigate to a specific chat
		await cdp.send(
			"Runtime.evaluate",
			{
				expression: `window.location.href = ${JSON.stringify(chatUrl)};`,
				returnByValue: false,
			},
			cdpSessionId,
		);
		await sleep(3000);
		return;
	}

	// If no sessionId, we just ensure we're on the main page
	const currentUrlResult = await cdp.send(
		"Runtime.evaluate",
		{
			expression: "window.location.href",
			returnByValue: true,
		},
		cdpSessionId,
	);
	const currentUrl = currentUrlResult?.value as string | undefined;
	if (!currentUrl || !currentUrl.startsWith("https://chatgpt.com")) {
		await cdp.send(
			"Runtime.evaluate",
			{
				expression: `window.location.href = ${JSON.stringify(CHATGPT_WEB_URL)};`,
				returnByValue: false,
			},
			cdpSessionId,
		);
		await sleep(3000);
	}
}

export async function ensureChatGPTPage(
	cdp: CdpClient,
): Promise<{ targetId: string; cdpSessionId: string }> {
	const targets = await cdp.send("Target.getTargets");
	let pageTarget = targets.targetInfos?.find(
		(t: TargetInfo) =>
			t.type === "page" && t.url?.startsWith("https://chatgpt.com"),
	);

	if (!pageTarget) {
		const result = await cdp.send("Target.createTarget", {
			url: CHATGPT_WEB_URL,
		});
		await sleep(2000);
		const newTargets = await cdp.send("Target.getTargets");
		pageTarget = newTargets.targetInfos?.find(
			(t: TargetInfo) => t.targetId === result.targetId,
		);
		if (!pageTarget) {
			throw new Error("Failed to create ChatGPT page");
		}
	}

	const attachResult = await cdp.send("Target.attachToTarget", {
		targetId: pageTarget.targetId,
		flatten: true,
	});
	const cdpSessionId = attachResult.sessionId;

	// Enable Network domain if not already enabled
	if (!chatgptNetworkEnabledSessions.has(cdpSessionId)) {
		await cdp.send("Network.enable", {}, cdpSessionId);
		chatgptNetworkEnabledSessions.add(cdpSessionId);
	}

	// Store active target/session for reuse
	setActiveChatGPTTargetId(pageTarget.targetId);
	setActiveChatGPTCdpSessionId(cdpSessionId);

	return { targetId: pageTarget.targetId, cdpSessionId };
}

/**
 * The page's current URL.
 *
 * Prefers `Target.getTargets`, which reads the browser's own record of the tab
 * and is unaffected by page state. `Runtime.evaluate` needs a live execution
 * context in the page, and the caller that matters most here runs immediately
 * after a send that navigated the SPA to a brand-new chat — exactly when the
 * old context is being torn down. That read would throw, get swallowed by the
 * catch, and return undefined, so the new chat's id was never captured and
 * every following turn opened yet another fresh chat.
 *
 * `targetId` picks the right tab when several ChatGPT tabs are open. Without
 * it, the first ChatGPT page wins, which is the same assumption
 * `ensureChatGPTPage` makes.
 */
export async function readPageUrl(
	cdp: CdpClient,
	cdpSessionId: string,
	targetId?: string,
): Promise<string | undefined> {
	try {
		const targets = await cdp.send("Target.getTargets");
		const infos = (targets?.targetInfos ?? []) as TargetInfo[];
		const match = targetId
			? infos.find((t) => t.targetId === targetId)
			: infos.find(
					(t) => t.type === "page" && t.url?.startsWith("https://chatgpt.com"),
				);
		if (match?.url) return match.url;
	} catch {
		// Fall through to the in-page read.
	}
	try {
		const result = await cdp.send(
			"Runtime.evaluate",
			{
				expression: "window.location.href",
				returnByValue: true,
			},
			cdpSessionId,
		);
		return result?.value as string | undefined;
	} catch {
		return undefined;
	}
}
