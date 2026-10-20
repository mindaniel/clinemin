/**
 * Hidden or visible Chrome for the web providers, switchable mid-session.
 *
 * Each provider's `config.json` has a `headless` flag, but it is read only
 * when Chrome is launched. The TUI's Tab key writes a preference here instead
 * (a state file, because the providers run in the hub process, see
 * `process-file.ts`). On its next turn a provider compares the running
 * browser with the preference and, when they differ, closes it so the usual
 * launch path starts it again with or without `--headless=new`. Same profile
 * directory either way, so logins and chats survive the switch.
 */

import { clineStateFile, readStateFile, writeStateFile } from "./process-file";
import { processGlobal } from "./process-global";

const PREFERENCE_FILE = "browser-headless.json";

/** The Tab-key preference, or `undefined` when never set (config.json decides). */
export function readHeadlessPreference(): boolean | undefined {
	const state = readStateFile<{ headless?: unknown }>(
		clineStateFile(PREFERENCE_FILE),
	);
	return typeof state?.headless === "boolean" ? state.headless : undefined;
}

export function writeHeadlessPreference(headless: boolean): void {
	writeStateFile(clineStateFile(PREFERENCE_FILE), { headless });
}

/** Whether to launch Chrome hidden: the preference, else the provider's config. */
export function resolveHeadless(configHeadless: boolean): boolean {
	return readHeadlessPreference() ?? configHeadless;
}

/** Last mode seen per port, so a turn only asks Chrome when the preference moved. */
const seenMode = () =>
	processGlobal("browserHeadlessByPort", () => new Map<number, boolean>());

async function readBrowserVersion(
	port: number,
): Promise<{ userAgent: string; wsUrl: string } | undefined> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
			signal: AbortSignal.timeout(800),
		});
		if (!res.ok) return undefined;
		const body = (await res.json()) as Record<string, unknown>;
		return {
			userAgent: String(body["User-Agent"] ?? body.Browser ?? ""),
			wsUrl: String(body.webSocketDebuggerUrl ?? ""),
		};
	} catch {
		return undefined;
	}
}

/** Ask Chrome to quit over CDP and wait until its debug port is gone. */
async function closeBrowser(port: number, wsUrl: string): Promise<void> {
	await new Promise<void>((resolve) => {
		const done = setTimeout(resolve, 3_000);
		try {
			const ws = new WebSocket(wsUrl);
			ws.onopen = () =>
				ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
			ws.onclose = () => {
				clearTimeout(done);
				resolve();
			};
			ws.onerror = () => {
				clearTimeout(done);
				resolve();
			};
		} catch {
			clearTimeout(done);
			resolve();
		}
	});
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline && (await readBrowserVersion(port))) {
		await new Promise((r) => setTimeout(r, 250));
	}
}

/**
 * Close the browser on `port` when its mode does not match the preference.
 * True when it was closed: the caller drops its cached connection and
 * launches again. A no-op until the preference has been set once.
 */
export async function closeBrowserIfModeChanged(
	port: number,
): Promise<boolean> {
	const wanted = readHeadlessPreference();
	if (wanted === undefined) return false;
	if (seenMode().get(port) === wanted) return false;
	const version = await readBrowserVersion(port);
	if (!version) return false; // Not running: the launch will use `wanted`.
	const running = version.userAgent.includes("HeadlessChrome");
	if (running === wanted || !version.wsUrl) {
		seenMode().set(port, running);
		return false;
	}
	await closeBrowser(port, version.wsUrl);
	seenMode().set(port, wanted);
	return true;
}
