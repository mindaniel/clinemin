import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimBrowserPort, releaseBrowserClaims } from "./browser-claims";

const CLAIMS_FILE = path.join(os.homedir(), ".cline", "browser-claims.json");

function readFileClaims(): Record<string, number[]> {
	return JSON.parse(fs.readFileSync(CLAIMS_FILE, "utf8"));
}

describe("browser claims", () => {
	let saved: string | undefined;

	beforeEach(() => {
		saved = fs.existsSync(CLAIMS_FILE)
			? fs.readFileSync(CLAIMS_FILE, "utf8")
			: undefined;
		fs.rmSync(CLAIMS_FILE, { force: true });
		releaseBrowserClaims();
	});

	afterEach(() => {
		releaseBrowserClaims();
		if (saved === undefined) {
			fs.rmSync(CLAIMS_FILE, { force: true });
			return;
		}
		fs.mkdirSync(path.dirname(CLAIMS_FILE), { recursive: true });
		fs.writeFileSync(CLAIMS_FILE, saved, "utf8");
	});

	it("frees a port this process is the only claimant of", () => {
		claimBrowserPort(9224);

		expect(readFileClaims()["9224"]).toEqual([process.pid]);
		expect(releaseBrowserClaims()).toEqual(new Set([9224]));
		expect(fs.existsSync(CLAIMS_FILE) ? readFileClaims() : {}).toEqual({});
	});

	it("does not free a port another live session still claims", () => {
		// The bug this file exists for: a manager session launched the browser,
		// a second terminal attached to it, and the manager's exit killed it
		// mid-turn. `process.pid` stands in for the other live session.
		fs.mkdirSync(path.dirname(CLAIMS_FILE), { recursive: true });
		// The parent process is a real, live pid that is not ours.
		fs.writeFileSync(
			CLAIMS_FILE,
			JSON.stringify({ "9222": [process.ppid] }),
			"utf8",
		);
		claimBrowserPort(9222);

		expect(readFileClaims()["9222"]).toEqual([process.ppid, process.pid]);
		// The port is not returned, so `shutdownLaunchedBrowsers` leaves that
		// browser running for the other session.
		expect(releaseBrowserClaims()).toEqual(new Set());
		expect(readFileClaims()["9222"]).toEqual([process.ppid]);
	});

	it("prunes a claim left behind by a crashed session", () => {
		// A pid that cannot exist: the file must not pin a port forever because
		// a session died without releasing.
		fs.mkdirSync(path.dirname(CLAIMS_FILE), { recursive: true });
		fs.writeFileSync(CLAIMS_FILE, JSON.stringify({ "9226": [0x7ffffff0] }), {
			encoding: "utf8",
		});
		claimBrowserPort(9226);

		expect(readFileClaims()["9226"]).toEqual([process.pid]);
		expect(releaseBrowserClaims()).toEqual(new Set([9226]));
	});

	it("ignores a corrupt claims file rather than failing a turn", () => {
		fs.mkdirSync(path.dirname(CLAIMS_FILE), { recursive: true });
		fs.writeFileSync(CLAIMS_FILE, "not json at all", "utf8");

		expect(() => claimBrowserPort(9228)).not.toThrow();
		expect(readFileClaims()["9228"]).toEqual([process.pid]);
	});
});
