import {
	describeProfile,
	isValidProfileName,
	isWebChatProvider,
	type Profile,
	shortProviderName,
} from "@cline/shared";
import type { SearchableItem } from "../searchable-list";

/**
 * Rows that are commands rather than profiles.
 *
 * `+` cannot appear in a profile name (see `PROFILE_NAME_PATTERN`), so these
 * can never collide with one — the same guarantee the workers dialog relies on,
 * and for the same reason: a command and a name sharing one key is a bug you
 * only find by naming something unluckily.
 */
export const ROW_ADD = "+add";
export const ROW_SAVE = "+save";
export const ROW_BACK = "+back";
export const ROW_INHERIT = "+inherit";
export const ROW_NEW_CHROME = "+new-chrome";
export const ROW_NO_CHROME = "+no-chrome";

export const ACTION_PROVIDER = "+provider";
export const ACTION_MODEL = "+model";
export const ACTION_CHROME = "+chrome";
export const ACTION_NOTES = "+notes";
export const ACTION_RENAME = "+rename";
export const ACTION_DELETE = "+delete";

/**
 * Where the dialog is.
 *
 * `name: null` in the provider/model/chrome steps means the wizard is adding a
 * profile rather than editing one, and the partial choices ride along on the
 * step so there is no draft state that can drift from what is on screen.
 */
export type ProfilesStep =
	| { kind: "list" }
	| { kind: "actions"; name: string }
	| { kind: "provider"; name: string | null }
	| { kind: "model"; name: string | null; providerId: string }
	| {
			kind: "chrome";
			name: string | null;
			providerId: string;
			modelId?: string;
	  }
	| {
			kind: "newChrome";
			name: string | null;
			providerId: string;
			modelId?: string;
	  }
	| {
			kind: "name";
			providerId: string;
			modelId?: string;
			browserProfile?: string;
	  }
	| { kind: "notes"; name: string }
	| { kind: "rename"; name: string }
	| { kind: "delete"; name: string };

/**
 * A name derived from the provider and the Chrome login, made unique.
 *
 * `deepseek-work` reads better than `deepseek-2` and says what actually differs
 * between the two profiles. The suffix is dropped when it is the stock login,
 * because `deepseek-default` is noise.
 */
export function suggestProfileName(options: {
	providerId: string;
	browserProfile?: string;
	taken: string[];
}): string {
	const base = shortProviderName(options.providerId);
	const suffix =
		options.browserProfile && options.browserProfile !== "default"
			? `-${options.browserProfile}`
			: "";
	const seed = isValidProfileName(`${base}${suffix}`)
		? `${base}${suffix}`
		: "profile";
	if (!options.taken.includes(seed)) {
		return seed;
	}
	for (let n = 2; n < 1000; n++) {
		const candidate = `${seed}-${n}`;
		if (!options.taken.includes(candidate)) {
			return candidate;
		}
	}
	return `${seed}-${Date.now()}`;
}

/**
 * Does this provider authenticate with a Chrome login rather than a key?
 *
 * Only web providers do, and offering the step for the rest would suggest an
 * API profile could be separated by browser, which it cannot — two API profiles
 * on one provider are told apart by `apiKey`, edited in `profiles.json`.
 */
export function usesBrowserLogin(providerId: string): boolean {
	return isWebChatProvider(providerId);
}

export function buildProfileRows(
	profiles: Profile[],
	dirty: boolean,
): SearchableItem[] {
	return [
		...profiles.map((profile) => ({
			key: profile.name,
			label: describeProfile(profile),
			section: "Profiles",
			searchText: `${profile.name} ${profile.providerId} ${profile.modelId ?? ""} ${profile.browserProfile ?? ""} ${profile.notes ?? ""}`,
		})),
		{
			key: ROW_ADD,
			label: "Add a profile...",
			section: "Actions",
			searchText: "add new profile",
		},
		{
			key: ROW_SAVE,
			label: dirty ? "Save changes" : "Save changes (nothing changed)",
			section: "Actions",
			searchText: "save",
		},
	];
}

export function buildProfileActionRows(profile: Profile): SearchableItem[] {
	const rows: SearchableItem[] = [
		{
			key: ACTION_PROVIDER,
			label: `Provider: ${profile.providerId}`,
			searchText: "provider",
		},
		{
			key: ACTION_MODEL,
			label: `Model: ${profile.modelId ?? "provider's default"}`,
			searchText: "model",
		},
	];
	if (usesBrowserLogin(profile.providerId)) {
		rows.push({
			key: ACTION_CHROME,
			label: `Chrome login: ${profile.browserProfile ?? "the session's"}`,
			searchText: "chrome browser login account profile",
		});
	}
	rows.push(
		{
			key: ACTION_NOTES,
			label: `Notes: ${profile.notes ?? "(none)"}`,
			searchText: "notes",
		},
		{ key: ACTION_RENAME, label: "Rename...", searchText: "rename" },
		{ key: ACTION_DELETE, label: "Remove this profile", searchText: "delete" },
		{ key: ROW_BACK, label: "Back", searchText: "back" },
	);
	return rows;
}

export function buildProviderRows(
	providerIds: string[],
	currentProviderId: string | undefined,
): SearchableItem[] {
	return providerIds.map((providerId) => ({
		key: providerId,
		label:
			providerId === currentProviderId ? `${providerId} (current)` : providerId,
		section: "Provider",
		searchText: `${providerId} ${shortProviderName(providerId)}`,
	}));
}

