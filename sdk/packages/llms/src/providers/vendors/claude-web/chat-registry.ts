import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LanguageModelV2Prompt } from "@ai-sdk/provider";
import { connectBrowser } from "./browser";
import { CLAUDE_WEB_URL, resolveClaudeWebV2Config, sleep } from "./config";
import { navigateClaudeChat } from "./navigation";

interface ChatSessionRecord {
	session_id: string;
	first_seen: string;
	last_active: string;
}

export interface ClaudeWebChatEntry {
	chatKey: string;
	sessionId: string;
	firstSeen: string;
	lastActive: string;
}

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
		console.warn(`[claude-web] failed to persist chat registry: ${error}`);
	}
}

export function lookupClaudeChatSession(
	chatsFile: string,
	chatKey: string,
): string | undefined {
	return readChatRegistry(chatsFile)[chatKey]?.session_id;
}

export function recordClaudeChatSession(
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

export function deleteClaudeChatSession(
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

export function extractClaudeSessionId(url: string): string | undefined {
	const match = /\/chat\/([a-f0-9-]+)/.exec(url);
	return match?.[1] ?? undefined;
}

export function listClaudeWebChats(): ClaudeWebChatEntry[] {
	const config = resolveClaudeWebV2Config();
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

export async function openClaudeWebChat(
	sessionId: string,
): Promise<{ sessionId: string; url: string }> {
	const config = resolveClaudeWebV2Config();
	const cdp = await connectBrowser(config);
	const targets = await cdp.send("Target.getTargets");
	let pageTarget = targets.targetInfos?.find(
		(t: { type: string; url?: string }) =>
			t.type === "page" && t.url?.startsWith("https://claude.ai"),
	);
	if (!pageTarget) {
		const result = await cdp.send("Target.createTarget", {
			url: CLAUDE_WEB_URL,
		});
		await sleep(2000);
		const newTargets = await cdp.send("Target.getTargets");
		pageTarget = newTargets.targetInfos?.find(
			(t: { targetId: string }) => t.targetId === result.targetId,
		);
		if (!pageTarget) {
			throw new Error("Failed to create Claude page");
		}
	}
	const attachResult = await cdp.send("Target.attachToTarget", {
		targetId: pageTarget.targetId,
		flatten: true,
	});
	const cdpSessionId = attachResult.sessionId;
	await navigateClaudeChat(cdp, cdpSessionId, { fresh: false, sessionId });
	return {
		sessionId,
		url: `https://claude.ai/chat/${sessionId}`,
	};
}
