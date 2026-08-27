/**
 * Registry of Chrome instances the web providers launched themselves, so the
 * CLI can shut them down when it exits.
 *
 * The browser-driven providers (deepseek-web-v2, qwen-web, chatgpt-web,
 * claude-web, gemini-web) spawn Chrome `detached` with `unref()`, which is
 * deliberate: the launch is slow and a mid-turn CLI crash should not take the
 * logged-in session with it. The cost is that the browser outlives the CLI and
 * keeps holding its `--remote-debugging-port`, so the next run either attaches
 * to a stale browser or has to be cleared by hand.
 *
 * So the ownership is tracked instead. Only browsers WE spawned are registered:
 * when `ensureCdp` finds the debug port already up it attaches to a browser
 * someone else owns and registers nothing, so a Chrome the user started is
 * never killed by us.
 *
 * Local model runtimes (llamacpp) are deliberately NOT registered — killing one
 * on exit would throw away a multi-gigabyte model load that the next run wants
 * back. Only browsers are cheap enough to restart.
 */

import { execFile } from "node:child_process";
import { processGlobal } from "./process-global";

export interface LaunchedBrowser {
	/** Provider that spawned it, for the shutdown report. */
	providerId: string;
	pid: number;
	debugPort: number;
}

// Process-wide: the provider that spawns is a different copy of `@cline/llms`
// than the CLI that shuts down. See `process-global.ts`.
const state = () =>
	processGlobal("browserProcesses", () => ({
		launched: new Map<number, LaunchedBrowser>(),
	}));

/** Record a Chrome this process spawned, so exit can shut it down. */
export function registerLaunchedBrowser(browser: LaunchedBrowser): void {
	if (!browser.pid) return;
	state().launched.set(browser.pid, browser);
}

/** Forget one (e.g. it exited on its own). */
export function unregisterLaunchedBrowser(pid: number): void {
	state().launched.delete(pid);
}

/** Everything currently owned by this process. */
export function listLaunchedBrowsers(): LaunchedBrowser[] {
	return [...state().launched.values()];
}

function killTree(pid: number): Promise<void> {
	return new Promise((resolve) => {
		if (process.platform === "win32") {
			// Chrome is a process tree (browser + renderers + GPU). `/T` takes the
			// children with it; without it the renderers linger as orphans.
			execFile(
				"taskkill",
				["/pid", String(pid), "/T", "/F"],
				{ windowsHide: true },
				() => resolve(),
			);
			return;
		}
		try {
			// `detached: true` made the child a process-group leader, so the
			// negative pid signals the whole group.
			process.kill(-pid, "SIGTERM");
		} catch {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				// Already gone.
			}
		}
		resolve();
	});
}

/**
 * Shut down every browser this process launched and clear the registry.
 * Returns the ones it tried to kill, so the caller can say what it closed.
 *
 * Best effort by design: a browser the user already closed, or one whose kill
 * is refused, must not stop the CLI from exiting.
 */
export async function shutdownLaunchedBrowsers(): Promise<LaunchedBrowser[]> {
	const slot = state();
	const browsers = [...slot.launched.values()];
	slot.launched.clear();
	await Promise.all(browsers.map((browser) => killTree(browser.pid)));
	return browsers;
}
