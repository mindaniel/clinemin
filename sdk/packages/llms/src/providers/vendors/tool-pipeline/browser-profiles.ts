import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
	}));

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
	// The file is only the default for processes that start later; this process
	// moves because it pins itself here.
	pinBrowserProfile(name);
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
	if (store.active === name) pinBrowserProfile(DEFAULT_PROFILE_NAME);
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
