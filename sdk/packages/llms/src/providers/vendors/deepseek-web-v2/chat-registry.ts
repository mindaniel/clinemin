import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LanguageModelV2Prompt } from "@ai-sdk/provider";
import { confirmChatLocation } from "../tool-pipeline/confirm-chat-location";
import {
	connectBrowser,
	ensureDeepSeekPage,
	navigateDeepSeekChat,
} from "./browser";
import { resolveDeepSeekWebV2Config } from "./config";
/**
 * Derive a stable key for a CLI conversation from its first user message. All
 * turns of one CLI chat share the same first user message (the transcript is
 * preserved across turns and restarts), so this key is auto-consistent across
 * follow-ups and resumes — and a brand-new CLI chat (new first prompt) yields a
 * brand-new key that starts a fresh DeepSeek web chat. This mirrors the "small
 * message" identity in start_continue_chat.py: same conversation -> same chat.
 */
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

/**
 * True when this prompt is the opening turn of a conversation: the model has
 * not answered yet.
 */
export function isOpeningTurn(prompt: LanguageModelV2Prompt): boolean {
	return !prompt.some((message) => message.role === "assistant");
}

function randomChatKeySuffix(): string {
	return createHash("sha256")
		.update(`${Date.now()}:${Math.random()}`)
		.digest("hex")
		.slice(0, 8);
}

/**
 * Pick the chat key for one call, given what is already on disk.
 *
 * The plain hash of the first user message is not an identity: two separate
 * CLI conversations that both open with "hi" hash to the same key, so the
 * second one reopened the first one's DeepSeek chat and inherited its history.
 * A common opening line is exactly when that happens.
 *
 * So the hash is only a FAMILY name now. Within it:
 *
 *  - A call continuing a conversation this process already routed keeps that
 *    conversation's chat, whatever anyone else has opened since.
 *  - An opening turn takes the plain key when nothing has claimed it, and
 *    otherwise mints a fresh suffixed one — a new conversation gets a new
 *    chat even when it says the same first words.
 *  - A later turn resolves to the most recently active chat in the family,
 *    which is the one this conversation opened.
 */
export function resolveConversationChatKey(
	chatsFile: string,
	prompt: LanguageModelV2Prompt,
	activeChatKey?: string,
): string {
	const base = chatKeyFromPrompt(prompt);
	if (
		activeChatKey &&
		(activeChatKey === base || activeChatKey.startsWith(`${base}-`))
	) {
		return activeChatKey;
	}
	if (isOpeningTurn(prompt)) {
		return lookupChatSession(chatsFile, base) === undefined
			? base
			: `${base}-${randomChatKeySuffix()}`;
	}
	return newestChatKeyForBase(chatsFile, base) ?? base;
}

/** The most recently used key in a family, i.e. `base` or `base-<suffix>`. */
function newestChatKeyForBase(
	chatsFile: string,
	base: string,
): string | undefined {
	const registry = readChatRegistry(chatsFile);
	let newestKey: string | undefined;
	let newestAt = "";
	for (const [key, record] of Object.entries(registry)) {
		if (key !== base && !key.startsWith(`${base}-`)) continue;
		const lastActive = record?.last_active ?? "";
		if (!newestKey || lastActive > newestAt) {
			newestKey = key;
			newestAt = lastActive;
		}
	}
	return newestKey;
}

/** A persisted mapping entry for one CLI conversation -> one DeepSeek web chat. */
interface ChatSessionRecord {
	session_id: string;
	first_seen: string;
	last_active: string;
}

/** A DeepSeek web chat `session_id` from a `a/chat/s/<session_id>` URL, if any. */
export function parseSessionIdFromUrl(url: string): string | undefined {
	const match = /\/a\/chat\/s\/([^/?#]+)/.exec(url);
	return match?.[1] ?? undefined;
}

function readChatRegistry(
	chatsFile: string,
): Record<string, ChatSessionRecord> {
	try {
		return JSON.parse(fs.readFileSync(chatsFile, "utf-8")) as Record<
			string,
			ChatSessionRecord
		>;
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
		// Never let a persistence failure break the conversation.
		console.warn(
			`[deepseek-web-v2] failed to persist chat registry to ${chatsFile}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/** Look up the DeepSeek web chat previously mapped to this CLI conversation. */
export function lookupChatSession(
	chatsFile: string,
	chatKey: string,
): string | undefined {
	return readChatRegistry(chatsFile)[chatKey]?.session_id;
}

/**
 * Record (or keep mapping) a DeepSeek web chat for a CLI conversation and
 * touch its `last_active`.
 */
export function recordChatSession(
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

export function deleteChatSession(chatsFile: string, chatKey: string): void {
	const registry = readChatRegistry(chatsFile);
	if (registry[chatKey]) {
		delete registry[chatKey];
		writeChatRegistry(chatsFile, registry);
	}
}

/** A single persisted DeepSeek web chat, as shown by `/findchat`. */
export interface DeepSeekWebV2ChatEntry {
	/** Stable key of the CLI conversation that owns this chat (if any). */
	chatKey: string;
	/** DeepSeek web `session_id` (the `/a/chat/s/<id>` slug). */
	sessionId: string;
	firstSeen: string;
	lastActive: string;
}

/**
 * List every DeepSeek web chat the deepseek-web-v2 provider has persisted, most
 * recently active first. This is the data `/findchat` (a CLI local command)
 * reads to show your chat history. Reads the provider's own `chats.json`, so it
 * reflects exactly the chats this provider knows about.
 */
export function listDeepSeekWebV2Chats(): DeepSeekWebV2ChatEntry[] {
	const config = resolveDeepSeekWebV2Config();
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
 * Open an existing DeepSeek web chat in the SAME Chrome browser the provider
 * already drives (reusing the live CDP connection when it is still open), so
 * your logged-in history is shown and you can continue it. If the browser
 * isn't running it is (re)launched from the provider's own config/profile.
 *
 * This is what the CLI `/findchat` command calls after you pick a chat.
 */
export async function openDeepSeekWebV2Chat(
	sessionId: string,
): Promise<{ sessionId: string; url: string }> {
	const config = resolveDeepSeekWebV2Config();
	const cdp = await connectBrowser(config);
	const { sessionId: cdpSessionId } = await ensureDeepSeekPage(cdp);
	// Reuse the provider's own navigation helper (which already avoids a
	// redundant reload — unless recovering from a throttle).
	await navigateDeepSeekChat(cdp, cdpSessionId, { fresh: false, sessionId });
	const url = `https://chat.deepseek.com/a/chat/s/${sessionId}`;
	// The tab may have been opened a moment ago, and its own start-up routing can
	// win over ours and leave it on a blank new chat. Confirm before returning.
	await confirmChatLocation({
		cdp,
		cdpSessionId,
		provider: "deepseek-web-v2",
		chatId: sessionId,
		chatUrl: url,
		waitReady: async () => undefined,
	});
	return { sessionId, url };
}
