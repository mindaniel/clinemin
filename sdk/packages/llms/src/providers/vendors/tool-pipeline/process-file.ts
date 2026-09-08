/**
 * Cross-PROCESS state for the web-provider tool pipeline.
 *
 * `process-global.ts` solves a different problem: two copies of `@cline/llms`
 * inside ONE process. It does not help when the writer and the reader are two
 * processes, which is the normal case in a running CLI:
 *
 *   - the TUI process runs the slash commands (`/paste`, `/findchat`, `/note`);
 *   - `session-runtime.ts` starts sessions with `backendMode: "auto"`, which
 *     prefers an already-running hub daemon, so `@cline/agents` and the web
 *     providers execute in the HUB process.
 *
 * Anything a slash command set on `globalThis` was therefore invisible to the
 * provider that had to act on it, silently — the same failure mode
 * `process-global.ts` describes, one layer up. So state that crosses that
 * boundary goes in a small JSON file under the cline dir instead.
 *
 * Best effort, exactly like `browser-claims.ts`: a missing or corrupt file
 * reads as "nothing set", and a failed write degrades to in-process-only
 * behaviour rather than throwing in the middle of a turn.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Same resolution the CLI uses (see apps/cli/src/commands/config.ts). */
function clineDir(): string {
	return process.env.CLINE_DIR?.trim() || path.join(os.homedir(), ".cline");
}

/** Absolute path of a state file in the cline dir. */
export function clineStateFile(name: string): string {
	return path.join(clineDir(), name);
}

/** Parsed contents of `file`, or `undefined` when missing/unreadable/corrupt. */
export function readStateFile<T>(file: string): T | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!parsed || typeof parsed !== "object") return undefined;
		return parsed as T;
	} catch {
		return undefined;
	}
}

/** Write `value` to `file`, creating the directory. Never throws. */
export function writeStateFile(file: string, value: unknown): void {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
	} catch {
		// Callers keep their in-memory copy; only the other process loses out.
	}
}

/** Remove `file` if it exists. Never throws. */
export function deleteStateFile(file: string): void {
	try {
		fs.rmSync(file, { force: true });
	} catch {
		// Nothing to do: a stale file is re-checked on the next read.
	}
}
