/**
 * `cline watch [worker]` — follow a manager's workers live, in a terminal of
 * its own.
 *
 * Workers hand their replies back to the manager, so the manager's terminal
 * only ever shows what they concluded. What they are doing meanwhile — the
 * task they got, each command and its output, what they said — is written as
 * it happens to the team log (`logs/team/<sessionId>.log`, see
 * `team-debug-log.ts`). This follows that file, so it works from any terminal,
 * needs no hub connection, and can never disturb the manager's chat.
 *
 * With no worker named it shows every worker, each in its own color. With no
 * `--session` it follows the newest manager session, and moves on by itself
 * when a newer one starts.
 */

import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { ensureHookLogDir } from "@cline/shared/storage";
import { c } from "../utils/output";

export interface WatchCommandOptions {
	worker?: string;
	sessionId?: string;
}

const POLL_MS = 400;
const SESSION_CHECK_MS = 2_000;
/** How much history to show on start, so a fresh window has some context. */
const BACKLOG_BYTES = 256 * 1024;
const BACKLOG_ENTRIES = 40;
const ENTRY_START_RE = /^\d{4}-\d{2}-\d{2}T\S+ /;
const NAME_COLORS = [
	"\x1b[36m",
	"\x1b[32m",
	"\x1b[33m",
	"\x1b[35m",
	"\x1b[34m",
	"\x1b[96m",
	"\x1b[92m",
	"\x1b[93m",
	"\x1b[95m",
	"\x1b[94m",
];

export function teamLogDir(): string {
	return join(ensureHookLogDir(), "team");
}

/** The newest manager session log, or undefined when there is none yet. */
export function newestTeamLog(dir = teamLogDir()): string | undefined {
	if (!existsSync(dir)) return undefined;
	let newest: { path: string; mtime: number } | undefined;
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".log")) continue;
		const path = join(dir, name);
		try {
			const mtime = statSync(path).mtimeMs;
			if (!newest || mtime > newest.mtime) newest = { path, mtime };
		} catch {
			// Gone between listing and stat.
		}
	}
	return newest?.path;
}

/**
 * Who an entry is about: the agent that acted, or the worker a task or message
 * went to. `manager` marks the manager's own lines.
 */
export function entryNames(header: string): string[] {
	const rest = header.replace(ENTRY_START_RE, "");
	const patterns: RegExp[] = [
		/^TASK -> (\S+?):/,
		/^TASK (?:DONE|FAILED) (\S+?):?(?:\s|$)/,
		/^(?:SPAWN|SHUTDOWN) (\S+?):?(?:\s|$)/,
		/^RUN (?:FAILED|CANCELLED|INTERRUPTED) (\S+?):?(?:\s|$)/,
	];
	for (const pattern of patterns) {
		const match = pattern.exec(rest);
		if (match?.[1]) return [match[1]];
	}
	const message = /^MESSAGE (\S+) -> (\S+?)(?:\s|:|$)/.exec(rest);
	if (message?.[1] && message[2]) return [message[1], message[2]];
	const first = rest.split(/\s/, 1)[0];
	return first ? [first] : [];
}

export function entryMatches(header: string, worker: string | undefined) {
	if (!worker) return true;
	return entryNames(header).includes(worker);
}

function colorFor(name: string): string {
	if (name === "manager") return c.gray;
	let hash = 0;
	for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return NAME_COLORS[hash % NAME_COLORS.length] ?? c.cyan;
}

/** One log entry, ready to print: time, colored name, body indented. */
export function formatEntry(entry: string): string {
	const [header = "", ...body] = entry.split("\n");
	const time = header.slice(11, 19);
	let rest = header.replace(ENTRY_START_RE, "");
	for (const name of entryNames(header)) {
		rest = rest.replace(name, `${colorFor(name)}${c.bold}${name}${c.reset}`);
	}
	const lines = [`${c.gray}${time}${c.reset} ${rest}`];
	for (const line of body) {
		lines.push(`  ${line.replace(/^ {4}/, "")}`);
	}
	return lines.join("\n");
}

