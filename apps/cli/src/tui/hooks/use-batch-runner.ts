import { existsSync, statSync } from "node:fs";
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
 * not, several per line) become batches; a single file path while no prompt
 * is set, or any other text, becomes the prompt. `go`/`start` runs the
 * pending batches; Esc stops the current turn and pauses the run.
 */

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

/** The message as sent: verbatim-marked for web providers, plain otherwise. */
export function batchMessage(text: string, verbatim: boolean): string {
	return verbatim ? `${RAW_WEB_MESSAGE_MARKER}\n${text.trim()}` : text.trim();
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
		setBatches((list) => {
			const have = new Set(list.map((b) => b.path.toLowerCase()));
			const fresh = paths
				.filter((p) => !have.has(p.toLowerCase()))
				.map((p): BatchItem => ({ path: p, status: "pending" }));
			return [...list, ...fresh];
		});
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
			if (promptSentRef.current !== p.text) {
				const runTurn = input.runTurnRef.current;
				if (!runTurn) return;
				note("/runbatch ▶ sending the prompt");
				await runTurn(batchMessage(p.text, input.verbatim));
				if (abortRef.current) {
					note(
						"/runbatch: stopped (Esc) before the batches. Type go to start again.",
					);
					return;
				}
				promptSentRef.current = p.text;
			}
			for (;;) {
				const item = batchesRef.current.find((b) => b.status === "pending");
				if (!item || stopRef.current) break;
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
				if (!reply) {
					update(item.path, { status: "error", detail: "empty reply" });
					note(`/runbatch: ${name}: no reply text, nothing saved.`);
					continue;
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
	}, [input.runTurnRef, input.verbatim, note, session, update]);

	/** `/runbatch [on|off|start|stop|clear|prompt|retry]`. */
	const handleCommand = useCallback(
		(arg: string) => {
			const a = arg.trim().toLowerCase();
			if (a === "off" || (a === "" && enabled)) {
				stopRef.current = true;
				setEnabled(false);
				note("/runbatch: off. Messages go to the model as usual.");
				return;
			}
			if (a === "on" || a === "") {
				setEnabled(true);
				promptSentRef.current = null;
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
			if (a === "clear") {
				if (runningRef.current) return note("/runbatch: stop the run first.");
				setBatches([]);
				setPrompt(null);
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
			note("/runbatch on|off|go|stop|clear|prompt|retry");
		},
		[enabled, input, note, start],
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
			if (runningRef.current) {
				note("/runbatch: a run is in progress. /runbatch stop pauses it.");
				return true;
			}
			const paths = parsePathList(t);
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
		[addBatches, enabled, note, start],
	);

	// Esc during a turn pauses the whole run, not just that batch.
	useEffect(() => {
		if (session.abortRequested && runningRef.current) stopRef.current = true;
	}, [session.abortRequested]);

	return { enabled, prompt, batches, running, handleCommand, handleInput };
}

export type BatchRunner = ReturnType<typeof useBatchRunner>;
