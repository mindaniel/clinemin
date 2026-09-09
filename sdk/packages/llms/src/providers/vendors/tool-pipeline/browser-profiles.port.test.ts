import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The profile's port offset applies on top of the base port a provider picked,
 * not instead of it.
 *
 * `resolveActiveProfilePaths().debugPort` was the LAST fallback in every
 * provider's `env ?? config.json ?? profile` chain, so a `debugPort` written
 * into `~/.cline/<provider>/config.json` won outright and the offset vanished:
 * two profiles resolved one port, the second attached to the Chrome already
 * listening there, and both drove one browser and one logged-in account.
 */
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cline-profile-port-"));
process.env.CLINE_DIR = TEST_DIR;
process.env.CLINE_BROWSER_PROFILES_FILE = path.join(
	TEST_DIR,
	"browser-profiles.json",
);

afterAll(() => {
	fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

const load = () => import("./browser-profiles");

beforeEach(async () => {
	fs.rmSync(path.join(TEST_DIR, "browser-profiles.json"), { force: true });
	(await load()).resetBrowserProfilePin();
});

describe("resolveProfileDebugPort", () => {
	it("leaves the base port alone on the default profile", async () => {
		const { resolveProfileDebugPort } = await load();
		expect(resolveProfileDebugPort(9222)).toBe(9222);
	});

	it("offsets a base port that came from config.json, not just the stock one", async () => {
		const {
			createBrowserProfile,
			setActiveBrowserProfile,
			resolveProfileDebugPort,
		} = await load();

		const work = createBrowserProfile("work");
		setActiveBrowserProfile("work");

		// 9222 here stands for a `debugPort` pinned in config.json. Before the
		// fix this returned 9222 for every profile.
		expect(resolveProfileDebugPort(9222)).toBe(9222 + work.portOffset * 10);
		// A non-stock base is offset the same way.
		expect(resolveProfileDebugPort(9500)).toBe(9500 + work.portOffset * 10);
	});

	it("gives two profiles two different ports from one base", async () => {
		const {
			createBrowserProfile,
			setActiveBrowserProfile,
			resolveProfileDebugPort,
			DEFAULT_PROFILE_NAME,
		} = await load();

		createBrowserProfile("work");
		setActiveBrowserProfile(DEFAULT_PROFILE_NAME);
		const first = resolveProfileDebugPort(9222);
		setActiveBrowserProfile("work");
		const second = resolveProfileDebugPort(9222);

		expect(first).not.toBe(second);
	});
});
