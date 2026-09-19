import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveBunExecutable } from "@cline/shared/node";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = fileURLToPath(
	new URL("../../../scripts/compact-session.ts", import.meta.url),
);
const FIXTURE_DIRECTORY = fileURLToPath(
	new URL("../../../fixtures/session", import.meta.url),
);

function runScript(strategy: "agentic" | "basic") {
	// Resolved rather than spawned by name: on Windows the `bun` on PATH is an
	// npm `.cmd` shim, which CreateProcess cannot execute, and the ENOENT that
	// follows reads as "bun is not installed".
	const bun = resolveBunExecutable();
	if (!bun) {
		return undefined;
	}
	return spawnSync(
		bun,
		[
			"--conditions=development",
			"run",
			SCRIPT_PATH,
			FIXTURE_DIRECTORY,
			"--strategy",
			strategy,
			"--provider",
			"anthropic",
			"--model",
			"claude-sonnet-4-6",
		],
		{
			encoding: "utf8",
			env: { ...process.env, ANTHROPIC_API_KEY: "" },
			timeout: 20_000,
			windowsHide: true,
		},
	);
}

describe("test:compaction script", () => {
	it("allows provider metadata for basic compaction without an API key", () => {
		const result = runScript("basic");
		if (!result) {
			console.warn("skipping: no spawnable bun executable found");
			return;
		}

		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).toContain("Running basic compaction");
		expect(result.stderr).not.toContain("Missing API key");
	}, 30_000);

	it("still requires an API key for agentic compaction", () => {
		const result = runScript("agentic");
		if (!result) {
			console.warn("skipping: no spawnable bun executable found");
			return;
		}

		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Missing API key in ANTHROPIC_API_KEY");
	}, 30_000);
});
