/**
 * Chats run in a minh window on this machine, shown on the phone: each one
 * becomes an issue, and its messages are copied over as they come. A message
 * sent from the phone then continues the same session, like any phone chat.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { noiseRoots } from "./folders";
import { summarizeToolInput } from "./reply";

export interface LocalChat {
	sessionId: string;
	title?: string;
	provider?: string;
	model?: string;
	cwd?: string;
	messagesPath: string;
	/** When the transcript last changed, in ms. */
	updatedMs: number;
}

/** A user message or a whole agent reply, ready to post. */
export interface MirrorEntry {
	role: "user" | "assistant";
	text: string;
	/** Id of the last raw message the entry covers. */
	lastId: string;
}

function isNoise(path: string, roots: string[]): boolean {
	const lower = resolve(path).toLowerCase();
	return roots.some(
		(root) => lower === root || lower.startsWith(`${root}${sep}`),
	);
}

/**
 * Terminal chats whose transcript changed since `sinceMs`, oldest first.
 * Leaves out the phone's own sessions, sub-agents and runs in temp folders.
 */
export function listLocalChats(
	sessionsDir: string,
	sinceMs: number,
	skip: string[] = noiseRoots(),
): LocalChat[] {
	let ids: string[];
	try {
		ids = readdirSync(sessionsDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
	const found: LocalChat[] = [];
	for (const id of ids) {
		const dir = join(sessionsDir, id);
		const manifestPath = join(dir, `${id}.json`);
		if (!existsSync(manifestPath)) continue;
		let manifest: Record<string, unknown>;
		try {
			manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
		} catch {
			continue;
		}
		const metadata = (manifest.metadata ?? {}) as Record<string, unknown>;
		if (manifest.interactive !== true) continue;
		if (manifest.source === "github" || metadata.source === "github") continue;
		if (metadata.parentSessionId) continue;
		const folder = String(manifest.workspace_root || manifest.cwd || "");
		if (folder && isNoise(folder, skip)) continue;
		const messagesPath =
			typeof manifest.messages_path === "string"
				? manifest.messages_path
				: join(dir, `${id}.messages.json`);
		let updatedMs: number;
		try {
			updatedMs = statSync(messagesPath).mtimeMs;
		} catch {
			continue;
		}
		if (updatedMs < sinceMs) continue;
		const text = (value: unknown) =>
			typeof value === "string" && value.trim() ? value.trim() : undefined;
		found.push({
			sessionId: id,
			title: text(metadata.title),
			provider: text(manifest.provider),
			model: text(manifest.model),
			cwd: folder || undefined,
			messagesPath,
			updatedMs,
		});
	}
	return found.sort((a, b) => a.updatedMs - b.updatedMs);
}

interface RawMessage {
	id?: string;
	role?: string;
	content?: unknown;
}

const USER_INPUT = /<user_input[^>]*>([\s\S]*?)<\/user_input>/g;

/** What the person typed: the user_input parts of a user message, if any. */
function typedText(content: unknown): string | undefined {
	const blocks = Array.isArray(content)
		? content
		: [{ type: "text", text: content }];
	const parts: string[] = [];
	for (const block of blocks as Array<Record<string, unknown>>) {
		if (block?.type !== "text" || typeof block.text !== "string") continue;
		for (const match of block.text.matchAll(USER_INPUT)) parts.push(match[1]);
	}
	const text = parts.join("\n\n").trim();
	return text || undefined;
}

class ReplyGroup {
	private readonly texts: string[] = [];
	private readonly tools: string[] = [];
	lastId = "";

	add(message: RawMessage): void {
		if (message.id) this.lastId = message.id;
		if (message.role !== "assistant" || !Array.isArray(message.content)) return;
		for (const block of message.content as Array<Record<string, unknown>>) {
			if (block?.type === "text" && typeof block.text === "string") {
				if (block.text.trim()) this.texts.push(block.text.trim());
			} else if (block?.type === "tool_use") {
				const summary = summarizeToolInput(block.input);
				this.tools.push(
					`\`${String(block.name ?? "tool")}\`${summary ? ` ${summary}` : ""}`,
				);
			}
		}
	}

	get empty(): boolean {
		return !this.lastId;
	}

	render(): string {
		const steps = this.tools.length
			? `<details><summary>${this.tools.length} step${this.tools.length === 1 ? "" : "s"}</summary>\n\n${this.tools.map((tool) => `- ${tool}`).join("\n")}\n\n</details>\n\n`
			: "";
		return `${steps}${this.texts.join("\n\n")}`.trim() || "_(no text)_";
	}
}

/**
 * The transcript as chat entries: each typed message, then one reply holding
 * everything the agent did until the next one (tool results and the
 * runtime's own nudges fold into it). Thinking is left out.
 *
 * With `afterId`, only what came after that raw message; a reply it stopped
 * partway through continues as a reply of its own. Undefined when `afterId`
 * is no longer in the transcript (it was compacted).
 */
export function readTranscript(
	path: string,
	afterId?: string,
): MirrorEntry[] | undefined {
	let messages: RawMessage[];
	try {
		const data = JSON.parse(readFileSync(path, "utf-8"));
		messages = Array.isArray(data) ? data : (data?.messages ?? []);
	} catch {
		return [];
	}
	let started = false;
	if (afterId) {
		const index = messages.findIndex((message) => message.id === afterId);
		if (index < 0) return undefined;
		messages = messages.slice(index + 1);
		started = true;
	}
	const entries: MirrorEntry[] = [];
	let group = new ReplyGroup();
	const flush = () => {
		if (!group.empty)
			entries.push({
				role: "assistant",
				text: group.render(),
				lastId: group.lastId,
			});
		group = new ReplyGroup();
	};
	for (const message of messages) {
		const typed =
			message.role === "user" ? typedText(message.content) : undefined;
		if (typed) {
			flush();
			started = true;
			entries.push({ role: "user", text: typed, lastId: message.id ?? "" });
		} else if (started) {
			// Anything before the first typed message is setup, not chat.
			group.add(message);
		}
	}
	flush();
	return entries;
}
