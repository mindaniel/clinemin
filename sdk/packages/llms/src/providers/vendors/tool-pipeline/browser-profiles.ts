import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shutdownLaunchedBrowsers } from "./browser-processes";
import { clineStateFile, readStateFile, writeStateFile } from "./process-file";
import { processGlobal } from "./process-global";

/**
 * Named Chrome profiles for the web providers.
 *
 * Every web provider drives a detached Chrome pinned to a `--user-data-dir`.
 * That directory IS the logged-in account, so one directory means one account
 * per provider. A profile here names an alternative set of those directories,
 * letting the same provider be driven with a different login by selecting a
 * different profile (`/profile` in the CLI).
 *
 * A profile is provider-independent on purpose: selecting "work" points every
 * web provider at its own `work` directory, so one choice switches the whole
 * set rather than needing five separate selections.
 *
 * Two things must vary per profile, not just the directory:
 *   - the user-data-dir, or the two Chromes would fight over one directory;
 *   - the DevTools debug port, or `connectBrowser` would find the OTHER
 *     profile's Chrome already listening and silently drive that instead.
 *
 * `DEFAULT_PROFILE_NAME` keeps the historical layout (`<configDir>/profile`
 * and the provider's stock port) so an existing install stays logged in.
 */

/**
 * Resolved per call rather than once, so a test — or a scripted run that wants
 * its own set of profiles — can point the store elsewhere via
 * `CLINE_BROWSER_PROFILES_FILE` without reloading the module.
 */
function profilesFile(): string {
	return (
		process.env.CLINE_BROWSER_PROFILES_FILE ||
		path.join(os.homedir(), ".cline", "browser-profiles.json")
	);
}

/** The profile every install starts on; maps to the pre-profiles layout. */
export const DEFAULT_PROFILE_NAME = "default";

/**
 * The profile THIS process is on, latched the first time anything asks.
 *
 * The store file holds one `active` name, but it is shared by every running
 * CLI. Without a latch, a `/profile` switch in one terminal silently moves
 * every other terminal's next turn to the new profile — the two terminals then
 * drive the same Chrome, and one terminal's message lands in the other's chat.
 *
 * So the file's `active` is only a *default for new processes*: it is read once
 * here and then frozen. `/profile` re-latches its own process explicitly, which
 * is why a switch still takes effect mid-session in the terminal that ran it.
 *
 * The latch records which store it came from, so pointing
 * `CLINE_BROWSER_PROFILES_FILE` somewhere else (tests, scripted runs) starts
 * over instead of reusing the previous store's answer.
 */
// On `globalThis`, not a module-level `let`: `@cline/llms` is loaded twice in a
// running CLI (see process-global.ts), so `/profile` would otherwise pin the
// copy the slash command sees while the providers read the other one.
const latch = () =>
	processGlobal("browserProfileLatch", () => ({
		profile: undefined as string | undefined,
		file: undefined as string | undefined,
		/** CLI session this process is driving, so `/profile` can re-pin it. */
		sessionId: undefined as string | undefined,
	}));

/**
 * The profile of the turn currently executing, when one has been scoped.
 *
 * The latch above assumes the process that ran `/profile` is the process that
 * drives Chrome. That is false whenever a hub daemon is running: sessions start
 * with `backendMode: "auto"`, so the providers execute in the HUB, which serves
 * every terminal at once. One hub means one latch, latched to whatever the
 * store said the first time any session asked — so two terminals on two
 * profiles both resolved the SAME user-data-dir and the SAME debug port, i.e.
 * one Chrome and one logged-in account. That is the bug this scope fixes.
 *
 * A per-process latch cannot express "this turn is profile A and that turn is
 * profile B" in one process. An async scope can, and it costs the seven
 * providers nothing: they call `resolveActiveProfilePaths()` with no arguments
 * from ~30 places, and every one of those runs inside the scope.
 *
 * On `globalThis` for the usual reason (two copies of `@cline/llms`, see
 * `process-global.ts`): the runtime that opens the scope and the provider that
 * reads it must share one store, or the read always misses.
 */
