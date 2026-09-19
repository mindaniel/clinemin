/**
 * Named connection profiles.
 *
 * A profile is one way of talking to a model: a provider, a model, and the
 * credential that authenticates it. It exists because the credential store is
 * keyed by provider id (`providers.json` holds `providers: Record<providerId,
 * …>`), which makes "two accounts on DeepSeek" unrepresentable — and therefore
 * makes two concurrent workers on DeepSeek unrepresentable too. A roster could
 * already name two workers `deepseek` and `deepseek-2`, but both resolved to
 * the same key, so they shared one API key or, on a web provider, one Chrome
 * user-data-dir: one logged-in account, one chat, two workers writing into it.
 *
 * So profiles are keyed by a name the user chooses, not by provider. Several
 * profiles may name the same `providerId`; what makes them distinct is the
 * credential underneath.
 *
 * ## The credential is not the same thing on every provider
 *
 * On an API provider it is `apiKey` (with `baseUrl` and `headers` for a proxy
 * or a self-hosted endpoint). On a web provider there is no key at all — the
 * credential is a Chrome `--user-data-dir`, which the browser-profile store in
 * `@cline/llms` already names and assigns a distinct DevTools port to. A
 * profile therefore carries `browserProfile` for that case, and the two are not
 * alternatives to each other so much as the same field seen from two provider
 * families; a profile may set whichever its provider actually uses.
 *
 * ## What a profile does not hold
 *
 * Anything absent is inherited, not defaulted. A profile that sets only
 * `providerId` behaves exactly like selecting that provider did before this
 * existed: the key comes from `providers.json` as usual. That is what makes
 * adopting profiles one worker at a time safe.
 */

import { z } from "zod";

export const PROFILES_FILENAME = "profiles.json";

/**
 * Same character set as `agentId` in the roster.
 *
 * A profile name is typed on a command line and written into `team.json`, and
 * it is compared by exact string. Allowing spaces or quotes would make
 * `profile: "work account"` look fine and fail to match for reasons invisible
 * in the file.
 */
export const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

export const ProfileSchema = z
	.object({
		name: z
			.string()
			.min(1)
			.regex(
				PROFILE_NAME_PATTERN,
				"name may only contain letters, digits, dot, underscore and hyphen",
			)
			.describe("What this profile is called, and how a worker refers to it"),
		providerId: z
			.string()
			.min(1)
			.describe("Provider this profile talks to, e.g. deepseek-web"),
		modelId: z
			.string()
			.min(1)
			.optional()
			.describe("Model for this profile. Omit to let the provider decide."),
		apiKey: z
			.string()
			.min(1)
			.optional()
			.describe(
				"API key for this profile. Omit to use the key in providers.json.",
			),
		baseUrl: z
			.string()
			.url()
			.optional()
			.describe("Endpoint override, for a proxy or a self-hosted model."),
		headers: z
			.record(z.string(), z.string())
			.optional()
			.describe("Extra request headers."),
		/**
		 * Which Chrome login a web provider drives.
		 *
		 * Names an entry in `@cline/llms`'s browser-profile store, which owns the
		 * user-data-dir and the DevTools port. It is a name and not the paths
		 * themselves because that store also assigns the port offset, and two
		 * profiles that picked their own would silently collide — the second
		 * Chrome finds a live endpoint on the port and drives the first one's
		 * browser instead of launching.
		 */
		browserProfile: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Chrome profile this login uses, for web providers. Omit for the session's.",
			),
		reasoningEffort: z.string().min(1).optional(),
		thinking: z.boolean().optional(),
		maxTokensPerTurn: z.number().int().positive().optional(),
		temperature: z.number().optional(),
		notes: z
			.string()
			.min(1)
			.optional()
			.describe("Free text for the human reading the list."),
	})
	.strict();

export const ProfileStoreSchema = z
	.object({
		version: z.literal(1),
		profiles: z.array(ProfileSchema),
	})
	.strict()
	.superRefine((store, ctx) => {
		const seen = new Set<string>();
		for (const [index, profile] of store.profiles.entries()) {
			if (seen.has(profile.name)) {
				ctx.addIssue({
					code: "custom",
					path: ["profiles", index, "name"],
					message: `Duplicate profile name "${profile.name}"`,
				});
			}
			seen.add(profile.name);
		}
	});

export type Profile = z.infer<typeof ProfileSchema>;
export type ProfileStore = z.infer<typeof ProfileStoreSchema>;

export type ParseProfileStoreResult =
	| { ok: true; store: ProfileStore }
	| { ok: false; error: string };

/**
 * Parse the profile store.
 *
 * A result rather than a throw, for the same reason the roster parses this way:
 * a bad config file should reach the user as a message about their file, not as
 * a crash that takes the session with it.
 */
export function parseProfileStore(text: string): ParseProfileStoreResult {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			error: `${PROFILES_FILENAME} is not valid JSON: ${message}`,
		};
	}
	const parsed = ProfileStoreSchema.safeParse(raw);
	if (!parsed.success) {
		return { ok: false, error: z.prettifyError(parsed.error) };
	}
	return { ok: true, store: parsed.data };
}

export function isValidProfileName(value: string): boolean {
	return PROFILE_NAME_PATTERN.test(value);
}

/**
 * The connection fields a profile contributes to an agent.
 *
 * Deliberately only the fields a profile actually sets: it is spread over an
 * inherited config, so writing `apiKey: undefined` for a profile that has no
 * key of its own would erase the one `providers.json` supplied.
 */
export interface ProfileConnection {
	providerId: string;
	modelId?: string;
	apiKey?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
	browserProfile?: string;
	reasoningEffort?: string;
	thinking?: boolean;
	maxTokensPerTurn?: number;
	temperature?: number;
}

export function profileConnection(profile: Profile): ProfileConnection {
	const connection: ProfileConnection = { providerId: profile.providerId };
	if (profile.modelId !== undefined) connection.modelId = profile.modelId;
	if (profile.apiKey !== undefined) connection.apiKey = profile.apiKey;
	if (profile.baseUrl !== undefined) connection.baseUrl = profile.baseUrl;
	if (profile.headers !== undefined) connection.headers = profile.headers;
	if (profile.browserProfile !== undefined)
		connection.browserProfile = profile.browserProfile;
	if (profile.reasoningEffort !== undefined)
		connection.reasoningEffort = profile.reasoningEffort;
	if (profile.thinking !== undefined) connection.thinking = profile.thinking;
	if (profile.maxTokensPerTurn !== undefined)
		connection.maxTokensPerTurn = profile.maxTokensPerTurn;
	if (profile.temperature !== undefined)
		connection.temperature = profile.temperature;
	return connection;
}

/**
 * How a profile reads in a list, for a human picking one.
 *
 * The credential is described, never shown: this string goes into a TUI list
 * and, for the browser case, into the manager's prompt.
 */
export function describeProfile(profile: Profile): string {
	const parts = [profile.providerId, profile.modelId ?? "provider's default"];
	if (profile.browserProfile) {
		parts.push(`chrome:${profile.browserProfile}`);
	}
	if (profile.apiKey) {
		parts.push("own key");
	}
	if (profile.baseUrl) {
		parts.push(profile.baseUrl);
	}
	return `${profile.name} — ${parts.join(" · ")}`;
}