export function buildModelRows(
	modelIds: string[],
	currentModelId: string | undefined,
): SearchableItem[] {
	return [
		{
			key: ROW_INHERIT,
			label:
				currentModelId === undefined
					? "Let the provider decide (current)"
					: "Let the provider decide",
			section: "Model",
			searchText: "inherit default",
		},
		...modelIds.map((modelId) => ({
			key: modelId,
			label: modelId === currentModelId ? `${modelId} (current)` : modelId,
			section: "Model",
			searchText: modelId,
		})),
	];
}

/**
 * The Chrome logins to choose from.
 *
 * A login already spoken for by another profile ON THE SAME PROVIDER is marked
 * rather than hidden. Reusing one is occasionally what you want — two profiles
 * on one login, differing only by model — but doing it by accident is the exact
 * failure this whole feature exists to prevent, so it has to be visible at the
 * moment of choosing.
 */
export function buildChromeRows(options: {
	browserProfiles: string[];
	providerId: string;
	current?: string;
	takenBy: Map<string, string>;
}): SearchableItem[] {
	return [
		{
			key: ROW_NO_CHROME,
			label:
				options.current === undefined
					? "Use the session's Chrome login (current)"
					: "Use the session's Chrome login",
			section: "Chrome login",
			searchText: "session default inherit none",
		},
		...options.browserProfiles.map((name) => {
			const owner = options.takenBy.get(name);
			const marks = [
				name === options.current ? "current" : undefined,
				owner && owner !== options.current
					? `already used by ${owner}`
					: undefined,
			].filter(Boolean);
			return {
				key: name,
				label: marks.length > 0 ? `${name} (${marks.join(", ")})` : name,
				section: "Chrome login",
				searchText: name,
			};
		}),
		{
			key: ROW_NEW_CHROME,
			label: "New Chrome login...",
			section: "Chrome login",
			searchText: "new create add chrome login account",
		},
	];
}

/**
 * Which profile already claims each Chrome login, for a given provider.
 *
 * Keyed per provider because the browser-profile store is provider-independent:
 * one login named `work` means a separate user-data-dir for EVERY web provider,
 * so `deepseek` on `work` and `qwen` on `work` are different browsers and do
 * not collide.
 */
export function browserLoginOwners(
	profiles: Profile[],
	providerId: string,
	excludeName?: string,
): Map<string, string> {
	const owners = new Map<string, string>();
	for (const profile of profiles) {
		if (profile.name === excludeName) continue;
		if (profile.providerId !== providerId) continue;
		if (!profile.browserProfile) continue;
		if (!owners.has(profile.browserProfile)) {
			owners.set(profile.browserProfile, profile.name);
		}
	}
	return owners;
}

export function applyProvider(profile: Profile, providerId: string): Profile {
	if (profile.providerId === providerId) {
		return profile;
	}
	// The model comes from the old provider's catalog and is not valid for the
	// new one; keeping it would fail at spawn time instead of here. The Chrome
	// login is dropped for a provider that has no browser, where the field would
	// be silently ignored and read as a credential that is not really set.
	const { modelId: _model, browserProfile: _chrome, ...rest } = profile;
	return {
		...rest,
		providerId,
		...(usesBrowserLogin(providerId) && profile.browserProfile
			? { browserProfile: profile.browserProfile }
			: {}),
	};
}

export function applyModel(
	profile: Profile,
	modelId: string | undefined,
): Profile {
	if (modelId === undefined) {
		const { modelId: _dropped, ...rest } = profile;
		return rest;
	}
	return { ...profile, modelId };
}

export function applyBrowserProfile(
	profile: Profile,
	browserProfile: string | undefined,
): Profile {
	if (browserProfile === undefined) {
		const { browserProfile: _dropped, ...rest } = profile;
		return rest;
	}
	return { ...profile, browserProfile };
}

export function applyNotes(profile: Profile, notes: string): Profile {
	const trimmed = notes.replace(/\s+/g, " ").trim();
	if (!trimmed) {
		const { notes: _dropped, ...rest } = profile;
		return rest;
	}
	return { ...profile, notes: trimmed };
}

export function buildProfile(options: {
	name: string;
	providerId: string;
	modelId?: string;
	browserProfile?: string;
}): Profile {
	return {
		name: options.name,
		providerId: options.providerId,
		...(options.modelId === undefined ? {} : { modelId: options.modelId }),
		...(options.browserProfile === undefined
			? {}
			: { browserProfile: options.browserProfile }),
	};
}

export type NameResult =
	| { ok: true; name: string }
	| { ok: false; error: string };

/**
 * Validate a profile name against the store.
 *
 * `from` is the name being replaced, so a rename that keeps the same name is
 * not reported as a collision with itself.
 */
export function validateProfileName(
	profiles: Profile[],
	raw: string,
	from?: string,
): NameResult {
	const name = raw.trim();
	if (!name) {
		return { ok: false, error: "A profile needs a name." };
	}
	if (!isValidProfileName(name)) {
		return {
			ok: false,
			error: "Only letters, digits, dot, underscore and hyphen.",
		};
	}
	if (name !== from && profiles.some((profile) => profile.name === name)) {
		return { ok: false, error: `There is already a profile called ${name}.` };
	}
	return { ok: true, name };
}

/**
 * Rename a profile.
 *
 * Returns the workers that still point at the old name so the caller can say
 * so. The roster is a separate file this dialog does not own, and a rename that
 * silently orphans three workers — dropping them back onto the lead's account,
 * which is the one thing profiles exist to prevent — is worse than one that
 * says what it broke.
 */
export function renameProfile(
	profiles: Profile[],
	from: string,
	to: string,
): Profile[] {
	return profiles.map((profile) =>
		profile.name === from ? { ...profile, name: to } : profile,
	);
}
