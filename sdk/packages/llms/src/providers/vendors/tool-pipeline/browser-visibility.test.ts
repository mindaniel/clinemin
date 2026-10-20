import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	closeBrowserIfModeChanged,
	readHeadlessPreference,
	resolveHeadless,
	writeHeadlessPreference,
} from "./browser-visibility";

describe("browser visibility preference", () => {
	let dir: string;
	const saved = process.env.CLINE_DIR;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cline-visibility-"));
		process.env.CLINE_DIR = dir;
	});

	afterEach(() => {
		if (saved === undefined) delete process.env.CLINE_DIR;
		else process.env.CLINE_DIR = saved;
		rmSync(dir, { recursive: true, force: true });
	});

	it("falls back to the provider config until Tab sets it", () => {
		expect(readHeadlessPreference()).toBeUndefined();
		expect(resolveHeadless(true)).toBe(true);
		writeHeadlessPreference(false);
		expect(resolveHeadless(true)).toBe(false);
		writeHeadlessPreference(true);
		expect(resolveHeadless(false)).toBe(true);
	});

	it("leaves the browser alone with no preference or nothing running", async () => {
		expect(await closeBrowserIfModeChanged(1)).toBe(false);
		writeHeadlessPreference(true);
		// Port 1 has no Chrome on it: nothing to close, the launch uses the flag.
		expect(await closeBrowserIfModeChanged(1)).toBe(false);
	});
});