const profileScope = () =>
	processGlobal("browserProfileScope", () => new AsyncLocalStorage<string>());

/**
 * Run `fn` with `name` as the active profile for everything it awaits.
 *
 * `undefined` runs `fn` unscoped, falling back to the latch — that is the local
 * runtime's case, where the latch is already right.
 */
export function runWithBrowserProfile<T>(
	name: string | undefined,
	fn: () => T,
): T {
	if (!name) return fn();
	return profileScope().run(name, fn);
}

/**
 * Which profile each CLI session is on, for the process that did not choose it.
 *
 * `/profile` runs in the TUI; the provider runs in the hub. The hub needs the
 * answer per session, not per process, so the CLI writes its session's choice
 * here and the runtime reads it back when it opens the scope above. See
 * `process-file.ts`.
 *
 * `{ "01JB...": "minhnq.ctd" }` -- CLI session id to profile name.
 */
const SESSION_PROFILES_FILE = clineStateFile("browser-profile-sessions.json");

/**
 * A CLI that is killed rather than exited never clears its entry, so the file
 * is trimmed on write instead of growing without bound. `JSON.stringify` keeps
 * insertion order, so the oldest keys are the first ones.
 */
const MAX_SESSION_PROFILES = 100;

type SessionProfiles = Record<string, string>;

function readSessionProfiles(): SessionProfiles {
	const parsed = readStateFile<SessionProfiles>(SESSION_PROFILES_FILE);
	if (!parsed || Array.isArray(parsed)) return {};
	const pins: SessionProfiles = {};
	for (const [sessionId, name] of Object.entries(parsed)) {
		if (typeof name === "string" && name) pins[sessionId] = name;
	}
	return pins;
}

function writeSessionProfiles(pins: SessionProfiles): void {
	writeStateFile(
		SESSION_PROFILES_FILE,
		Object.fromEntries(Object.entries(pins).slice(-MAX_SESSION_PROFILES)),
	);
}

/**
 * Record that `sessionId` runs on `name`, and remember the session so a later
 * `/profile` switch in this process can move it without the caller having to
 * pass the id again.
 */
export function pinSessionBrowserProfile(
	sessionId: string,
	name: string,
): void {
	if (!sessionId) return;
	latch().sessionId = sessionId;
	const pins = readSessionProfiles();
	// Delete first so a re-pin moves the session to the end of the file and
	// survives the trim above, rather than ageing out while it is still running.
	delete pins[sessionId];
	pins[sessionId] = name;
	writeSessionProfiles(pins);
}

/** Forget a session's profile (it ended, or is being restarted). */
export function clearSessionBrowserProfile(sessionId: string): void {
	if (!sessionId) return;
	const slot = latch();
	if (slot.sessionId === sessionId) slot.sessionId = undefined;
	const pins = readSessionProfiles();
	if (pins[sessionId] === undefined) return;
	delete pins[sessionId];
	writeSessionProfiles(pins);
}

/** The profile `sessionId` was started on, if the CLI recorded one. */
export function getSessionBrowserProfile(
	sessionId: string | undefined,
): string | undefined {
	if (!sessionId) return undefined;
	return readSessionProfiles()[sessionId];
}

/**
 * Pins this process to `name` for the rest of its life. Call after changing the
 * active profile so the switch applies here without leaking to other terminals.
 */
export function pinBrowserProfile(name: string): void {
	const slot = latch();
	slot.profile = name;
	slot.file = profilesFile();
}

/** Drops the latch so the next read takes the store's `active` again. */
export function resetBrowserProfilePin(): void {
	const slot = latch();
	slot.profile = undefined;
	slot.file = undefined;
}

/**
 * Ports are spaced by this much per profile. The providers' stock ports are
 * consecutive (9222-9226), so a step of 1 would put profile 1's DeepSeek on
 * Qwen's port. 10 leaves room for providers added later.
 */
const PORT_STEP = 10;

