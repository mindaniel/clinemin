import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pruneRawLogs, rawLogRetentionDays } from "./conversation-logger";

const DAY_MS = 24 * 60 * 60 * 1000;

function writeLog(
	root: string,
	provider: string,
	name: string,
	ageDays: number,
) {
	const dir = path.join(root, provider);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	fs.writeFileSync(file, "{}\n");
	const when = new Date(Date.now() - ageDays * DAY_MS);
	fs.utimesSync(file, when, when);
	return file;
}

describe("raw log retention", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("deletes logs older than the retention window and empty folders", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "cline-rawlog-"));
		try {
			const old = writeLog(root, "qwen-web", "old.log", 40);
			const fresh = writeLog(root, "deepseek-web-v2", "fresh.log", 2);
			const oldOther = writeLog(root, "deepseek-web-v2", "old.log", 31);

			expect(pruneRawLogs(30, root)).toBe(2);
			expect(fs.existsSync(old)).toBe(false);
			expect(fs.existsSync(oldOther)).toBe(false);
			expect(fs.existsSync(fresh)).toBe(true);
			expect(fs.existsSync(path.join(root, "qwen-web"))).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("is a no-op when the log folder does not exist", () => {
		expect(pruneRawLogs(30, path.join(os.tmpdir(), "cline-missing-xyz"))).toBe(
			0,
		);
	});

	it("reads retention from the environment, defaulting to 30", () => {
		vi.stubEnv("CLINE_RAW_LOG_RETENTION_DAYS", "");
		expect(rawLogRetentionDays()).toBe(30);
		vi.stubEnv("CLINE_RAW_LOG_RETENTION_DAYS", "7");
		expect(rawLogRetentionDays()).toBe(7);
		vi.stubEnv("CLINE_RAW_LOG_RETENTION_DAYS", "0");
		expect(rawLogRetentionDays()).toBe(0);
		vi.stubEnv("CLINE_RAW_LOG_RETENTION_DAYS", "junk");
		expect(rawLogRetentionDays()).toBe(30);
	});
});
