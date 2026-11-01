import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stageUpstreamBuild } from "./source-auto-update";
import {
	applyStagedUpdate,
	autoUpdateStateFile,
	checkSdkBuild,
	readUpdateState,
	rebuildStaleSdk,
	sdkBuildStampFile,
	stagingWorktreeDir,
	writeUpdateState,
} from "./source-update-apply";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();

// A stand-in for the SDK build: writes dist/ from the committed version file.
const PACKAGE_JSON = JSON.stringify({
	name: "t",
	private: true,
	scripts: {
		"build:sdk":
			"bun -e \"const fs=require('fs');fs.mkdirSync('sdk/packages/x/dist',{recursive:true});fs.writeFileSync('sdk/packages/x/dist/index.js',fs.readFileSync('sdk/packages/x/v.txt'))\"",
	},
});

describe("source checkout auto-update", () => {
	let dir: string;
	let upstream: string;
	let checkout: string;
	let clineDir: string;

	const pushVersion = (version: string) => {
		writeFileSync(join(upstream, "sdk/packages/x/v.txt"), version);
		git(upstream, "commit", "-qam", version);
		git(upstream, "push", "-q");
	};
	const stage = () => {
		const staged = stageUpstreamBuild(checkout, stagingWorktreeDir(clineDir));
		writeUpdateState(autoUpdateStateFile(clineDir), { staged });
		return staged;
	};
	const builtVersion = () =>
		readFileSync(join(checkout, "sdk/packages/x/dist/index.js"), "utf-8");

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cline-auto-update-"));
		clineDir = join(dir, ".cline");
		git(dir, "init", "-q", "--bare", "origin.git");
		git(dir, "clone", "-q", "origin.git", "up");
		upstream = join(dir, "up");
		mkdirSync(join(upstream, "sdk/packages/x"), { recursive: true });
		writeFileSync(join(upstream, "package.json"), PACKAGE_JSON);
		writeFileSync(join(upstream, ".gitignore"), "dist\nnode_modules\n");
		writeFileSync(join(upstream, "sdk/packages/x/v.txt"), "one");
		git(upstream, "add", ".");
		git(upstream, "commit", "-qm", "one");
		git(upstream, "push", "-q", "origin", "HEAD");
		git(dir, "clone", "-q", "origin.git", "co");
		checkout = join(dir, "co");
		mkdirSync(join(checkout, "sdk/packages/x/dist"), { recursive: true });
		writeFileSync(join(checkout, "sdk/packages/x/dist/index.js"), "one");
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("builds on the side and swaps in only at the next launch", () => {
		expect(stage()).toBeUndefined();
		pushVersion("two");
		const staged = stage();
		expect(staged?.short).toBe(git(upstream, "rev-parse", "--short", "HEAD"));
		// Staging touched nothing in the checkout.
		expect(readFileSync(join(checkout, "sdk/packages/x/v.txt"), "utf-8")).toBe(
			"one",
		);
		expect(builtVersion()).toBe("one");
		expect(existsSync(join(checkout, "node_modules"))).toBe(false);

		expect(applyStagedUpdate(checkout, clineDir)).toBe(staged?.short);
		expect(readFileSync(join(checkout, "sdk/packages/x/v.txt"), "utf-8")).toBe(
			"two",
		);
		expect(builtVersion()).toBe("two");
		expect(
			readUpdateState(autoUpdateStateFile(clineDir)).staged,
		).toBeUndefined();
	}, 60_000);

	it("waits while another cline (a live hub) is running", () => {
		pushVersion("two");
		stage();
		const owners = join(clineDir, "data/locks/hub/owners");
		mkdirSync(owners, { recursive: true });
		writeFileSync(
			join(owners, "hub-1.json"),
			JSON.stringify({ pid: process.pid }),
		);
		expect(applyStagedUpdate(checkout, clineDir)).toBeUndefined();
		expect(builtVersion()).toBe("one");

		rmSync(owners, { recursive: true });
		expect(applyStagedUpdate(checkout, clineDir)).toBeDefined();
	}, 60_000);

	it("leaves local SDK edits and unpushed commits alone", () => {
		pushVersion("two");
		stage();
		writeFileSync(join(checkout, "sdk/packages/x/v.txt"), "mine");
		expect(applyStagedUpdate(checkout, clineDir)).toBeUndefined();
		expect(readFileSync(join(checkout, "sdk/packages/x/v.txt"), "utf-8")).toBe(
			"mine",
		);
		expect(builtVersion()).toBe("one");

		git(checkout, "commit", "-qam", "mine");
		expect(stage()).toBeUndefined();
		expect(applyStagedUpdate(checkout, clineDir)).toBeUndefined();
		expect(git(checkout, "log", "-1", "--format=%s")).toBe("mine");
	}, 60_000);

	describe("stale SDK build", () => {
		// A build stamped at HEAD, an hour ago so later file writes count as newer.
		const stampBuild = () => {
			const stamp = sdkBuildStampFile(checkout);
			mkdirSync(dirname(stamp), { recursive: true });
			writeFileSync(stamp, git(checkout, "rev-parse", "HEAD"));
			const hourAgo = new Date(Date.now() - 60 * 60_000);
			utimesSync(stamp, hourAgo, hourAgo);
		};

		it("is stale with no stamp, and asks for an install", () => {
			expect(checkSdkBuild(checkout)).toEqual({ stale: true, reinstall: true });
		});

		it("is fresh at the stamped commit, even with uncommitted edits", () => {
			stampBuild();
			writeFileSync(join(checkout, "sdk/packages/x/v.txt"), "mine");
			expect(checkSdkBuild(checkout).stale).toBe(false);
		});

		it("goes stale when a pull brings SDK source, then rebuilds", () => {
			stampBuild();
			pushVersion("two");
			git(checkout, "pull", "-q", "--ff-only");
			expect(checkSdkBuild(checkout)).toEqual({
				stale: true,
				reinstall: false,
			});

			rebuildStaleSdk(checkout);
			expect(builtVersion()).toBe("two");
			expect(existsSync(`${sdkBuildStampFile(checkout)}.lock`)).toBe(false);
		}, 60_000);

		it("stays fresh when a pull touches only apps", () => {
			stampBuild();
			mkdirSync(join(upstream, "apps"));
			writeFileSync(join(upstream, "apps/a.ts"), "a");
			git(upstream, "add", ".");
			git(upstream, "commit", "-qm", "apps");
			git(upstream, "push", "-q");
			git(checkout, "pull", "-q", "--ff-only");
			expect(checkSdkBuild(checkout).stale).toBe(false);
		}, 60_000);

		it("asks for an install when a pull changes dependencies", () => {
			stampBuild();
			writeFileSync(join(upstream, "package.json"), `${PACKAGE_JSON}\n`);
			git(upstream, "commit", "-qam", "deps");
			git(upstream, "push", "-q");
			git(checkout, "pull", "-q", "--ff-only");
			expect(checkSdkBuild(checkout)).toEqual({ stale: true, reinstall: true });
		}, 60_000);

		it("does not rebuild for a local commit of edits already built", () => {
			writeFileSync(join(checkout, "sdk/packages/x/v.txt"), "mine");
			git(checkout, "commit", "-qam", "mine");
			const hourAgo = new Date(Date.now() - 60 * 60_000);
			utimesSync(join(checkout, "sdk/packages/x/v.txt"), hourAgo, hourAgo);
			const stamp = sdkBuildStampFile(checkout);
			mkdirSync(dirname(stamp), { recursive: true });
			writeFileSync(stamp, git(checkout, "rev-parse", "HEAD~1"));
			expect(checkSdkBuild(checkout).stale).toBe(false);
		}, 60_000);
	});
});