export interface BrowserProfile {
	name: string;
	/**
	 * Multiplied by `PORT_STEP` and added to each provider's stock debug port.
	 * Stored rather than derived from list order so deleting a profile cannot
	 * renumber the others and strand their running Chromes.
	 */
	portOffset: number;
	createdAt: string;
}

interface ProfileStore {
	profiles: BrowserProfile[];
	/** What THIS process is on — the latch, not necessarily what the file says. */
	active: string;
	/**
	 * What the file says. Writes that are not themselves a profile switch carry
	 * this back, so adding or forgetting a profile here cannot drag another
	 * terminal's selection along with it.
	 */
	storedActive: string;
}

function defaultStore(): ProfileStore {
	return {
		profiles: [
			{
				name: DEFAULT_PROFILE_NAME,
				portOffset: 0,
				createdAt: new Date().toISOString(),
			},
		],
		active: DEFAULT_PROFILE_NAME,
		storedActive: DEFAULT_PROFILE_NAME,
	};
}

function readStore(): ProfileStore {
	let parsed: Partial<ProfileStore>;
	try {
		parsed = JSON.parse(fs.readFileSync(profilesFile(), "utf-8"));
	} catch {
		const fresh = defaultStore();
		return {
			...fresh,
			active: latchActive(fresh.profiles, fresh.active),
			storedActive: fresh.active,
		};
	}
	const profiles = Array.isArray(parsed.profiles)
		? parsed.profiles.filter(
				(entry): entry is BrowserProfile =>
					typeof entry?.name === "string" && entry.name.length > 0,
			)
		: [];
	// The default profile is implicit: it is what the pre-profiles layout used,
	// so it exists whether or not the file lists it.
	if (!profiles.some((entry) => entry.name === DEFAULT_PROFILE_NAME)) {
		profiles.unshift(defaultStore().profiles[0]);
	}
	const stored =
		typeof parsed.active === "string" &&
		profiles.some((entry) => entry.name === parsed.active)
			? parsed.active
			: DEFAULT_PROFILE_NAME;
	return {
		profiles,
		active: latchActive(profiles, stored),
		storedActive: stored,
	};
}

/**
 * The file's `active` is this process's starting profile, not a live channel
 * other terminals can push changes down. Latch it on first read; after that the
 * only thing that moves this process is `pinBrowserProfile`.
 */
function latchActive(profiles: BrowserProfile[], stored: string): string {
	// A scoped turn answers for itself and leaves the latch alone: the hub runs
	// turns for several terminals, so letting one of them latch the process
	// would hand its profile to the next terminal's turn.
	const scoped = profileScope().getStore();
	if (scoped && profiles.some((entry) => entry.name === scoped)) {
		return scoped;
	}
	const slot = latch();
	const file = profilesFile();
	if (slot.file !== file) {
		slot.profile = undefined;
		slot.file = file;
	}
	// A latched profile that has since been deleted elsewhere is no longer
	// usable, so fall back rather than resolving paths for a dead entry.
	const pinned = slot.profile;
	if (pinned && profiles.some((entry) => entry.name === pinned)) {
		return pinned;
	}
	slot.profile = stored;
	return stored;
}

