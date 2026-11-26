import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RAW_WEB_MESSAGE_MARKER } from "@cline/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "../contexts/session-context";
import type { ChatEntry } from "../types";

/**
 * `/runbatch`: send the prompt as the first message, then each batch file as
 * its own message, and save each batch's reply next to the batch file.
 *
 * With a web provider every message carries `RAW_WEB_MESSAGE_MARKER`, so the
 * chat receives exactly the prompt or batch text: no system prompt, no tool
 * contract, no history labels.
 *
 * While batch mode is on, what the user submits fills the two panes instead
 * of going to the model: file paths (typed, pasted or dragged in, quoted or
 * not, several per line) become batches; a folder queues every batch .txt in
 * it (sub-folders too) that has no reply yet. The list is kept in file-name
 * order, so batch_0009 runs before batch_0010. A single file path while no prompt
 * is set, or any other text, becomes the prompt. `go`/`start` runs the
 * pending batches; Esc stops the current turn and pauses the run.
 *
 * The prompt opens a new chat and every batch follows in that chat. `go`
 * after a stop carries on there; `clear` (or `off`, `new`) makes the next
 * `go` open a new chat with the prompt, so the model does not reread the old
 * one. `/runbatch fresh N` also starts a new chat every N batches.
 *
 * By default (`fresh auto`) every provider stays in one chat. A web chat
 * keeps its history on the site. A local or API model is sent the whole
 * conversation every turn, but caches the part it has already read, so each
 * batch costs about its own text; that chat only grows. Once it fills
 * `AUTO_FRESH_CONTEXT_RATIO` of the model's input budget, the next batch opens
 * a new chat with the prompt instead, before compaction (about 81%) would
 * summarise the prompt away.
 */

/** Share of the model's input budget at which auto mode opens a new chat. */
export const AUTO_FRESH_CONTEXT_RATIO = 0.6;

export type BatchStatus = "pending" | "running" | "done" | "error";

export interface BatchItem {
	path: string;
	status: BatchStatus;
	outPath?: string;
	detail?: string;
}

export interface BatchPrompt {
	text: string;
	source?: string;
}

export function parsePathList(text: string): string[] {
	const out: string[] = [];
	const re = /"([^"]+)"|'([^']+)'|(\S+)/g;
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		// A whole line that is one existing path may contain spaces without quotes.
		const bare = trimmed.replace(/^["']|["']$/g, "");
		if (isFile(bare)) {
			out.push(bare);
			continue;
		}
		for (const m of trimmed.matchAll(re)) {
			out.push(m[1] ?? m[2] ?? m[3] ?? "");
		}
	}
	return out.filter(Boolean);
}

function isFile(p: string): boolean {
	try {
		return existsSync(p) && statSync(p).isFile();
	} catch {
		return false;
	}
}

