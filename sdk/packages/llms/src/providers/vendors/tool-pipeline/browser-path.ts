/**
 * Locate a Chromium-family browser for the browser-driven web providers.
 *
 * All five (deepseek-web-v2, qwen-web, chatgpt-web, claude-web, gemini-web)
 * drive their chat over CDP, so any Chromium build works — the provider only
 * needs `--remote-debugging-port` and a profile directory, and Edge, Brave, and
 * Chromium all accept those exactly as Chrome does.
 *
 * Chrome is tried first because it is what users on these providers usually
 * have logged in, and the profile directory is per-provider anyway. Edge is the
 * important fallback: it ships with Windows, so a machine without Chrome
 * almost certainly still has a usable browser and the provider should not fail
 * outright.
 *
 * Each provider keeps its own explicit override (`chromePath` in its config, or
 * its `*_CHROME_PATH` env var), which is checked before this and lets a user
 * point at any build they like.
 */

import fs from "node:fs";
import path from "node:path";

/** A browser we found, with the name to use when reporting what we launched. */
export interface FoundBrowser {
	name: string;
	executablePath: string;
}

function windowsCandidates(
	vendor: string,
	product: string,
	exe: string,
): string[] {
	const roots = [
		process.env.PROGRAMFILES,
		process.env["PROGRAMFILES(X86)"],
		process.env.LOCALAPPDATA,
	];
	return roots
		.filter((root): root is string => Boolean(root))
		.map((root) => path.join(root, vendor, product, "Application", exe));
}

/**
 * Candidates in preference order. Chrome first, then Edge (present on every
 * Windows install), then the other Chromium builds.
 */
function candidates(): FoundBrowser[] {
	const entries: FoundBrowser[] = [];
	const add = (name: string, paths: string[]) => {
		for (const executablePath of paths) {
			entries.push({ name, executablePath });
		}
	};

	add("Chrome", [
		...windowsCandidates("Google", "Chrome", "chrome.exe"),
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
	]);
	add("Edge", [
		...windowsCandidates("Microsoft", "Edge", "msedge.exe"),
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		"/usr/bin/microsoft-edge",
		"/usr/bin/microsoft-edge-stable",
	]);
	add("Brave", [
		...windowsCandidates("BraveSoftware", "Brave-Browser", "brave.exe"),
		"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
		"/usr/bin/brave-browser",
	]);
	add("Chromium", [
		...windowsCandidates("Chromium", "Chromium", "chrome.exe"),
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
	]);

	return entries;
}

/** The first installed Chromium-family browser, or `undefined` if none is. */
export function findBrowser(): FoundBrowser | undefined {
	return candidates().find((entry) => fs.existsSync(entry.executablePath));
}

/**
 * Path of the first installed Chromium-family browser.
 *
 * Named for Chrome because that is what the providers' config key and env vars
 * are called, but it resolves Edge and the other Chromium builds too.
 */
export function findChromePath(): string | undefined {
	return findBrowser()?.executablePath;
}

/**
 * Launch flag that keeps Edge from signing a profile into the Windows account.
 *
 * Edge signs every new `--user-data-dir` into the OS user's Microsoft account
 * on its own, so each provider profile showed that same account however many
 * profiles were made, and looked like one browser. The chat sites' logins
 * were separate all along; this only stops the browser-level sign-in (and the
 * sign-in Edge offers after a login on a Microsoft site). Chrome and the other
 * builds ignore feature names they do not know.
 */
export const NO_BROWSER_SIGNIN_ARG =
	"--disable-features=msImplicitSignin,msSeamlessWebToBrowserSignIn,msEnableWebToBrowserSignIn";

/**
 * Message for the case where nothing is installed. Takes the provider's own
 * config path and env var so the user is told exactly which knob to set.
 */
export function browserNotFoundMessage(
	configPath: string,
	envVar: string,
): string {
	return (
		"Could not find a Chromium-based browser (tried Chrome, Edge, Brave, Chromium). " +
		`Install one, or set chromePath in ${configPath} or ${envVar} to point at its executable.`
	);
}
