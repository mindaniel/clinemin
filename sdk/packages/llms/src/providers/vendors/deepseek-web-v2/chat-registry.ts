import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LanguageModelV2Prompt } from "@ai-sdk/provider";
import {
	DEFAULT_PROFILE_NAME,
	listBrowserProfiles,
} from "../tool-pipeline/browser-profiles";
import { getCurrentCliSessionId } from "../tool-pipeline/cli-session-scope";
import { confirmChatLocation } from "../tool-pipeline/confirm-chat-location";
import {
	connectBrowser,
	ensureDeepSeekPage,
	navigateDeepSeekChat,
} from "./browser";
import { CONFIG_DIR, resolveDeepSeekWebV2Config } from "./config";
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
	/** The chat's name on chat.deepseek.com, as the site's sidebar shows it. */
	title?: string;
	/** CLI session that drove this chat, so history can show `title`. */
	cli_session_id?: string;
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
	const cliSessionId = getCurrentCliSessionId() ?? existing?.cli_session_id;
	// A title belongs to the site chat, so it survives only while the key
	// still points at the same one.
	const title = existing?.session_id === sessionId ? existing.title : undefined;
	registry[chatKey] = {
		session_id: sessionId,
		first_seen: existing?.first_seen ?? new Date().toISOString(),
		last_active: new Date().toISOString(),
		...(title ? { title } : {}),
		...(cliSessionId ? { cli_session_id: cliSessionId } : {}),
	};
	writeChatRegistry(chatsFile, registry);
}

/**
 * Store site chat titles, keyed by DeepSeek `session_id`. Returns how many
 * records changed, and skips the write when none did.
 */
export function setChatTitles(
	chatsFile: string,
	titles: ReadonlyMap<string, string>,
): number {
	if (titles.size === 0) return 0;
	const registry = readChatRegistry(chatsFile);
	let changed = 0;
	for (const record of Object.values(registry)) {
		const title = titles.get(record?.session_id)?.trim();
		if (!title || record.title === title) continue;
		record.title = title;
		changed++;
	}
	if (changed > 0) writeChatRegistry(chatsFile, registry);
	return changed;
}

/** DeepSeek `session_id`s in one registry, most recently active first. */
export function listRegistrySessionIds(chatsFile: string): string[] {
	return Object.values(readChatRegistry(chatsFile))
		.filter((record) => typeof record?.session_id === "string")
		.sort((a, b) => (a.last_active < b.last_active ? 1 : -1))
		.map((record) => record.session_id);
}

/**
 * Site titles of the DeepSeek chats CLI sessions drove, keyed by CLI session
 * id (the newest chat wins when a session drove several). Searches every
 * browser profile's registry: history lists sessions from all of them.
 */
export function readDeepSeekChatTitlesBySession(): Map<string, string> {
	let profiles: string[];
	try {
		profiles = listBrowserProfiles().map((profile) => profile.name);
	} catch {
		profiles = [];
	}
	// Same layout `resolveProfilePaths` uses, without resolving debug ports.
	const files = new Set([path.join(CONFIG_DIR, "chats.json")]);
	for (const name of profiles) {
		if (name === DEFAULT_PROFILE_NAME) continue;
		files.add(path.join(CONFIG_DIR, "profiles", name, "chats.json"));
	}
	const newest = new Map<string, ChatSessionRecord>();
	for (const file of files) {
		for (const record of Object.values(readChatRegistry(file))) {
			const cliSessionId = record?.cli_session_id;
			if (!cliSessionId || !record.title) continue;
			const seen = newest.get(cliSessionId);
			if (!seen || record.last_active > seen.last_active) {
				newest.set(cliSessionId, record);
			}
		}
	}
	return new Map(
		[...newest].map(([cliSessionId, record]) => [
			cliSessionId,
			record.title as string,
		]),
	);
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
	/** The chat's name on the site, once it has been fetched. */
	title?: string;
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
			...(record.title ? { title: record.title } : {}),
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