function isDir(p: string): boolean {
	try {
		return existsSync(p) && statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** A reply file this runner wrote (`<stem>_reply.txt`, `_reply_2.txt` ...). */
function isReplyFile(name: string): boolean {
	return /_reply(_\d+)?\.txt$/i.test(name);
}

/**
 * The batch .txt files under a folder (recursively) that have no reply yet,
 * in file-name order: what is left to run there.
 */
export function unrepliedBatches(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		let names: string[];
		try {
			names = readdirSync(d);
		} catch {
			return;
		}
		const replied = new Set(
			names
				.filter(isReplyFile)
				.map((n) => n.replace(/_reply(_\d+)?\.txt$/i, "").toLowerCase()),
		);
		for (const n of names) {
			const full = path.join(d, n);
			if (isDir(full)) walk(full);
			else if (
				/\.txt$/i.test(n) &&
				!isReplyFile(n) &&
				!replied.has(n.replace(/\.txt$/i, "").toLowerCase())
			)
				out.push(full);
		}
	};
	walk(dir);
	return out.sort(byFileName);
}

/** Natural path order: batch_9 before batch_10, case ignored. */
export function byFileName(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** `<dir>/<stem>_reply.txt`, or `_reply_2`, `_reply_3` ... when taken. */
export function replyPathFor(batchPath: string): string {
	const dir = path.dirname(batchPath);
	const stem = path.basename(batchPath, path.extname(batchPath));
	let candidate = path.join(dir, `${stem}_reply.txt`);
	for (let n = 2; existsSync(candidate); n++) {
		candidate = path.join(dir, `${stem}_reply_${n}.txt`);
	}
	return candidate;
}

/**
 * The message as sent: verbatim-marked for web providers, plain otherwise.
 * `chatTag` (on a chat's first message) makes the web provider open a new chat
 * even though the prompt text is the same as last time.
 */
export function batchMessage(
	text: string,
	verbatim: boolean,
	chatTag?: string,
): string {
	if (!verbatim) return text.trim();
	return `${RAW_WEB_MESSAGE_MARKER}${chatTag ? `#${chatTag}` : ""}\n${text.trim()}`;
}

/**
 * A reply that is the site's usage-limit notice ("You've reached your daily
 * limit. ... check back at 12:00 AM") rather than an answer. Short replies
 * only, so a batch whose answer mentions limits is not mistaken for one.
 */
export function isLimitNotice(reply: string): boolean {
	const t = reply.trim();
	return (
		t.length > 0 &&
		t.length < 600 &&
		/(reached|hit) (your|the) [\w .-]{0,40}limit|usage limit|daily limit/i.test(
			t,
		)
	);
}

/** Assistant text written after `marker` (an entry object in the list). */
export function replyAfter(entries: ChatEntry[], marker: ChatEntry): string {
	// appendEntry stores a copy (it stamps the mode), so match by kind and text
	// too; the newest match wins when a batch is run again.
	const same = (e: ChatEntry) =>
		e === marker ||
		(e.kind === marker.kind &&
			"text" in e &&
			"text" in marker &&
			e.text === marker.text);
	let start = entries.length - 1;
	while (start >= 0 && !same(entries[start] as ChatEntry)) start--;
	if (start < 0) return "";
	return entries
		.slice(start + 1)
		.filter(
			(e): e is Extract<ChatEntry, { kind: "assistant_text" }> =>
				e.kind === "assistant_text",
		)
		.map((e) => e.text.trim())
		.filter(Boolean)
		.join("\n\n");
}

export function useBatchRunner(input: {
	/** Runs one turn with `text` and resolves when it has finished. */
	runTurnRef: { current: ((text: string) => Promise<void>) | null };
	setChatView: () => void;
	/** Web provider: send messages verbatim (no system prompt or labels). */
	verbatim: boolean;
	/** Start a new chat (what /clear does). */
	newChat: () => Promise<void>;
	/** The model's input budget in tokens, when known (not used on web chats). */
	maxInputTokens?: number;
}) {
	const session = useSession();
	const [enabled, setEnabled] = useState(false);
	const [prompt, setPrompt] = useState<BatchPrompt | null>(null);
	const [batches, setBatches] = useState<BatchItem[]>([]);
	const [running, setRunning] = useState(false);

	const entriesRef = useRef(session.entries);
	entriesRef.current = session.entries;
	const abortRef = useRef(session.abortRequested);
	abortRef.current = session.abortRequested;
	const promptRef = useRef(prompt);
	promptRef.current = prompt;
	const batchesRef = useRef(batches);
	batchesRef.current = batches;
	const runningRef = useRef(false);
	const stopRef = useRef(false);
	// The prompt text already sent as this chat's first message.
	const promptSentRef = useRef<string | null>(null);
	// New chat every N batches (0 = one chat); batches sent in the current chat.
	// `null` is auto: one chat, renewed when it nears the context limit.
	const [freshOverride, setFreshEvery] = useState<number | null>(null);
	const freshEvery = freshOverride ?? 0;
	const autoRef = useRef(true);
	autoRef.current = freshOverride === null;
	const contextRef = useRef({ used: 0, max: input.maxInputTokens });
	contextRef.current = {
		used: session.lastTotalTokens,
		max: input.maxInputTokens,
	};
	const freshEveryRef = useRef(freshEvery);
	freshEveryRef.current = freshEvery;
	const inChatRef = useRef(0);

	const note = useCallback(
		(text: string) => session.appendEntry({ kind: "status", text }),
		[session],
	);

	const update = useCallback((p: string, patch: Partial<BatchItem>) => {
		setBatches((list) =>
			list.map((b) => (b.path === p ? { ...b, ...patch } : b)),
		);
	}, []);

	const addBatches = useCallback((paths: string[]) => {
		setBatches((old) => {
			// Finished rows make way once new files come in; a file dropped
			// again is queued again.
			const want = new Set(paths.map((p) => p.toLowerCase()));
			const list = old.some(
				(b) => b.status === "pending" || b.status === "running",
			)
				? old
				: [];
			const kept = list.map((b) =>
				want.has(b.path.toLowerCase()) && b.status !== "running"
					? { path: b.path, status: "pending" as const }
					: b,
			);
			const have = new Set(kept.map((b) => b.path.toLowerCase()));
			const fresh = paths
				.filter((p) => !have.has(p.toLowerCase()))
				.map((p): BatchItem => ({ path: p, status: "pending" }));
			return [...kept, ...fresh].sort((a, b) => byFileName(a.path, b.path));
		});
	}, []);

	/** Forget the prompt, the batches and the chat they went to. */
	const reset = useCallback(() => {
		stopRef.current = true;
		setBatches([]);
		setPrompt(null);
		promptSentRef.current = null;
		inChatRef.current = 0;
	}, []);

	const start = useCallback(async () => {
		if (runningRef.current) return;
		const p = promptRef.current;
		if (!p?.text.trim()) {
			note(
				"/runbatch: set the prompt first (type or paste it, or drag the prompt .txt in).",
			);
			return;
		}
		if (!batchesRef.current.some((b) => b.status === "pending")) {
			note("/runbatch: no pending batches. Drag batch files in first.");
			return;
		}
		runningRef.current = true;
		stopRef.current = false;
		setRunning(true);
		let done = 0;
		try {
			// One chat until clear/off/new: `go` after a stop carries on in it.
			// `fresh N` also starts a new chat (prompt again) every N batches.
			for (;;) {
				const item = batchesRef.current.find((b) => b.status === "pending");
				if (!item || stopRef.current) break;
				const every = freshEveryRef.current;
				const { used, max } = contextRef.current;
				const contextFull =
					autoRef.current &&
					!input.verbatim &&
					inChatRef.current > 0 &&
					typeof max === "number" &&
					max > 0 &&
					used >= max * AUTO_FRESH_CONTEXT_RATIO;
				if (contextFull) {
					note(
						`/runbatch: context at ${Math.round((used / max) * 100)}%, starting a new chat with the prompt.`,
					);
				}
				if (
					promptSentRef.current === null ||
					promptSentRef.current !== p.text ||
					(every > 0 && inChatRef.current >= every) ||
					contextFull
				) {
					await input.newChat();
					input.setChatView();
					inChatRef.current = 0;
					const first = input.runTurnRef.current;
					if (!first) break;
					const promptMarker: ChatEntry = {
						kind: "status",
						text: `/runbatch ▶ new chat, sending the prompt (${new Date().toLocaleTimeString()})`,
					};
					session.appendEntry(promptMarker);
					await first(
						batchMessage(p.text, input.verbatim, Date.now().toString(36)),
					);
					if (abortRef.current) {
						note(
							"/runbatch: stopped (Esc) before the batch. Type go to carry on.",
						);
						break;
					}
					await new Promise((r) => setTimeout(r, 300));
					const ack = replyAfter(entriesRef.current, promptMarker);
					if (isLimitNotice(ack)) {
						// The prompt was refused, so the next go sends it again.
						note(
							`/runbatch: stopped, the usage limit is reached ("${ack.trim()}"). Type go once it resets.`,
						);
						break;
					}
					promptSentRef.current = p.text;
				}
				const runTurn = input.runTurnRef.current;
				if (!runTurn) break;
				update(item.path, { status: "running" });
				let content: string;
				try {
					content = await readFile(item.path, "utf8");
				} catch (e) {
					update(item.path, { status: "error", detail: String(e) });
					continue;
				}
				const name = path.basename(item.path);
				const marker: ChatEntry = {
					kind: "status",
					text: `/runbatch ▶ ${name} (${done + 1} of ${batchesRef.current.filter((b) => b.status !== "done").length})`,
				};
				session.appendEntry(marker);
				try {
					await runTurn(batchMessage(content, input.verbatim));
					inChatRef.current++;
				} catch (e) {
					update(item.path, { status: "error", detail: String(e) });
					break;
				}
				// let the last streamed entries reach state
				await new Promise((r) => setTimeout(r, 300));
				const reply = replyAfter(entriesRef.current, marker);
				if (abortRef.current) {
					update(item.path, { status: "pending" });
					note(
						"/runbatch: stopped (Esc). Type go to carry on from this batch.",
					);
					break;
				}
				if (isLimitNotice(reply)) {
					update(item.path, { status: "pending" });
					note(
						`/runbatch: stopped, the usage limit is reached ("${reply.trim()}"). ${name} is still pending; type go once it resets.`,
					);
					break;
				}
				if (!reply) {
					// An empty reply is what a spent daily limit (or a dropped
					// connection) looks like when the site sends no notice text.
					// Stop rather than burn through the rest of the list.
					update(item.path, { status: "pending" });
					note(
						`/runbatch: stopped, ${name} got no reply text (usage limit or connection). It is still pending; type go to try again (after the limit resets).`,
					);
					break;
				}
				const out = replyPathFor(item.path);
				try {
					await writeFile(out, `${reply}\n`, "utf8");
					update(item.path, { status: "done", outPath: out });
					note(
						`/runbatch ✓ ${name} → ${path.basename(out)} (${reply.length} chars)`,
					);
					done++;
				} catch (e) {
					update(item.path, { status: "error", detail: String(e) });
				}
			}
		} finally {
			runningRef.current = false;
			setRunning(false);
			const left = batchesRef.current.filter(
				(b) => b.status === "pending",
			).length;
			note(`/runbatch: ${done} saved this run, ${left} pending.`);
		}
	}, [input, note, session, update]);

	/** `/runbatch [on|off|start|stop|clear|prompt|retry]`. */
	const handleCommand = useCallback(
		(arg: string) => {
			const a = arg.trim().toLowerCase();
			if (a === "off" || (a === "" && enabled)) {
				reset();
				setEnabled(false);
				note(
					"/runbatch: off; prompt and batch list cleared. Messages go to the model as usual.",
				);
				return;
			}
			if (a === "on" || a === "") {
				if (!runningRef.current) reset();
				setEnabled(true);
				input.setChatView();
				note(
					"/runbatch: on. Type or paste the prompt (or drag its .txt), then drag the batch files in and press Enter. Type go to run, /runbatch off to leave.",
				);
				return;
			}
			if (a === "start" || a === "go") {
				void start();
				return;
			}
			if (a === "stop" || a === "pause") {
				stopRef.current = true;
				note("/runbatch: will stop after the current batch.");
				return;
			}
			if (a === "clear" || a === "reset") {
				if (runningRef.current) return note("/runbatch: stop the run first.");
				reset();
				note(
					"/runbatch: prompt and batch list cleared. Paste the prompt, drag the batches in, then go: it opens a new chat.",
				);
				return;
			}
			if (a === "new") {
				if (runningRef.current) return note("/runbatch: stop the run first.");
				promptSentRef.current = null;
				note("/runbatch: the next batch starts a new chat with the prompt.");
				return;
			}
			if (a === "fresh auto") {
				setFreshEvery(null);
				note(
					`/runbatch: auto (one chat${input.verbatim ? "" : `, a new one with the prompt at ${AUTO_FRESH_CONTEXT_RATIO * 100}% context`}).`,
				);
				return;
			}
			const fm = /^fresh(?:\s+(\d+))?$/.exec(a);
			if (fm) {
				const n = fm[1] === undefined ? 1 : Number(fm[1]);
				setFreshEvery(n);
				note(
					n === 0
						? "/runbatch: one chat for the whole run (the prompt is sent once)."
						: `/runbatch: new chat with the prompt every ${n === 1 ? "batch" : `${n} batches`}.`,
				);
				return;
			}
			if (a === "prompt") {
				setPrompt(null);
				note(
					"/runbatch: prompt cleared; the next text or file you enter becomes the prompt.",
				);
				return;
			}
			if (a === "retry") {
				setBatches((l) =>
					l.map((b) =>
						b.status === "error" ? { ...b, status: "pending" } : b,
					),
				);
				return;
			}
			note("/runbatch on|off|go|stop|clear|new|fresh [N|auto]|prompt|retry");
		},
		[enabled, input, note, reset, start],
	);

	/** Input submitted while batch mode is on. Returns true when consumed. */
	const handleInput = useCallback(
		(text: string): boolean => {
			if (!enabled) return false;
			const t = text.trim();
			if (!t) return true;
			if (/^(go|start|run)$/i.test(t)) {
				void start();
				return true;
			}
			if (/^(clear|reset|off|stop|new|fresh(\s+(\d+|auto))?)$/i.test(t)) {
				handleCommand(t);
				return true;
			}
			if (runningRef.current) {
				note("/runbatch: a run is in progress. /runbatch stop pauses it.");
				return true;
			}
			const listed = parsePathList(t);
			// Only when every word is a path, so prompt text that happens to
			// contain "." or a folder name is still taken as the prompt.
			const dirs = listed.filter(isDir);
			if (dirs.length > 0 && listed.every((p) => isDir(p) || isFile(p))) {
				const found = dirs.flatMap(unrepliedBatches);
				note(
					found.length
						? `/runbatch: ${found.length} batch file(s) with no reply queued from ${dirs.map((d) => path.basename(d)).join(", ")}.`
						: `/runbatch: every batch in ${dirs.map((d) => path.basename(d)).join(", ")} has a reply.`,
				);
				if (found.length) addBatches(found);
				if (dirs.length === listed.length) return true;
			}
			const paths =
				dirs.length > 0 && listed.every((p) => isDir(p) || isFile(p))
					? listed.filter((p) => !isDir(p))
					: listed;
			const allFiles = paths.length > 0 && paths.every(isFile);
			if (allFiles) {
				if (!promptRef.current && paths.length === 1) {
					const src = paths[0] as string;
					void readFile(src, "utf8").then(
						(body) => setPrompt({ text: body, source: src }),
						(e) => note(`/runbatch: could not read ${src}: ${e}`),
					);
					return true;
				}
				addBatches(paths);
				return true;
			}
			if (paths.length > 0 && paths.some(isFile)) {
				const missing = paths.filter((p) => !isFile(p));
				note(`/runbatch: not found: ${missing.join(", ")}`);
				addBatches(paths.filter(isFile));
				return true;
			}
			setPrompt({ text: t });
			return true;
		},
		[addBatches, enabled, handleCommand, note, start],
	);

	// Esc during a turn pauses the whole run, not just that batch.
	useEffect(() => {
		if (session.abortRequested && runningRef.current) stopRef.current = true;
	}, [session.abortRequested]);

	return {
		enabled,
		prompt,
		batches,
		running,
		freshEvery,
		freshAuto: freshOverride === null,
		handleCommand,
		handleInput,
	};
}

export type BatchRunner = ReturnType<typeof useBatchRunner>;
