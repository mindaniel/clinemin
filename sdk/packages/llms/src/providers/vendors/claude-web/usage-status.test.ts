import { describe, expect, it } from "vitest";
import { parseClaudeUsage } from "./capture";

describe("parseClaudeUsage", () => {
	it("reads the five-hour window as a percentage", () => {
		expect(
			parseClaudeUsage(
				JSON.stringify({
					five_hour: { utilization: 59, resets_at: "2026-11-25T18:30:00Z" },
					seven_day: { utilization: 12 },
				}),
			),
		).toEqual({ percent: 59, resetsAt: "2026-11-25T18:30:00Z" });
	});

	it("scales a 0-1 fraction", () => {
		expect(parseClaudeUsage('{"five_hour":{"utilization":0.29}}')).toEqual({
			percent: 29,
		});
	});

	it("gives up on anything else", () => {
		expect(parseClaudeUsage("")).toBeUndefined();
		expect(parseClaudeUsage('{"five_hour":null}')).toBeUndefined();
		expect(parseClaudeUsage("<html>")).toBeUndefined();
	});
});
