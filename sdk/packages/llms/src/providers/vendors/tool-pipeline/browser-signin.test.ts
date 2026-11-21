import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearBrowserSignin, nameBrowserProfile } from "./browser-path";

let dir: string | undefined;
afterEach(() => {
	if (dir) fs.rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

function makeProfile(userName: string): string {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "signin-"));
	fs.mkdirSync(path.join(dir, "Default"));
	fs.writeFileSync(
		path.join(dir, "Local State"),
		JSON.stringify({
			profile: {
				info_cache: {
					Default: {
						user_name: userName,
						gaia_id: "abc",
						is_consented_primary_account: userName !== "",
						edge_account_type: 2,
						edge_account_first_name: "A",
						name: "Profile 1",
					},
				},
			},
			signin: { active_accounts: { x: 1 }, active_accounts_last_emitted: 5 },
		}),
	);
	fs.writeFileSync(
		path.join(dir, "Default", "Preferences"),
		JSON.stringify({
			account_info: [{ account_id: "abc" }],
			google: { services: { consented_to_sync: true, signin: { x: 1 } } },
			edge: { account_type: 2, services: { last_gaia_id: "abc" } },
			sync: { gaia_id: "abc", has_setup_completed: true, bookmarks: true },
			homepage: "keep",
		}),
	);
	return dir;
}

const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

describe("clearBrowserSignin", () => {
	it("signs a profile out of the browser account and keeps the rest", () => {
		const d = makeProfile("someone@example.com");
		clearBrowserSignin(d);
		const info = read(path.join(d, "Local State")).profile.info_cache.Default;
		expect(info.user_name).toBe("");
		expect(info.gaia_id).toBe("");
		expect(info.is_consented_primary_account).toBe(false);
		expect(info.edge_account_type).toBe(0);
		expect(info.edge_account_first_name).toBe("");
		expect(info.name).toBe("Profile 1");
		const state = read(path.join(d, "Local State"));
		expect(state.signin.active_accounts).toBeUndefined();
		expect(state.signin.active_accounts_last_emitted).toBe(5);

		const prefs = read(path.join(d, "Default", "Preferences"));
		expect(prefs.account_info).toBeUndefined();
		expect(prefs.google.services.consented_to_sync).toBeUndefined();
		expect(prefs.edge.account_type).toBeUndefined();
		expect(prefs.edge.services.last_gaia_id).toBeUndefined();
		expect(prefs.sync.gaia_id).toBeUndefined();
		expect(prefs.sync.bookmarks).toBe(true);
		expect(prefs.homepage).toBe("keep");
	});

	it("leaves a signed-out profile untouched", () => {
		const d = makeProfile("");
		const prefsPath = path.join(d, "Default", "Preferences");
		const before = fs.readFileSync(prefsPath, "utf8");
		clearBrowserSignin(d);
		expect(fs.readFileSync(prefsPath, "utf8")).toBe(before);
	});

	it("does nothing for a missing or broken profile", () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "signin-"));
		expect(() =>
			clearBrowserSignin(path.join(dir as string, "nope")),
		).not.toThrow();
		fs.writeFileSync(path.join(dir, "Local State"), "{not json");
		expect(() => clearBrowserSignin(dir as string)).not.toThrow();
	});
});

describe("nameBrowserProfile", () => {
	it("names an existing profile and keeps its other settings", () => {
		const d = makeProfile("");
		nameBrowserProfile(d, "work@example.com");
		const info = read(path.join(d, "Local State")).profile.info_cache.Default;
		expect(info.name).toBe("work@example.com");
		expect(info.is_using_default_name).toBe(false);
		expect(info.gaia_id).toBe("abc");
		const prefs = read(path.join(d, "Default", "Preferences"));
		expect(prefs.profile.name).toBe("work@example.com");
		expect(prefs.homepage).toBe("keep");
	});

	it("names a profile before its first launch", () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "signin-"));
		nameBrowserProfile(dir, "m");
		const info = read(path.join(dir, "Local State")).profile.info_cache.Default;
		expect(info).toEqual({ name: "m", is_using_default_name: false });
	});
});
