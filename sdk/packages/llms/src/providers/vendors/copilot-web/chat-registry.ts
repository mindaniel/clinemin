import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LanguageModelV2Prompt } from "@ai-sdk/provider";
import { confirmChatLocation } from "../tool-pipeline/confirm-chat-location";
import { connectBrowser } from "./browser";
import {
	type ChatSessionRecord,
	COPILOT_PAGE_RE,
	COPILOT_WEB_URL,
	type CopilotRateLimitInfo,
	type CopilotWebChatEntry,
	resolveCopilotWebV2Config,
	sleep,
} from "./config";
import { navigateCopilotChat } from "./navigation";

function readChatRegistry(
	chatsFile: string,
): Record<string, ChatSessionRecord> {
	try {
		return JSON.parse(fs.readFileSync(chatsFile, "utf-8"));
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
		console.warn(`[copilot-web] failed to persist chat registry: ${error}`);
	}
}

export function lookupCopilotChatSession(
	chatsFile: string,
	chatKey: string,
): string | undefined {
	return readChatRegistry(chatsFile)[chatKey]?.session_id;
}

export function recordCopilotChatSession(
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

export function deleteCopilotChatSession(
	chatsFile: string,
	chatKey: string,
): void {
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

export function extractCopilotSessionId(url: string): string | undefined {
	const match = /\/chat\/conversation\/([0-9a-f-]{36})/i.exec(url);
	return match?.[1] ?? undefined;
}

/** The page of one Copilot chat. */
export function copilotChatUrl(sessionId: string): string {
	return `https://copilot.com/chat/conversation/${sessionId}`;
}

export function listCopilotWebChats(): CopilotWebChatEntry[] {
	const config = resolveCopilotWebV2Config();
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

/** The chat allowance seen on the last turn, if any. */
export function getCopilotRateLimitInfo(): CopilotRateLimitInfo | undefined {
	const globalRecord = globalThis as Record<string, unknown>;
	return globalRecord.__copilot_rate_limit as CopilotRateLimitInfo | undefined;
}

/**
 * Opens an existing Copilot Web chat in the browser driven by this provider.
 * This is what the CLI `/findchat` command calls after you pick a chat.
 */
export async function openCopilotWebChat(
	sessionId: string,
): Promise<{ sessionId: string; url: string }> {
	const config = resolveCopilotWebV2Config();
	const cdp = await connectBrowser(config);
	const targets = await cdp.send("Target.getTargets");
	let pageTarget = targets.targetInfos?.find(
		(t: { type: string; url?: string }) =>
			t.type === "page" && COPILOT_PAGE_RE.test(t.url ?? ""),
	);
	if (!pageTarget) {
		const result = await cdp.send("Target.createTarget", {
			url: COPILOT_WEB_URL,
		});
		await sleep(2000);
		const newTargets = await cdp.send("Target.getTargets");
		pageTarget = newTargets.targetInfos?.find(
			(t: { targetId: string }) => t.targetId === result.targetId,
		);
		if (!pageTarget) {
			throw new Error("Failed to create Copilot page");
		}
	}
	const attachResult = await cdp.send("Target.attachToTarget", {
		targetId: pageTarget.targetId,
		flatten: true,
	});
	const cdpSessionId = attachResult.sessionId;
	await navigateCopilotChat(cdp, cdpSessionId, { fresh: false, sessionId });
	const url = copilotChatUrl(sessionId);
	// The tab may have been opened a moment ago, and its own start-up routing can
	// win over ours and leave it on a blank new chat. Confirm before returning.
	await confirmChatLocation({
		cdp,
		cdpSessionId,
		provider: "copilot-web",
		chatId: sessionId,
		chatUrl: url,
		waitReady: async () => undefined,
	});
	return { sessionId, url };
}
