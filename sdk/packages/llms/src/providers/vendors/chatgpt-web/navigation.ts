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

export async function readPageUrl(
	cdp: CdpClient,
	cdpSessionId: string,
): Promise<string | undefined> {
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
