import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceWrapperPath = fileURLToPath(
	new URL("../../bin/cline", import.meta.url),
);

function createWrapperCopy(): string {
	const dir = mkdtempSync(join(tmpdir(), "cline-bin-package-"));
	const binDir = join(dir, "bin");
	mkdirSync(binDir, { recursive: true });
	const wrapperPath = join(binDir, "cline");
	copyFileSync(sourceWrapperPath, wrapperPath);
	chmodSync(wrapperPath, 0o755);
	return wrapperPath;
}

/**
 * A target the wrapper can actually spawn, on any platform.
 *
 * The wrapper calls `spawnSync(target, argv)` with no shell, so on Windows the
 * target must be a real executable: `CreateProcess` will not run a `.js` with
 * a shebang, and will not run a `.cmd` either. `process.execPath` is a genuine
 * binary everywhere, and `-e` lets each test say what the child should do — so
 * these cases cover Windows instead of only looking like they do.
 */
function runtimeTarget(script: string): { target: string; args: string[] } {
	return { target: process.execPath, args: ["-e", script] };
}

function createExecutableScript(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "cline-bin-wrapper-"));
	const scriptPath = join(dir, "child.js");
	writeFileSync(scriptPath, `#!/usr/bin/env node\n${contents}`);
	chmodSync(scriptPath, 0o755);
	return scriptPath;
}

function runWrapper(target: string, args: string[] = []) {
	const wrapperPath = createWrapperCopy();
	return spawnSync(process.execPath, [wrapperPath, ...args], {
		env: {
			...process.env,
			CLINE_BIN_PATH: target,
		},
		encoding: "utf8",
	});
}

describe("bin/cline wrapper", () => {
	it("preserves the child process exit status", () => {
		const { target, args } = runtimeTarget("process.exit(7);");

		const result = runWrapper(target, args);

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(7);
		expect(result.signal).toBeNull();
	});

	it("passes the wrapper path to the compiled binary", () => {
		const { target, args } = runtimeTarget(
			'console.log(process.env.CLINE_WRAPPER_PATH ?? "");',
		);

		const result = runWrapper(target, args);

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toMatch(/bin[/\\]cline$/);
	});

	it.skipIf(process.platform === "win32")(
		"propagates child process signal termination on POSIX",
		() => {
			const target = createExecutableScript(`
process.kill(process.pid, "SIGTERM");
setTimeout(() => {}, 1000);
`);

			const result = runWrapper(target);

			expect(result.error).toBeUndefined();
			expect(result.status).toBeNull();
			expect(result.signal).toBe("SIGTERM");
		},
	);
});
