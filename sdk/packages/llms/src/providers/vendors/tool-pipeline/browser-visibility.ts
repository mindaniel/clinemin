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
 *
 * The preference is kept per browser profile. One shared value meant a Tab in
 * a terminal on profile B also flipped profile A's Chrome in another terminal:
 * A's next turn saw the new value and restarted its hidden browser visible.
 */

import { getActiveBrowserProfile } from "./browser-profiles";
import { clineStateFile, readStateFile, writeStateFile } from "./process-file";

const PREFERENCE_FILE = "browser-headless.json";

interface PreferenceState {
	/** Pre-profile value. Still read as the fallback, never written again. */
	headless?: unknown;
	byProfile?: Record<string, unknown>;
}

function readState(): PreferenceState {
	return readStateFile<PreferenceState>(clineStateFile(PREFERENCE_FILE)) ?? {};
}

/**
 * The Tab-key preference for `profile` (default: the active one), or
 * `undefined` when never set (config.json decides).
 */
export function readHeadlessPreference(
	profile: string = getActiveBrowserProfile(),
): boolean | undefined {
	const state = readState();
	const own = state.byProfile?.[profile];
	if (typeof own === "boolean") return own;
	return typeof state.headless === "boolean" ? state.headless : undefined;
}

export function writeHeadlessPreference(
	headless: boolean,
	profile: string = getActiveBrowserProfile(),
): void {
	const state = readState();
	const byProfile =
		state.byProfile && typeof state.byProfile === "object"
			? state.byProfile
			: {};
	writeStateFile(clineStateFile(PREFERENCE_FILE), {
		...state,
		byProfile: { ...byProfile, [profile]: headless },
	});
}

/** Whether to launch Chrome hidden: the preference, else the provider's config. */
export function resolveHeadless(configHeadless: boolean): boolean {
	return readHeadlessPreference() ?? configHeadless;
}

export async function readBrowserVersion(
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
export async function closeBrowser(port: number, wsUrl: string): Promise<void> {
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
 *
 * Asks Chrome every turn (one local request) rather than remembering the last
 * answer per port: `/login` restarts the browser visible behind the
 * provider's back, and a remembered "already hidden" would keep driving that
 * window for the rest of the session.
 */
export async function closeBrowserIfModeChanged(
	port: number,
): Promise<boolean> {
	const wanted = readHeadlessPreference();
	if (wanted === undefined) return false;
	const version = await readBrowserVersion(port);
	if (!version?.wsUrl) return false; // Not running: the launch will use `wanted`.
	const running = version.userAgent.includes("HeadlessChrome");
	if (running === wanted) return false;
	await closeBrowser(port, version.wsUrl);
	return true;
}
