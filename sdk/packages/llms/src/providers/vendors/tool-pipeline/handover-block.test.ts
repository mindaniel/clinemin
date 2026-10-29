import { describe, expect, it } from "vitest";
import { parseManagerBlocks } from "./manager-block";

describe("<handover> blocks", () => {
	it("become a team_handover call", () => {
		const parsed = parseManagerBlocks(
			[
				"Context is nearly full, handing over.",
				"<handover>",
				"TO: claude-2",
				"Goal: split grok-web. Done: types pass. Left: tests.",
				"</handover>",
			].join("\n"),
		);
		expect(parsed.problems).toEqual([]);
		expect(parsed.delegations).toEqual([
			{
				name: "team_handover",
				arguments: {
					to: "claude-2",
					summary: "Goal: split grok-web. Done: types pass. Left: tests.",
				},
			},
		]);
		expect(parsed.cleanedContent).toBe("Context is nearly full, handing over.");
	});

	it("drop any work sent alongside the handover", () => {
		const parsed = parseManagerBlocks(
			[
				"<manager>",
				"TO: qwen",
				"Start the next file.",
				"</manager>",
				"<handover>",
				"TO: claude-2",
				"Summary.",
				"</handover>",
			].join("\n"),
		);
		expect(parsed.delegations.map((d) => d.name)).toEqual(["team_handover"]);
	});

	it("complain about a handover with no TO: line", () => {
		const parsed = parseManagerBlocks("<handover>\nSummary.\n</handover>");
		expect(parsed.delegations).toEqual([]);
		expect(parsed.problems[0]).toContain("TO: <manager>");
	});

	it("leave ordinary <manager> blocks alone", () => {
		const parsed = parseManagerBlocks(
			"<manager>\nTO: qwen\nRead a.ts\n</manager>",
		);
		expect(parsed.delegations[0]?.name).toBe("team_run_task");
	});
});
