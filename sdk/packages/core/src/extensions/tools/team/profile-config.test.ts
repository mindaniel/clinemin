import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadProfiles,
	resolveProfileStorePath,
	resolveWorkerConnection,
	writeProfiles,
} from "./profile-config";

/**
 * `resolveClineDir` reads `CLINE_DIR`, so each test gets its own store rather
 * than the developer's real one — which would otherwise be read, and in the
 * write test overwritten, by running the suite.
 */
let dir: string;
let previous: string | undefined;

beforeEach(() => {
	previous = process.env.CLINE_DIR;
	dir = mkdtempSync(join(tmpdir(), "cline-profiles-"));
	process.env.CLINE_DIR = dir;
});

afterEach(() => {
	if (previous === undefined) {
		delete process.env.CLINE_DIR;
	} else {
		process.env.CLINE_DIR = previous;
	}
	rmSync(dir, { recursive: true, force: true });
});

function writeStore(text: string): void {
	const path = resolveProfileStorePath();
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text, "utf8");
}

describe("loadProfiles", () => {
	it("treats a missing store as no profiles, not as an error", () => {
		const loaded = loadProfiles();
		expect(loaded.profiles).toEqual([]);
		expect(loaded.error).toBeUndefined();
	});

	it("reports a store that exists but does not parse", () => {
		writeStore("{ broken");
		const loaded = loadProfiles();
		expect(loaded.error).toBeDefined();
		expect(loaded.profiles).toEqual([]);
	});
});

describe("resolveWorkerConnection", () => {
	it("gives two workers on one provider two different Chrome logins", () => {
		// This is the whole feature: same providerId, different credential.
		writeProfiles({
			profiles: [
				{
					name: "deepseek-work",
					providerId: "deepseek-web",
					browserProfile: "work",
				},
				{
					name: "deepseek-personal",
					providerId: "deepseek-web",
					browserProfile: "personal",
				},
			],
		});

		const first = resolveWorkerConnection({
			agentId: "a",
			profile: "deepseek-work",
		});
		const second = resolveWorkerConnection({
			agentId: "b",
			profile: "deepseek-personal",
		});

		expect(first.providerId).toBe("deepseek-web");
		expect(second.providerId).toBe("deepseek-web");
		expect(first.browserProfile).toBe("work");
		expect(second.browserProfile).toBe("personal");
		expect(first.warning).toBeUndefined();
		expect(second.warning).toBeUndefined();
	});

	it("lets the profile supersede the worker's own provider", () => {
		writeProfiles({
			profiles: [{ name: "pinned", providerId: "qwen-web", modelId: "qwen3" }],
		});
		const resolved = resolveWorkerConnection({
			agentId: "a",
			profile: "pinned",
			providerId: "deepseek-web",
			modelId: "deepseek-chat",
		});
		// Two answers for which account a worker uses is the failure mode; the
		// profile is the one that wins.
		expect(resolved.providerId).toBe("qwen-web");
		expect(resolved.modelId).toBe("qwen3");
	});

	it("falls back and says so when the profile is gone", () => {
		const resolved = resolveWorkerConnection({
			agentId: "reader",
			profile: "deleted",
			providerId: "kimi-web",
		});
		expect(resolved.providerId).toBe("kimi-web");
		expect(resolved.warning).toContain("deleted");
		expect(resolved.warning).toContain("reader");
	});

	it("leaves a worker with no profile exactly as it was", () => {
		const resolved = resolveWorkerConnection({
			agentId: "a",
			providerId: "grok-web",
			modelId: "grok-4",
		});
		expect(resolved).toEqual({ providerId: "grok-web", modelId: "grok-4" });
	});

	it("omits what the profile does not set", () => {
		// Spread over the lead's config, so an undefined key here would erase an
		// inherited value rather than leaving it alone.
		writeProfiles({
			profiles: [{ name: "bare", providerId: "anthropic" }],
		});
		const resolved = resolveWorkerConnection({ agentId: "a", profile: "bare" });
		expect(resolved).toEqual({ providerId: "anthropic" });
	});
});

describe("writeProfiles", () => {
	it("round-trips through the parser", () => {
		writeProfiles({
			profiles: [
				{
					name: "proxy",
					providerId: "anthropic",
					modelId: "claude-sonnet-4.6",
					baseUrl: "https://proxy.example.com",
					notes: "shared team key",
				},
			],
		});
		const loaded = loadProfiles();
		expect(loaded.error).toBeUndefined();
		expect(loaded.profiles).toHaveLength(1);
		expect(loaded.profiles[0]?.baseUrl).toBe("https://proxy.example.com");
	});
});
