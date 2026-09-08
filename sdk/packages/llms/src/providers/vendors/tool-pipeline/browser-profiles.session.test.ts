import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Two terminals on two profiles, one hub.
 *
 * The providers resolve their Chrome user-data-dir and debug port in the hub
 * process, which runs both terminals' turns. A per-process latch can only hold
 * one answer, so both terminals used to land on one browser and one account.
 * These cover the per-session record and the async scope that replace it.
 *
 * `CLINE_DIR` is set before the import because the module captures the session
 * file's path at import time.
 */
const TEST_DIR = fs.mkdtempSync(
	path.join(os.tmpdir(), "cline-profile-session-"),
);
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
	fs.rmSync(path.join(TEST_DIR, "browser-profile-sessions.json"), {
		force: true,
	});
	fs.rmSync(path.join(TEST_DIR, "browser-profiles.json"), { force: true });
	(await load()).resetBrowserProfilePin();
});

describe("per-session browser profiles", () => {
	it("resolves each session's own profile inside one process", async () => {
		const {
			createBrowserProfile,
			pinSessionBrowserProfile,
			getSessionBrowserProfile,
			runWithBrowserProfile,
			resolveActiveProfilePaths,
			DEFAULT_PROFILE_NAME,
		} = await load();

		const work = createBrowserProfile("work");
		pinSessionBrowserProfile("session-a", DEFAULT_PROFILE_NAME);
		pinSessionBrowserProfile("session-b", work.name);

		const seen = await Promise.all(
			["session-a", "session-b"].map((sessionId) =>
				runWithBrowserProfile(getSessionBrowserProfile(sessionId), async () => {
					// Await inside the scope: the providers resolve their config deep in
					// an async turn, so the scope has to survive the microtask queue.
					await Promise.resolve();
					return resolveActiveProfilePaths("/cfg/qwen-web", 9223);
				}),
			),
		);

		expect(seen[0].profileName).toBe(DEFAULT_PROFILE_NAME);
		expect(seen[0].debugPort).toBe(9223);
		expect(seen[1].profileName).toBe("work");
		expect(seen[1].debugPort).toBe(9223 + work.portOffset * 10);
		expect(seen[0].profileDir).not.toBe(seen[1].profileDir);
	});

	it("leaves the process latch alone so a scope cannot leak to the next turn", async () => {
		const {
			createBrowserProfile,
			getActiveBrowserProfile,
			runWithBrowserProfile,
			DEFAULT_PROFILE_NAME,
		} = await load();

		createBrowserProfile("work");
		runWithBrowserProfile("work", () => getActiveBrowserProfile());

		expect(getActiveBrowserProfile()).toBe(DEFAULT_PROFILE_NAME);
	});

	it("ignores a scoped profile that no longer exists", async () => {
		const {
			runWithBrowserProfile,
			getActiveBrowserProfile,
			DEFAULT_PROFILE_NAME,
		} = await load();

		expect(
			runWithBrowserProfile("deleted", () => getActiveBrowserProfile()),
		).toBe(DEFAULT_PROFILE_NAME);
	});

	it("moves the running session when /profile switches", async () => {
		const {
			createBrowserProfile,
			pinSessionBrowserProfile,
			getSessionBrowserProfile,
			setActiveBrowserProfile,
			DEFAULT_PROFILE_NAME,
		} = await load();

		createBrowserProfile("work");
		pinSessionBrowserProfile("session-a", DEFAULT_PROFILE_NAME);
		setActiveBrowserProfile("work");

		expect(getSessionBrowserProfile("session-a")).toBe("work");
	});

	it("forgets a session that ended", async () => {
		const {
			pinSessionBrowserProfile,
			clearSessionBrowserProfile,
			getSessionBrowserProfile,
			DEFAULT_PROFILE_NAME,
		} = await load();

		pinSessionBrowserProfile("session-a", DEFAULT_PROFILE_NAME);
		clearSessionBrowserProfile("session-a");

		expect(getSessionBrowserProfile("session-a")).toBeUndefined();
	});
});
