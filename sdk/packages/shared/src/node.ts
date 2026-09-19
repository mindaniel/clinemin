import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { stripUtf8Bom } from "./parse/string";

type ReadFileSyncPath = Parameters<typeof readFileSync>[0];
type ReadFilePath = Parameters<typeof readFile>[0];

/** Read a UTF-8 text file and remove its optional leading byte order mark. */
export function readFileSyncStrippingUtf8Bom(path: ReadFileSyncPath): string {
	return stripUtf8Bom(readFileSync(path, "utf8"));
}

/** Read a UTF-8 text file and remove its optional leading byte order mark. */
export async function readFileStrippingUtf8Bom(
	path: ReadFilePath,
): Promise<string> {
	return stripUtf8Bom(await readFile(path, "utf8"));
}

/**
 * The path to a `bun` this process can actually spawn.
 *
 * `spawnSync("bun", ...)` works on POSIX and fails on Windows, because the
 * `bun` on PATH there is `bun.cmd` — an npm shim — and `CreateProcess` cannot
 * execute a `.cmd`. The failure is `ENOENT`, which reads as "bun is not
 * installed" rather than "bun is not spawnable by that name", so tests that do
 * it have been failing on Windows in a way that looks like a broken machine.
 *
 * `shell: true` would also fix the lookup and is the wrong tool here: one of
 * these call sites passes a multi-line script to `bun -e`, and routing that
 * through cmd.exe mangles it. Resolving the real executable keeps the argv
 * exact.
 *
 * Returns undefined when no spawnable bun is found, so a caller can skip
 * rather than fail — a machine without bun should not turn the suite red.
 */
export function resolveBunExecutable(): string | undefined {
	// Already running under bun (`bun test`, or vitest launched by bun with bun
	// as the runtime): that binary is spawnable by definition.
	if (/^bun(\.exe)?$/i.test(basename(process.execPath))) {
		return process.execPath;
	}

	const names = process.platform === "win32" ? ["bun.exe"] : ["bun"];
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		for (const name of names) {
			const candidate = join(dir, name);
			if (isExecutableFile(candidate)) {
				return candidate;
			}
		}
	}

	// npm installs bun as a `.cmd` shim next to the real binary, which lives
	// inside the package. Only the shim is on PATH, so the loop above misses it.
	for (const candidate of npmGlobalBunPaths()) {
		if (isExecutableFile(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function isExecutableFile(candidate: string): boolean {
	if (!existsSync(candidate)) {
		return false;
	}
	if (process.platform === "win32") {
		return true;
	}
	try {
		accessSync(candidate, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function npmGlobalBunPaths(): string[] {
	const binary = process.platform === "win32" ? "bun.exe" : "bun";
	const roots =
		process.platform === "win32"
			? [
					join(
						process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
						"npm",
					),
				]
			: ["/usr/local", "/usr", join(homedir(), ".npm-global")];
	return roots.map((root) => join(root, "node_modules", "bun", "bin", binary));
}