function writeStore(profiles: BrowserProfile[], active: string): void {
	const file = profilesFile();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify({ profiles, active }, null, 2)}\n`);
}

/**
 * Profile names become directory names, so keep them to something a filesystem
 * and a shell both handle without quoting.
 */
export function normalizeProfileName(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
}

export function listBrowserProfiles(): BrowserProfile[] {
	return readStore().profiles;
}

export function getActiveBrowserProfile(): string {
	return readStore().active;
}

/** Throws when `name` is not a known profile, so a typo cannot silently no-op. */
export function setActiveBrowserProfile(name: string): void {
	const store = readStore();
	if (!store.profiles.some((entry) => entry.name === name)) {
		throw new Error(`Unknown browser profile "${name}".`);
	}
	writeStore(store.profiles, name);
	const sessionId = latch().sessionId;
	// The file is only the default for processes that start later; this process
	// moves because it pins itself here.
	pinBrowserProfile(name);
	// A TUI process drives one session, so the session it recorded at startup is
	// the one the user just switched. Move that too, or the switch applies only
	// to whatever runs locally and the hub keeps driving the old profile's
	// Chrome for the rest of the session.
	if (sessionId) pinSessionBrowserProfile(sessionId, name);
}

/**
 * Creates the profile if it is new and returns it either way, so calling twice
 * with the same name is not an error — it just selects the existing one.
 */
export function createBrowserProfile(rawName: string): BrowserProfile {
	const name = normalizeProfileName(rawName);
	if (!name) {
		throw new Error("Profile name must contain at least one letter or number.");
	}
	const store = readStore();
	const existing = store.profiles.find((entry) => entry.name === name);
	if (existing) return existing;

	const maxOffset = store.profiles.reduce(
		(max, entry) => Math.max(max, entry.portOffset ?? 0),
		0,
	);
	const created: BrowserProfile = {
		name,
		portOffset: maxOffset + 1,
		createdAt: new Date().toISOString(),
	};
	writeStore([...store.profiles, created], store.storedActive);
	return created;
}

/**
 * Forgets the profile. The Chrome user-data directories are left on disk: they
 * hold real logins, and deleting a list entry should not silently sign the user
 * out of five services. Selecting the name again reuses them.
 */
export function deleteBrowserProfile(name: string): void {
	if (name === DEFAULT_PROFILE_NAME) {
		throw new Error("The default profile cannot be deleted.");
	}
	const store = readStore();
	const profiles = store.profiles.filter((entry) => entry.name !== name);
	writeStore(
		profiles,
		store.storedActive === name ? DEFAULT_PROFILE_NAME : store.storedActive,
	);
	// Deleting the profile this process is on leaves it with nothing to resolve,
	// so move it home; other terminals keep their own selection.
	if (store.active === name) {
		const sessionId = latch().sessionId;
		pinBrowserProfile(DEFAULT_PROFILE_NAME);
		if (sessionId) {
			pinSessionBrowserProfile(sessionId, DEFAULT_PROFILE_NAME);
		}
	}
}

export interface ResolvedProfilePaths {
	profileName: string;
	/** Value for Chrome's `--user-data-dir`. */
	profileDir: string;
	/** Provider debug port, shifted so two profiles never share one browser. */
	debugPort: number;
	/**
	 * Per-profile chat registry. Chat ids belong to the account that created
	 * them, so a profile switch must not offer the other account's chats.
	 */
	chatsFile: string;
}

/**
 * Where the active profile puts one provider's browser state.
 *
 * `configDir` is the provider's `~/.cline/<provider>` directory and
 * `defaultDebugPort` its stock port. On the default profile both come back
 * exactly as they were before profiles existed.
 */
/**
 * Every browser-driven provider, with the debug port it uses on the default
 * profile.
 *
 * The ports live on the providers themselves; this table repeats them because
 * resetting a profile has to reach all seven directories at once, and importing
 * seven provider modules to read one constant each would drag their Chrome
 * launch machinery in with it. `browser-profiles.reset.test.ts` reads the
 * provider sources and fails if the two ever disagree, so the copy cannot rot
 * silently.
 */
export const WEB_PROVIDER_BROWSERS = [
	{ providerId: "deepseek-web-v2", defaultDebugPort: 9222 },
	{ providerId: "qwen-web", defaultDebugPort: 9223 },
	{ providerId: "chatgpt-web", defaultDebugPort: 9224 },
	{ providerId: "claude-web", defaultDebugPort: 9225 },
	{ providerId: "gemini-web", defaultDebugPort: 9226 },
	{ providerId: "kimi-web", defaultDebugPort: 9227 },
	{ providerId: "grok-web", defaultDebugPort: 9228 },
] as const;

/** Where one provider keeps its browser state under a NAMED profile. */
export interface ProfileBrowserTarget extends ResolvedProfilePaths {
	providerId: string;
}

function profileConfigDir(providerId: string): string {
	return path.join(os.homedir(), ".cline", providerId);
}

/**
 * Resolve one provider's paths for `name`, whether or not it is active.
 *
 * `resolveActiveProfilePaths` answers for the profile this process is on, which
 * is the right question at turn time and the wrong one for `/profile`, where
 * the user is pointing at a row that is usually NOT the active profile.
 */
export function resolveProfilePaths(
	name: string,
	configDir: string,
	defaultDebugPort: number,
): ResolvedProfilePaths {
	if (name === DEFAULT_PROFILE_NAME) {
		return {
			profileName: name,
			profileDir: path.join(configDir, "profile"),
			debugPort: defaultDebugPort,
			chatsFile: path.join(configDir, "chats.json"),
		};
	}
	const store = readStore();
	const entry = store.profiles.find((profile) => profile.name === name);
	const base = path.join(configDir, "profiles", name);
	return {
		profileName: name,
		profileDir: path.join(base, "profile"),
		debugPort: defaultDebugPort + (entry?.portOffset ?? 0) * PORT_STEP,
		chatsFile: path.join(base, "chats.json"),
	};
}

/** Every provider's browser state for `name`. */
export function listProfileBrowserTargets(
	name: string,
): ProfileBrowserTarget[] {
	return WEB_PROVIDER_BROWSERS.map((browser) => ({
		providerId: browser.providerId,
		...resolveProfilePaths(
			name,
			profileConfigDir(browser.providerId),
			browser.defaultDebugPort,
		),
	}));
}

/** Is something still listening on this provider's DevTools port? */
async function isDebugPortUp(port: number): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
			signal: AbortSignal.timeout(600),
		});
		return response.ok;
	} catch {
		return false;
	}
}

export interface ProfileResetResult {
	/** Directories and files actually removed. */
	removed: string[];
	/**
	 * Providers left alone because their Chrome was still listening. Deleting a
	 * live `--user-data-dir` does not sign the user out — Chrome holds the
	 * profile in memory, rewrites parts of it, and the next launch comes back on
	 * a half-written directory.
	 */
	busy: { providerId: string; debugPort: number }[];
}

/**
 * Sign a profile out of every web provider by deleting its Chrome directories.
 *
 * The `--user-data-dir` IS the login, so this is the only way to clear cookies
 * short of doing it inside each browser by hand. It is deliberately separate
 * from `deleteBrowserProfile`, which only forgets the list entry: one is "I do
 * not use this profile any more", the other is "sign me out".
 *
 * Browsers this process launched are closed first. One the user started
 * themselves is not ours to kill, so its provider is reported as busy and its
 * directory is left intact rather than corrupted.
 */
export async function resetBrowserProfileData(
	name: string,
	options: { includeChats?: boolean } = {},
): Promise<ProfileResetResult> {
	await shutdownLaunchedBrowsers();

	const removed: string[] = [];
	const busy: ProfileResetResult["busy"] = [];

	for (const target of listProfileBrowserTargets(name)) {
		if (await isDebugPortUp(target.debugPort)) {
			busy.push({
				providerId: target.providerId,
				debugPort: target.debugPort,
			});
			continue;
		}
		for (const victim of [
			target.profileDir,
			...(options.includeChats ? [target.chatsFile] : []),
		]) {
			if (!fs.existsSync(victim)) continue;
			fs.rmSync(victim, { recursive: true, force: true });
			removed.push(victim);
		}
	}

	return { removed, busy };
}

export function resolveActiveProfilePaths(
	configDir: string,
	defaultDebugPort: number,
): ResolvedProfilePaths {
	const store = readStore();
	const active =
		store.profiles.find((entry) => entry.name === store.active) ??
		store.profiles[0];

	if (active.name === DEFAULT_PROFILE_NAME) {
		return {
			profileName: active.name,
			profileDir: path.join(configDir, "profile"),
			debugPort: defaultDebugPort,
			chatsFile: path.join(configDir, "chats.json"),
		};
	}
	const base = path.join(configDir, "profiles", active.name);
	return {
		profileName: active.name,
		profileDir: path.join(base, "profile"),
		debugPort: defaultDebugPort + (active.portOffset ?? 0) * PORT_STEP,
		chatsFile: path.join(base, "chats.json"),
	};
}
