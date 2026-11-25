import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	copilotLimitActive,
	readCopilotLimit,
	readCopilotUsage,
	recordCopilotTurn,
} from "./usage";

const NOTICE =
	"You've reached your daily limit. Get more usage now or check back at 12:00 AM.";

function tempFile() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-usage-"));
	return path.join(dir, "usage.json");
}

describe("copilot daily usage", () => {
	it("reads the daily-limit notice and its midnight reset", () => {
		const now = new Date(2026, 10, 25, 23, 14);
		const at = new Date(readCopilotLimit(NOTICE, now)?.resetsAt ?? "");
		expect([at.getDate(), at.getHours(), at.getMinutes()]).toEqual([26, 0, 0]);
		expect(readCopilotLimit("OK", now)).toBe(undefined);
	});

	it("counts turns, records the limit, and starts a new day after midnight", () => {
		const file = tempFile();
		const t1 = new Date(2026, 10, 25, 23, 0);
		recordCopilotTurn(
			file,
			{ tokensIn: 100, tokensOut: 5, replyText: "OK" },
			t1,
		);
		recordCopilotTurn(
			file,
			{ tokensIn: 9000, tokensOut: 400, replyText: "{}" },
			t1,
		);
		const hit = recordCopilotTurn(
			file,
			{ tokensIn: 50, tokensOut: 20, replyText: NOTICE },
			new Date(2026, 10, 25, 23, 14),
		);
		expect(hit.messages).toBe(2);
		expect(hit.tokensIn).toBe(9100);
		expect(hit.limitHitAfter).toEqual({ messages: 2, tokensIn: 9100 });
		expect(copilotLimitActive(hit, new Date(2026, 10, 25, 23, 30))).toBe(true);

		const next = readCopilotUsage(file, new Date(2026, 10, 26, 0, 5));
		expect(next.messages).toBe(0);
		expect(copilotLimitActive(next, new Date(2026, 10, 26, 0, 5))).toBe(false);
		const saved = JSON.parse(fs.readFileSync(file, "utf8"));
		expect(saved.history[0].limitHitAfter.messages).toBe(2);
	});
});
