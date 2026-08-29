import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createBrowserProfile,
	DEFAULT_PROFILE_NAME,
	deleteBrowserProfile,
	getActiveBrowserProfile,
	listBrowserProfiles,
	normalizeProfileName,
	resetBrowserProfilePin,
	resolveActiveProfilePaths,
	setActiveBrowserProfile,
} from "./browser-profiles";

let storeDir: string;
const previous = process.env.CLINE_BROWSER_PROFILES_FILE;

beforeEach(() => {
	resetBrowserProfilePin();
	storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-profiles-"));
	process.env.CLINE_BROWSER_PROFILES_FILE = path.join(
		storeDir,
		"browser-profiles.json",
	);
});

afterEach(() => {
	resetBrowserProfilePin();
	if (previous === undefined) delete process.env.CLINE_BROWSER_PROFILES_FILE;
	else process.env.CLINE_BROWSER_PROFILES_FILE = previous;
	fs.rmSync(storeDir, { recursive: true, force: true });
});

describe("normalizeProfileName", () => {
	it("makes a name safe to use as a directory", () => {
		expect(normalizeProfileName("  Work Account! ")).toBe("work-account");
	});

	it("returns empty for a name with nothing usable in it", () => {
		expect(normalizeProfileName("!!!")).toBe("");
	});
});

describe("browser profile store", () => {
	it("starts with just the default profile, selected", () => {
		expect(listBrowserProfiles().map((entry) => entry.name)).toEqual([
			DEFAULT_PROFILE_NAME,
		]);
		expect(getActiveBrowserProfile()).toBe(DEFAULT_PROFILE_NAME);
	});

	it("normalizes on create and is idempotent", () => {
		expect(createBrowserProfile("Work Account").name).toBe("work-account");
		expect(createBrowserProfile("work-account").portOffset).toBe(1);
		expect(listBrowserProfiles()).toHaveLength(2);
	});

	it("refuses a name that normalizes to nothing", () => {
		expect(() => createBrowserProfile("!!!")).toThrow();
	});

	it("refuses to select a profile that does not exist", () => {
		expect(() => setActiveBrowserProfile("nope")).toThrow();
	});

	it("falls back to the default profile when the active one is deleted", () => {
		createBrowserProfile("work");
		setActiveBrowserProfile("work");
		deleteBrowserProfile("work");
		expect(getActiveBrowserProfile()).toBe(DEFAULT_PROFILE_NAME);
	});

	it("keeps the default profile undeletable", () => {
		expect(() => deleteBrowserProfile(DEFAULT_PROFILE_NAME)).toThrow();
	});
});

describe("resolveActiveProfilePaths", () => {
	// This is the layout every install already has on disk, so an upgrade must
	// not move it — moving it would sign the user out of every provider.
	it("keeps the pre-profiles layout on the default profile", () => {
		const paths = resolveActiveProfilePaths("/cfg/qwen-web", 9223);
		expect(paths.profileName).toBe(DEFAULT_PROFILE_NAME);
		expect(paths.profileDir).toBe(path.join("/cfg/qwen-web", "profile"));
		expect(paths.debugPort).toBe(9223);
		expect(paths.chatsFile).toBe(path.join("/cfg/qwen-web", "chats.json"));
	});

	it("gives a named profile its own directory, port and chat registry", () => {
		createBrowserProfile("work");
		setActiveBrowserProfile("work");
		const paths = resolveActiveProfilePaths("/cfg/qwen-web", 9223);
		expect(paths.profileDir).toBe(
			path.join("/cfg/qwen-web", "profiles", "work", "profile"),
		);
		expect(paths.chatsFile).toBe(
			path.join("/cfg/qwen-web", "profiles", "work", "chats.json"),
		);
		// Stock ports are consecutive (9222-9226), so the step has to clear the
		// whole block or one profile's DeepSeek would land on another's Qwen.
		expect(paths.debugPort).toBe(9233);
	});

	it("does not renumber ports when an earlier profile is deleted", () => {
		createBrowserProfile("first");
		createBrowserProfile("second");
		deleteBrowserProfile("first");
		setActiveBrowserProfile("second");
		expect(resolveActiveProfilePaths("/cfg/qwen-web", 9223).debugPort).toBe(
			9243,
		);
	});
});

// Two terminals share one store file, so the file's `active` cannot double as
// live state: a switch in one must not move the other. See the latch in
// browser-profiles.ts.
describe("per-process latch", () => {
	function otherProcessSwitchesTo(name: string): void {
		const file = process.env.CLINE_BROWSER_PROFILES_FILE as string;
		const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
		fs.writeFileSync(file, JSON.stringify({ ...raw, active: name }));
	}

	it("ignores a switch made by another process", () => {
		createBrowserProfile("work");
		setActiveBrowserProfile("work");
		otherProcessSwitchesTo(DEFAULT_PROFILE_NAME);
		expect(getActiveBrowserProfile()).toBe("work");
		expect(resolveActiveProfilePaths("/cfg/qwen-web", 9223).debugPort).toBe(
			9233,
		);
	});

	it("takes the file's profile as the starting point of a fresh process", () => {
		createBrowserProfile("work");
		setActiveBrowserProfile("work");
		resetBrowserProfilePin();
		expect(getActiveBrowserProfile()).toBe("work");
	});

	it("keeps another process's selection when creating a profile", () => {
		createBrowserProfile("work");
		setActiveBrowserProfile("work");
		otherProcessSwitchesTo(DEFAULT_PROFILE_NAME);
		createBrowserProfile("second");
		const file = process.env.CLINE_BROWSER_PROFILES_FILE as string;
		expect(JSON.parse(fs.readFileSync(file, "utf-8")).active).toBe(
			DEFAULT_PROFILE_NAME,
		);
	});

	it("goes home when the latched profile is deleted", () => {
		createBrowserProfile("work");
		setActiveBrowserProfile("work");
		deleteBrowserProfile("work");
		expect(getActiveBrowserProfile()).toBe(DEFAULT_PROFILE_NAME);
	});
});
