/**
 * Watch tabs: each worker's live activity in a terminal tab of its own.
 *
 * `/watch` opens one by hand. With `/watch auto` on, a tab opens by itself the
 * first time a worker starts a job in this cline, so the manager's chat stays a
 * conversation and the workers' commands and output stay out of it. The
 * setting is kept across runs in `~/.cline/watch-tabs.json`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TeamProgressUpdate } from "../runtime/session-events";
import { openInNewTerminal } from "../utils/open-terminal";

function preferencePath(): string {
	return path.join(os.homedir(), ".cline", "watch-tabs.json");
}

export function readWatchTabsAuto(): boolean {
	try {
		const file = preferencePath();
		if (!existsSync(file)) return false;
		return (
			(JSON.parse(readFileSync(file, "utf8")) as { auto?: unknown }).auto ===
			true
		);
	} catch {
		return false;
	}
}

export function writeWatchTabsAuto(auto: boolean): void {
	const file = preferencePath();
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify({ auto }, null, 2)}\n`, "utf8");
}

export function openWatchTab(
	sessionId: string | undefined,
	worker?: string,
): ReturnType<typeof openInNewTerminal> {
	return openInNewTerminal(worker ? `cline: ${worker}` : "cline: workers", [
		"watch",
		...(worker ? [worker] : []),
		...(sessionId ? ["--session", sessionId] : []),
	]);
}

/** Workers that already got a tab from this cline, so each gets only one. */
const autoOpened = new Set<string>();

/** Open a worker's tab when it starts its first job, if `/watch auto` is on. */
export function autoOpenWatchTab(update: TeamProgressUpdate): void {
	const { lifecycle } = update;
	if (lifecycle.eventType !== "run_started" || !lifecycle.agentId) return;
	const key = `${update.sessionId}:${lifecycle.agentId}`;
	if (autoOpened.has(key) || !readWatchTabsAuto()) return;
	autoOpened.add(key);
	openWatchTab(update.sessionId, lifecycle.agentId);
}
