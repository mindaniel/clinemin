import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Profile, ProfileConnection } from "@cline/shared";
import {
	PROFILES_FILENAME,
	parseProfileStore,
	profileConnection,
	stripUtf8Bom,
} from "@cline/shared";
import { resolveClineDir } from "@cline/shared/storage";

export interface ProfileLoadResult {
	profiles: Profile[];
	/** Absolute path the store lives at, whether or not it exists yet. */
	path: string;
	/** Human-readable problem with the file that was found, if any. */
	error?: string;
}

/**
 * Where profiles live.
 *
 * User-global only, unlike the roster, which also searches the workspace. A
 * profile can hold an API key, and a workspace-local file is one `git add -A`
 * away from being published. The roster is safe to keep in a repo precisely
 * because it names profiles rather than carrying their credentials — that split
 * is the point of the abstraction.
 */
export function resolveProfileStorePath(): string {
	return join(resolveClineDir(), PROFILES_FILENAME);
}

/**
 * Load every profile.
 *
 * A missing store is not an error — profiles are opt-in, and a worker with no
 * profile behaves exactly as it did before they existed. A store that exists
 * but does not parse *is* reported: silently ignoring it would start workers on
 * the wrong accounts with no indication why.
 */
export function loadProfiles(): ProfileLoadResult {
	const path = resolveProfileStorePath();
	if (!existsSync(path)) {
		return { profiles: [], path };
	}
	let text: string;
	try {
		text = stripUtf8Bom(readFileSync(path, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { profiles: [], path, error: `Could not read ${path}: ${message}` };
	}
	const parsed = parseProfileStore(text);
	if (!parsed.ok) {
		return { profiles: [], path, error: `${path}: ${parsed.error}` };
	}
	return { profiles: parsed.store.profiles, path };
}

export function findProfile(name: string | undefined): Profile | undefined {
	if (!name?.trim()) {
		return undefined;
	}
	const wanted = name.trim();
	return loadProfiles().profiles.find((profile) => profile.name === wanted);
}

/**
 * Write the store back.
 *
 * Permissions are tightened the same way `ProviderSettingsManager` tightens
 * `providers.json`, and for the same reason: this file may hold API keys. It is
 * best-effort — Windows has no POSIX mode bits — but the cost is a syscall and
 * the alternative is a world-readable key file on every Unix install.
 */
export function writeProfiles(options: {
	path?: string;
	profiles: Profile[];
}): void {
	const path = options.path ?? resolveProfileStorePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`${JSON.stringify({ version: 1, profiles: options.profiles }, null, 2)}\n`,
		"utf8",
	);
	try {
		chmodSync(path, 0o600);
	} catch {
		// Ignore — Windows does not support POSIX chmod.
	}
}

export interface ResolvedWorkerConnection extends Partial<ProfileConnection> {
	/**
	 * Why this worker is not on the profile it names, when that happened.
	 *
	 * A deleted profile falls back to the worker's own provider rather than
	 * refusing to start: a team that will not spawn is worse than one running on
	 * the lead's account. But it must say so — silently sharing an account is
	 * exactly the failure profiles exist to prevent.
	 */
	warning?: string;
}

/**
 * The connection overrides a worker should run with.
 *
 * A named profile supersedes the worker's own `providerId`/`modelId` rather
 * than merging with them, so there is never a question of which account is in
 * play. The legacy fields are the answer only when no profile is named, or when
 * the named one has since been deleted.
 */
export function resolveWorkerConnection(worker: {
	agentId?: string;
	profile?: string;
	providerId?: string;
	modelId?: string;
}): ResolvedWorkerConnection {
	const legacy = () => {
		const connection: ResolvedWorkerConnection = {};
		if (worker.providerId !== undefined)
			connection.providerId = worker.providerId;
		if (worker.modelId !== undefined) connection.modelId = worker.modelId;
		return connection;
	};
	if (!worker.profile?.trim()) {
		return legacy();
	}
	const profile = findProfile(worker.profile);
	if (!profile) {
		return {
			...legacy(),
			warning: `Profile "${worker.profile}" is not in ${resolveProfileStorePath()}${
				worker.providerId
					? `; ${worker.agentId ?? "the worker"} fell back to ${worker.providerId}.`
					: `; ${worker.agentId ?? "the worker"} fell back to the lead's provider.`
			}`,
		};
	}
	return profileConnection(profile);
}
