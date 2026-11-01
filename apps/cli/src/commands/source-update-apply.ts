/**
 * Second half of the source-checkout auto-update (the first half, building
 * the update on the side, is `source-auto-update.ts`): swap the staged build
 * into the checkout at launch, before any other CLI module is loaded.
 *
 * Only Node builtins here: `index.ts` runs this ahead of everything else, so
 * nothing the swap replaces can already be in memory. It swaps only when no
 * other cline is running (no live hub: a hub also carries `--zen` sessions
 * after their CLI exits), so it never changes files under someone's work.
 * When it can't swap it does nothing; the update waits for a later launch.
 */

import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isMainThread } from "node:worker_threads";

const SDK_REBUILD_TIMEOUT_MS = 15 * 60_000;

export interface AutoUpdateState {
	lastCheckAt?: number;
	runningSince?: number;
	/** Upstream commit built in the staging worktree, waiting for a swap. */
	staged?: { commit: string; short: string };
	error?: string;
}

export function resolveCliClineDir(argv: string[] = process.argv): string {
	const flag = argv.indexOf("--config");
	const fromFlag = flag >= 0 ? argv[flag + 1]?.trim() : undefined;
	return fromFlag || process.env.CLINE_DIR?.trim() || join(homedir(), ".cline");
}

export function autoUpdateStateFile(clineDir: string): string {
	return join(clineDir, "auto-update.json");
}

export function stagingWorktreeDir(clineDir: string): string {
	return join(clineDir, "update-stage");
}

export function readUpdateState(file: string): AutoUpdateState {
	try {
		return JSON.parse(readFileSync(file, "utf-8")) as AutoUpdateState;
	} catch {
		return {};
	}
}

export function writeUpdateState(file: string, state: AutoUpdateState): void {
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(state));
	} catch {
		// Best-effort: a missing state file only means an extra check.
	}
}

export function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 120_000,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		windowsHide: true,
	}).trim();
}

/**
 * Run bun: this process's own runtime when it is bun (a `bun` on PATH is
 * often a .cmd shim that spawn cannot start without a shell), else PATH.
 */
export function runBun(cwd: string, args: string[], timeout?: number): void {
	const own = Boolean(process.versions.bun);
	execFileSync(own ? process.execPath : "bun", args, {
		cwd,
		stdio: "ignore",
		timeout,
		shell: !own && process.platform === "win32",
		windowsHide: true,
	});
}

/** Root of the git checkout this CLI runs from, when it runs from source. */
export function sourceCheckoutRoot(): string | undefined {
	const root = resolve(import.meta.dir, "..", "..", "..", "..");
	return existsSync(join(root, ".git")) &&
		existsSync(join(root, "sdk", "packages"))
		? root
		: undefined;
}

