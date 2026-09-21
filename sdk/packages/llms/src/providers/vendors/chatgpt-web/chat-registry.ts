/**
 * Which ChatGPT chat a conversation belongs to, remembered across runs.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LanguageModelV2Prompt } from "@ai-sdk/provider";
import { confirmChatLocation } from "../tool-pipeline/confirm-chat-location";
import { connectBrowser } from "./browser";
import {
	CHATGPT_WEB_URL,
	type ChatGPTWebChatEntry,
	type ChatSessionRecord,
	resolveChatGPTWebV2Config,
} from "./config";
import { navigateChatGPTChat } from "./navigation";
import type { TargetInfo } from "./types";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Chat session persistence ──────────────────────────────────────────────────

export function readChatRegistry(
	chatsFile: string,
): Record<string, ChatSessionRecord> {
	try {
		return JSON.parse(fs.readFileSync(chatsFile, "utf-8"));
	} catch {
		return {};
	}
}

export function writeChatRegistry(
	chatsFile: string,
	registry: Record<string, ChatSessionRecord>,
): void {
	try {
		fs.mkdirSync(path.dirname(chatsFile), { recursive: true });
		fs.writeFileSync(chatsFile, JSON.stringify(registry, null, 2), "utf-8");
	} catch (error) {
		console.warn(`[chatgpt-web] failed to persist chat registry: ${error}`);
	}
}

export function lookupChatGPTChatSession(
	chatsFile: string,
	chatKey: string,
): string | undefined {
	return readChatRegistry(chatsFile)[chatKey]?.session_id;
}

export function recordChatGPTChatSession(
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

export function deleteChatGPTChatSession(
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

export function extractChatGPTSessionId(url: string): string | undefined {
	const match = /\/c\/([a-f0-9-]+)/.exec(url);
	return match?.[1] ?? undefined;
}

export function listChatGPTWebChats(): ChatGPTWebChatEntry[] {
	const config = resolveChatGPTWebV2Config();
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

/**
 * Opens an existing ChatGPT Web chat in the browser driven by this provider.
 */
export async function openChatGPTWebChat(
	sessionId: string,
): Promise<{ sessionId: string; url: string }> {
	const config = resolveChatGPTWebV2Config();
	const cdp = await connectBrowser(config);
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
	await navigateChatGPTChat(cdp, cdpSessionId, { fresh: false, sessionId });
	const url = `https://chatgpt.com/c/${sessionId}`;
	// The tab may have been opened a moment ago, and its own start-up routing can
	// win over ours and leave it on a blank new chat. Confirm before returning.
	await confirmChatLocation({
		cdp,
		cdpSessionId,
		provider: "chatgpt-web",
		chatId: sessionId,
		chatUrl: url,
		waitReady: async () => undefined,
	});
	return { sessionId, url };
}
