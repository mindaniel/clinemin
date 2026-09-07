/**
 * Cross-process claims on the web providers' DevTools ports.
 *
 * `browser-processes.ts` tracks the browsers THIS process launched, which is
 * enough to clean up after a single CLI. It is not enough once two `cline`
 * sessions run side by side:
 *
 *   - Terminal A runs a manager on chatgpt-web and delegates to deepseek. A
 *     launches Chrome for both, so both are registered as A's.
 *   - Terminal B starts on deepseek. `ensureCdp` finds port 9222 already up,
 *     attaches to A's browser and registers nothing, because B did not launch
 *     it and must never kill a browser it does not own.
 *   - Ctrl+C in A shuts down everything A launched — including the browser B is
 *     in the middle of a turn on. From the user's side, closing one session
 *     closed every browser.
 *
 * Ownership alone cannot answer "is anyone else still using this?", because the
 * answer lives in another process. So each session records a claim on every
 * port it drives — launched or attached — in one small JSON file, and a browser
 * is killed on exit only when the last live claim on its port is gone.
 *
 * Best effort by design. The file is advisory: a stale entry from a crashed
 * session is pruned by liveness check, and any read or write failure degrades
 * to the old behaviour rather than blocking an exit.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { processGlobal } from "./process-global";

const CLAIMS_FILE = path.join(os.homedir(), ".cline", "browser-claims.json");

/** `{ "9222": [1234, 5678] }` — DevTools port to the pids driving it. */
type ClaimsFile = Record<string, number[]>;

/** Ports this process has claimed, so exit knows what to release. */
const state = () =>
	processGlobal("browserClaims", () => ({ ports: new Set<number>() }));

function isPidAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	try {
		// Signal 0 checks for existence without delivering anything.
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to someone else, which
		// still counts as alive. Only ESRCH means gone.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readClaims(): ClaimsFile {
	try {
		const raw = fs.readFileSync(CLAIMS_FILE, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}
		const claims: ClaimsFile = {};
		for (const [port, pids] of Object.entries(parsed as ClaimsFile)) {
			if (Array.isArray(pids)) {
				claims[port] = pids.filter((pid) => typeof pid === "number");
			}
		}
		return claims;
	} catch {
		// Missing or corrupt: start from empty rather than failing a turn.
		return {};
	}
}

function writeClaims(claims: ClaimsFile): void {
	try {
		fs.mkdirSync(path.dirname(CLAIMS_FILE), { recursive: true });
		fs.writeFileSync(CLAIMS_FILE, JSON.stringify(claims), "utf8");
	} catch {
		// A session that cannot record its claim behaves like one that never
		// claimed: it still cleans up its own browsers on exit.
	}
}

/** Drop pids whose process is gone, and ports left with no claim at all. */
function pruneDead(claims: ClaimsFile): ClaimsFile {
	const pruned: ClaimsFile = {};
	for (const [port, pids] of Object.entries(claims)) {
		const live = pids.filter(isPidAlive);
		if (live.length > 0) pruned[port] = live;
	}
	return pruned;
}

/**
 * Record that this process is driving the browser on `port`.
 *
 * Called from BOTH branches of every provider's `ensureCdp` — the one that
 * launches Chrome and the one that attaches to a Chrome already up — because
 * the attach case is exactly the one the old ownership-only tracking missed.
 * Repeat calls are free.
 */
export function claimBrowserPort(port: number): void {
	if (!port) return;
	if (state().ports.has(port)) return;
	state().ports.add(port);
	const claims = pruneDead(readClaims());
	const key = String(port);
	const pids = claims[key] ?? [];
	if (!pids.includes(process.pid)) pids.push(process.pid);
	claims[key] = pids;
	writeClaims(claims);
}

/**
 * Release every claim this process holds and report which ports are now free.
 *
 * A port comes back only when no other LIVE session still claims it, so a
 * browser another terminal is mid-turn on is never in the returned set.
 */
export function releaseBrowserClaims(): Set<number> {
	const mine = state().ports;
	state().ports = new Set();
	if (mine.size === 0) return new Set();

	const claims = pruneDead(readClaims());
	const free = new Set<number>();
	for (const port of mine) {
		const key = String(port);
		const remaining = (claims[key] ?? []).filter((pid) => pid !== process.pid);
		if (remaining.length === 0) {
			delete claims[key];
			free.add(port);
		} else {
			claims[key] = remaining;
		}
	}
	writeClaims(claims);
	return free;
}
