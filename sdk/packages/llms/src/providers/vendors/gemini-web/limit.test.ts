import { describe, expect, it } from "vitest";
import {
	geminiLimitProviderMetadata,
	readGeminiLimit,
	trackGeminiLimit,
} from "./limit";

// Local time, like the notice Gemini writes.
const NOW = new Date(2026, 10, 15, 13, 0);

function local(iso: string | undefined) {
	const d = new Date(iso ?? "");
	return [d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
}

describe("readGeminiLimit", () => {
	it("reads a date and 12-hour time", () => {
		const limit = readGeminiLimit(
			"You've reached your limit for 3 Pro until Nov 16, 3:24 PM. Upgrade for higher limits.",
			NOW,
		);
		expect(local(limit?.resetsAt)).toEqual([11, 16, 15, 24]);
	});

	it("reads a bare 24-hour time, rolling to tomorrow when it has passed", () => {
		const later = readGeminiLimit(
			"You've hit your usage limit. It resets at 15:30.",
			NOW,
		);
		expect(local(later?.resetsAt)).toEqual([11, 15, 15, 30]);
		const earlier = readGeminiLimit(
			"You've hit your usage limit. It resets at 09:05.",
			NOW,
		);
		expect(local(earlier?.resetsAt)).toEqual([11, 16, 9, 5]);
	});

	it("reports the limit with no time when none can be read", () => {
		expect(
			readGeminiLimit("You've reached your Pro model limit for now.", NOW),
		).toEqual({});
	});

	it("ignores ordinary replies, and long replies that mention limits", () => {
		expect(readGeminiLimit("The parser ran with no errors.", NOW)).toBe(
			undefined,
		);
		const essay = `Rate limits: once you've reached your limit the API resets at 15:00. ${"More detail. ".repeat(60)}`;
		expect(readGeminiLimit(essay, NOW)).toBe(undefined);
	});
});

describe("trackGeminiLimit", () => {
	it("keeps a limit until its reset time, then clears it", () => {
		const notice = "You've reached your limit until 2:00 PM.";
		expect(trackGeminiLimit(notice, NOW)?.resetsAt).toBeDefined();
		expect(
			trackGeminiLimit("normal reply", new Date(2026, 10, 15, 13, 30)),
		).toBeDefined();
		expect(
			trackGeminiLimit("normal reply", new Date(2026, 10, 15, 14, 1)),
		).toBe(undefined);
	});

	it("clears a limit with no time on the next ordinary reply", () => {
		expect(trackGeminiLimit("You've reached your limit.", NOW)).toEqual({});
		expect(trackGeminiLimit("normal reply", NOW)).toBe(undefined);
	});
});

describe("geminiLimitProviderMetadata", () => {
	it("says false when no limit is in force, so the status bar clears", () => {
		expect(geminiLimitProviderMetadata(undefined)).toEqual({
			providerMetadata: { "gemini-web": { limitReached: false } },
		});
	});
});
