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
import {
	browserProfileDisplayName,
	getActiveBrowserProfile,
	listBrowserProfiles,
} from "./browser-profiles";

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
 * Get a profile directory ready for launch: signed out of Edge's browser
 * account (see `clearBrowserSignin`) and named after the active clinemin
 * profile, so the window title says which login it holds. Signed out, every
 * Edge profile is "Profile 1", and two providers' windows on different
 * profiles look the same.
 */
export function prepareBrowserProfile(userDataDir: string): void {
	clearBrowserSignin(userDataDir);
	try {
		const active = getActiveBrowserProfile();
		const entry = listBrowserProfiles().find((p) => p.name === active);
		nameBrowserProfile(
			userDataDir,
			entry ? browserProfileDisplayName(entry) : active,
		);
	} catch {
		// An unreadable profile store leaves the default name.
	}
}

/**
 * Set the browser's own name for a profile directory, which Chromium and Edge
 * show in the window title. Works before the first launch too: a `Local State`
 * holding only the name is filled in by the browser. Never throws.
 */
export function nameBrowserProfile(userDataDir: string, name: string): void {
	try {
		const localStatePath = path.join(userDataDir, "Local State");
		const localState = fs.existsSync(localStatePath)
			? JSON.parse(fs.readFileSync(localStatePath, "utf8"))
			: {};
		localState.profile ??= {};
		localState.profile.info_cache ??= {};
		const info = (localState.profile.info_cache.Default ??= {});
		if (info.name === name && info.is_using_default_name === false) return;
		info.name = name;
		info.is_using_default_name = false;
		fs.writeFileSync(localStatePath, JSON.stringify(localState));

		const preferencesPath = path.join(userDataDir, "Default", "Preferences");
		if (fs.existsSync(preferencesPath)) {
			const prefs = JSON.parse(fs.readFileSync(preferencesPath, "utf8"));
			prefs.profile ??= {};
			prefs.profile.name = name;
			fs.writeFileSync(preferencesPath, JSON.stringify(prefs));
		}
	} catch {
		// A locked or unreadable profile keeps its name.
	}
}

/**
 * Sign a profile directory out of the browser-level account Edge put there.
 *
 * `NO_BROWSER_SIGNIN_ARG` keeps a new profile signed out, but a profile Edge
 * signed in before that flag existed keeps the Windows account: every provider
 * profile still showed the same account, so a site could see one browser
 * identity behind several logins. This clears that account from the profile's
 * `Preferences` and `Local State` before launch; with the flag, Edge does not
 * sign it back in. Site cookies live in other files and are left alone, so the
 * chat logins survive. Call it only while no browser holds the directory (it
 * rewrites those files on exit). A no-op for a signed-out or non-Edge profile,
 * and it never throws: the worst case is the profile stays signed in.
 */
export function clearBrowserSignin(userDataDir: string): void {
	try {
		const localStatePath = path.join(userDataDir, "Local State");
		if (!fs.existsSync(localStatePath)) return;
		const localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
		const infoCache: Record<string, Record<string, unknown>> = localState
			?.profile?.info_cache ?? {};
		const signedIn = Object.entries(infoCache).filter(
			([, info]) =>
				typeof info?.user_name === "string" && info.user_name !== "",
		);
		if (signedIn.length === 0) return;

		for (const [name, info] of signedIn) {
			for (const key of Object.keys(info)) {
				if (!key.startsWith("edge_account_")) continue;
				info[key] = typeof info[key] === "number" ? 0 : "";
			}
			Object.assign(info, {
				user_name: "",
				gaia_id: "",
				gaia_name: "",
				is_consented_primary_account: false,
				use_gaia_picture: false,
			});
			clearProfilePreferences(path.join(userDataDir, name, "Preferences"));
		}
		if (localState.signin) {
			delete localState.signin.active_accounts;
			delete localState.signin.active_accounts_managed;
		}
		fs.writeFileSync(localStatePath, JSON.stringify(localState));
	} catch {
		// A locked or unreadable profile is launched as it is.
	}
}

function clearProfilePreferences(preferencesPath: string): void {
	if (!fs.existsSync(preferencesPath)) return;
	const prefs = JSON.parse(fs.readFileSync(preferencesPath, "utf8"));
	delete prefs.account_info;
	const services = prefs.google?.services;
	if (services) {
		for (const key of [
			"consented_to_sync",
			"account_id",
			"last_account_id",
			"last_username",
			"last_gaia_id",
			"last_signed_in_username",
		]) {
			delete services[key];
		}
	}
	if (prefs.edge) {
		delete prefs.edge.account_type;
		delete prefs.edge.profile_matches_os_primary_account;
		if (prefs.edge.services) delete prefs.edge.services.last_gaia_id;
	}
	if (prefs.sync) {
		delete prefs.sync.gaia_id;
		delete prefs.sync.has_setup_completed;
	}
	fs.writeFileSync(preferencesPath, JSON.stringify(prefs));
}

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
