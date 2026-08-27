import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Persistent `/findchat` bindings: one CLI session <-> one web chat.
 *
 * The web providers normally derive their chat from a hash of the
 * conversation's first user message, which works only while the CLI session and
 * the web chat were created together. Resuming an older session from `/history`
 * and pointing it at an existing web chat is what `/findchat` is for, and that
 * pairing has to outlive the process — so it is written to disk here and
 * re-applied when the session starts.
 *
 * Bindings live in `<cline dir>/chat-bindings.json`, keyed by CLI session id:
 *
 *     { "<cli session id>": { "providerId": "deepseek-web-v2", "chatKey": "4632a8..." } }
 *
 * The pairing is one-to-one in both directions. Binding a web chat that another
 * CLI session already claimed steals it: the previous session's record is
 * removed, so two sessions never write into the same chat.
 *
 * The live half of the binding is `bindChatKey` in
 * llms' `tool-pipeline/chat-target.ts`; this module only decides what should be
 * bound. Compaction clears both, since it deliberately moves to a fresh chat.
 */

export interface ChatBinding {
	providerId: string;
	chatKey: string;
}

type BindingsFile = Record<string, ChatBinding>;

function clineDir(): string {
	// Same resolution the rest of the CLI uses (see commands/config.ts).
	return process.env.CLINE_DIR?.trim() || join(homedir(), ".cline");
}

function bindingsFilePath(): string {
	return join(clineDir(), "chat-bindings.json");
}

function readBindingsFile(): BindingsFile {
	const file = bindingsFilePath();
	if (!existsSync(file)) {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}
		const bindings: BindingsFile = {};
		for (const [sessionId, value] of Object.entries(parsed as object)) {
			if (
				value &&
				typeof value === "object" &&
				typeof (value as ChatBinding).providerId === "string" &&
				typeof (value as ChatBinding).chatKey === "string"
			) {
				bindings[sessionId] = {
					providerId: (value as ChatBinding).providerId,
					chatKey: (value as ChatBinding).chatKey,
				};
			}
		}
		return bindings;
	} catch {
		// A corrupt bindings file must not stop the CLI from starting; sessions
		// simply fall back to hash-derived chats.
		return {};
	}
}

function writeBindingsFile(bindings: BindingsFile): void {
	const file = bindingsFilePath();
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(bindings, null, "\t")}\n`, "utf8");
}

/** The web chat this CLI session is pinned to, if any. */
export function readChatBinding(cliSessionId: string): ChatBinding | undefined {
	return readBindingsFile()[cliSessionId];
}

/**
 * Pin a CLI session to a web chat, stealing it from whichever session held it
 * before. Returns the id of the session that lost it, so the caller can say so.
 */
export function writeChatBinding(
	cliSessionId: string,
	binding: ChatBinding,
): string | undefined {
	const bindings = readBindingsFile();
	let stolenFrom: string | undefined;
	for (const [sessionId, existing] of Object.entries(bindings)) {
		if (sessionId === cliSessionId) continue;
		if (
			existing.providerId === binding.providerId &&
			existing.chatKey === binding.chatKey
		) {
			stolenFrom = sessionId;
			delete bindings[sessionId];
		}
	}
	bindings[cliSessionId] = binding;
	writeBindingsFile(bindings);
	return stolenFrom;
}

/** Drop a session's binding (e.g. after compaction moved it to a fresh chat). */
export function clearChatBinding(cliSessionId: string): void {
	const bindings = readBindingsFile();
	if (!(cliSessionId in bindings)) {
		return;
	}
	delete bindings[cliSessionId];
	writeBindingsFile(bindings);
}
