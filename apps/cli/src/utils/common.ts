import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeEnv } from "@cline/shared";
import { displayName, version } from "../../package.json";

export function getCliBuildInfo(): RuntimeEnv {
	return {
		name: displayName,
		version,
		platform: "terminal",
		platform_version: process.version,
		os_type: os.platform(),
		os_version: os.version(),
	};
}

/**
 * Walk up from this module's location until a `.git` directory is found. This
 * works both for a development run (`bun run cli` from a git checkout) and a
 * built bundle, and returns `undefined` when the CLI is installed from a
 * non-git source (npm global install, etc.) where there is no repository.
 */
function resolveRepoRoot(): string | undefined {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 12; i++) {
		if (existsSync(join(dir, ".git"))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
	return undefined;
}

/**
 * A short, human-readable fingerprint of the checked-out source: the git
 * short hash, current branch (when it's not a detached HEAD), and a `-dirty`
 * suffix when there are uncommitted changes. This is what lets you tell at a
 * glance whether two machines are on the exact same code — the package.json
 * version stays the same across commits, but this changes with every commit.
 *
 * Example: `5f32ec260@web-provider-turn-plumbing-dirty`.
 *
 * Returns an empty string when git isn't available or there's no repository,
 * so callers can fall back to the plain package version.
 */
export function resolveBuildFingerprint(): string {
	const root = resolveRepoRoot();
	if (!root) {
		return "";
	}
	try {
		const hash = execFileSync(
			"git",
			["-C", root, "rev-parse", "--short", "HEAD"],
			{ encoding: "utf8", windowsHide: true },
		).trim();
		if (!hash) {
			return "";
		}

		let branch = "";
		try {
			branch = execFileSync(
				"git",
				["-C", root, "branch", "--show-current"],
				{ encoding: "utf8", windowsHide: true },
			).trim();
		} catch {
			// Detached HEAD or not on a branch — omit the branch part.
		}

		let dirty = false;
		try {
			dirty =
				execFileSync("git", ["-C", root, "status", "--porcelain"], {
					encoding: "utf8",
					windowsHide: true,
				}).trim().length > 0;
		} catch {
			// If we can't check status, assume clean.
		}

		const base = branch ? `${hash}@${branch}` : hash;
		return dirty ? `${base}-dirty` : base;
	} catch {
		return "";
	}
}

/**
 * The user-facing version string: the package version, plus the git
 * fingerprint when one is available. `cline version`, `--version`, and
 * `doctor` use this so different machines/builds are distinguishable.
 */
export function getCliDisplayVersion(): string {
	const fingerprint = resolveBuildFingerprint();
	return fingerprint ? `${version} (${fingerprint})` : version;
}