function isAlive(pid: unknown): boolean {
	if (typeof pid !== "number" || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Whether a hub (and so possibly a cline window or `--zen` run) is alive. */
export function isHubRunning(clineDir: string): boolean {
	const dataDir = process.env.CLINE_DATA_DIR?.trim() || join(clineDir, "data");
	const owners = join(dataDir, "locks", "hub", "owners");
	try {
		return readdirSync(owners).some((name) => {
			if (!name.endsWith(".json")) return false;
			try {
				const { pid } = JSON.parse(readFileSync(join(owners, name), "utf-8"));
				return isAlive(pid);
			} catch {
				return false;
			}
		});
	} catch {
		return false;
	}
}

const isLockfile = (file: string) =>
	/(^|\/)(package\.json|bun\.lock)$/.test(file);

/**
 * Fast-forward `root` to the staged commit and copy in its SDK build.
 * Returns the short hash applied, or undefined when it left things as they
 * were (nothing staged, other cline running, local edits in the way).
 */
export function applyStagedUpdate(
	root: string,
	clineDir: string,
): string | undefined {
	const stateFile = autoUpdateStateFile(clineDir);
	const state = readUpdateState(stateFile);
	const staged = state.staged;
	if (!staged) return undefined;
	if (isHubRunning(clineDir)) return undefined;

	const stage = stagingWorktreeDir(clineDir);
	const head = git(root, ["rev-parse", "HEAD"]);
	if (head === staged.commit) {
		writeUpdateState(stateFile, { ...state, staged: undefined });
		return undefined;
	}
	try {
		git(root, ["merge-base", "--is-ancestor", head, staged.commit]);
	} catch {
		// Local commits on top: the staged build no longer fits this checkout.
		writeUpdateState(stateFile, { ...state, staged: undefined });
		return undefined;
	}
	// Uncommitted SDK edits are in the current dist/; the staged one lacks them.
	if (
		git(root, [
			"status",
			"--porcelain",
			"--",
			"sdk",
			"package.json",
			"bun.lock",
		])
	) {
		return undefined;
	}
	if (git(stage, ["rev-parse", "HEAD"]) !== staged.commit) return undefined;

	try {
		// Refuses on its own when uncommitted edits touch the incoming files.
		git(root, ["merge", "--ff-only", "--quiet", staged.commit]);
	} catch {
		return undefined;
	}
	const changed = git(root, ["diff", "--name-only", head, "HEAD"]).split("\n");
	if (changed.some(isLockfile)) {
		runBun(root, ["install"]);
	}
	const packagesDir = join(stage, "sdk", "packages");
	for (const pkg of readdirSync(packagesDir)) {
		const built = join(packagesDir, pkg, "dist");
		if (!existsSync(built)) continue;
		const target = join(root, "sdk", "packages", pkg, "dist");
		rmSync(target, { recursive: true, force: true });
		cpSync(built, target, { recursive: true });
	}
	writeUpdateState(stateFile, {
		...state,
		staged: undefined,
		error: undefined,
	});
	return staged.short;
}

/** Written by `bun run build:sdk`: the commit `dist/` was built from. */
export function sdkBuildStampFile(root: string): string {
	return join(root, "sdk", "packages", "shared", "dist", ".source-commit");
}

export interface SdkBuildCheck {
	stale: boolean;
	/** Dependencies may have moved too, so `bun install` must run first. */
	reinstall: boolean;
}

/**
 * Whether `dist/` is behind the checkout, as it is after a plain `git pull`.
 * Files changed since the stamp only count when newer than it: a commit of
 * edits that were already built changes nothing, while a pull rewrites them.
 * Uncommitted edits never count, so working on the SDK never triggers a build.
 */
export function checkSdkBuild(root: string): SdkBuildCheck {
	const stampFile = sdkBuildStampFile(root);
	if (!existsSync(stampFile)) return { stale: true, reinstall: true };
	const stamp = readFileSync(stampFile, "utf-8").trim();
	if (stamp === git(root, ["rev-parse", "HEAD"])) {
		return { stale: false, reinstall: false };
	}
	const builtAt = statSync(stampFile).mtimeMs;
	let changed: string[];
	try {
		changed = git(root, ["diff", "--name-only", stamp, "HEAD"])
			.split("\n")
			.filter(
				(file) =>
					file && (file.startsWith("sdk/packages/") || isLockfile(file)),
			)
			.filter((file) => {
				const path = join(root, file);
				return !existsSync(path) || statSync(path).mtimeMs > builtAt;
			});
	} catch {
		// The stamped commit is gone (rebase, gc): nothing says what it holds.
		return { stale: true, reinstall: true };
	}
	return { stale: changed.length > 0, reinstall: changed.some(isLockfile) };
}

/**
 * Rebuild a stale `dist/` before the CLI loads it. A build behind the source
 * fails at module load (`Export named ... not found`), which takes every
 * command down with it, `cline update` too, so only this can repair it.
 */
export function rebuildStaleSdk(root: string): void {
	const lock = `${sdkBuildStampFile(root)}.lock`;
	mkdirSync(dirname(lock), { recursive: true });
	try {
		mkdirSync(lock);
	} catch {
		const age = Date.now() - statSync(lock).mtimeMs;
		if (age < SDK_REBUILD_TIMEOUT_MS) {
			// Another launch is building: wait, then load what it built.
			process.stderr.write("Waiting for the SDK rebuild to finish…\n");
			const sleeper = new Int32Array(new SharedArrayBuffer(4));
			while (
				existsSync(lock) &&
				Date.now() - statSync(lock).mtimeMs < SDK_REBUILD_TIMEOUT_MS
			) {
				Atomics.wait(sleeper, 0, 0, 500);
			}
			return;
		}
		// Left behind by a killed build.
	}
	try {
		const { stale, reinstall } = checkSdkBuild(root);
		if (!stale) return;
		process.stderr.write("SDK build is out of date, rebuilding…\n");
		if (reinstall) runBun(root, ["install"], SDK_REBUILD_TIMEOUT_MS);
		runBun(root, ["run", "build:sdk"], SDK_REBUILD_TIMEOUT_MS);
	} catch {
		process.stderr.write(
			`SDK rebuild failed. Run "bun install" and "bun run build:sdk" in ${root} to see why.\n`,
		);
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

/** `index.ts` calls this after any swap; never throws. */
export function rebuildStaleSdkAtLaunch(): void {
	try {
		if (!isMainThread) return;
		if (process.env.CLINE_RUN_AS_HUB_DAEMON === "1") return;
		if (process.env.CLINE_NO_AUTO_UPDATE === "1") return;
		const root = sourceCheckoutRoot();
		if (root && checkSdkBuild(root).stale) rebuildStaleSdk(root);
	} catch {
		// Best-effort: launch the version already on disk.
	}
}

/** `index.ts` calls this first thing; never throws, never blocks on network. */
export function applyStagedUpdateAtLaunch(): void {
	try {
		if (!isMainThread) return;
		if (process.env.CLINE_RUN_AS_HUB_DAEMON === "1") return;
		if (process.env.CLINE_NO_AUTO_UPDATE === "1") return;
		const clineDir = resolveCliClineDir();
		if (!readUpdateState(autoUpdateStateFile(clineDir)).staged) return;
		const root = sourceCheckoutRoot();
		if (!root) return;
		const applied = applyStagedUpdate(root, clineDir);
		if (applied) process.stderr.write(`Cline updated to ${applied}\n`);
	} catch {
		// Best-effort: launch the version already on disk.
	}
}