/** Splits appended log text into whole entries, holding back a partial one. */
export class EntrySplitter {
	private buffer = "";

	push(text: string): string[] {
		this.buffer += text;
		const lines = this.buffer.split("\n");
		// The last element is either "" (text ended on a newline) or a partial line.
		this.buffer = lines.pop() ?? "";
		const entries: string[] = [];
		let current: string[] = [];
		for (const line of lines) {
			if (ENTRY_START_RE.test(line) && current.length > 0) {
				entries.push(current.join("\n"));
				current = [];
			}
			current.push(line);
		}
		if (current.length > 0) {
			// Entries are appended whole, so a block is complete unless the
			// partial line after it is one of its own (indented) continuation
			// lines; a partial line at column 0 is the next entry starting.
			if (this.buffer.startsWith(" ")) {
				this.buffer = `${current.join("\n")}\n${this.buffer}`;
			} else {
				entries.push(current.join("\n"));
			}
		}
		return entries;
	}
}

function readFrom(path: string, offset: number): { text: string; end: number } {
	const size = statSync(path).size;
	if (size <= offset) return { text: "", end: size };
	const fd = openSync(path, "r");
	try {
		const length = size - offset;
		const chunk = Buffer.alloc(length);
		readSync(fd, chunk, 0, length, offset);
		return { text: chunk.toString("utf8"), end: size };
	} finally {
		closeSync(fd);
	}
}

export async function runWatchCommand(
	options: WatchCommandOptions,
): Promise<number> {
	const worker = options.worker?.trim() || undefined;
	const write = (text: string) => process.stdout.write(`${text}\n`);
	const resolvePath = () =>
		options.sessionId
			? join(teamLogDir(), `${options.sessionId}.log`)
			: newestTeamLog();

	if (process.stdout.isTTY) {
		process.stdout.write(
			`\x1b]0;${worker ? `cline: ${worker}` : "cline: workers"}\x07`,
		);
	}
	write(
		`${c.bold}Watching ${worker ?? "every worker"}${c.reset} ${c.gray}(Ctrl+C closes this; the manager keeps going)${c.reset}`,
	);

	let path: string | undefined;
	let offset = 0;
	let splitter = new EntrySplitter();
	let waitingNoted = false;

	const open = (next: string, backlog: boolean) => {
		path = next;
		splitter = new EntrySplitter();
		const size = statSync(next).size;
		offset = backlog ? Math.max(0, size - BACKLOG_BYTES) : 0;
		write(
			`${c.gray}── session ${next.replace(/^.*[\\/]/, "").replace(/\.log$/, "")}${c.reset}`,
		);
		if (!backlog) return;
		const { text, end } = readFrom(next, offset);
		offset = end;
		let entries = splitter.push(text);
		// Starting mid-file, the first block may be the tail of an entry.
		if (size > BACKLOG_BYTES) entries = entries.slice(1);
		for (const entry of entries
			.filter((entry) => entryMatches(entry, worker))
			.slice(-BACKLOG_ENTRIES)) {
			write(formatEntry(entry));
		}
	};

	const tick = () => {
		if (!path || !existsSync(path)) {
			const next = resolvePath();
			if (next && existsSync(next)) {
				open(next, true);
			} else if (!waitingNoted) {
				waitingNoted = true;
				write(
					`${c.gray}No manager session log yet in ${teamLogDir()}. Waiting for one…${c.reset}`,
				);
			}
			return;
		}
		if (statSync(path).size < offset) offset = 0;
		const { text, end } = readFrom(path, offset);
		offset = end;
		if (!text) return;
		for (const entry of splitter.push(text)) {
			if (entryMatches(entry, worker)) write(formatEntry(entry));
		}
	};

	tick();
	setInterval(tick, POLL_MS);
	if (!options.sessionId) {
		setInterval(() => {
			const next = newestTeamLog();
			if (next && next !== path) open(next, false);
		}, SESSION_CHECK_MS);
	}
	// Runs until the user closes it.
	return await new Promise<number>(() => {});
}
