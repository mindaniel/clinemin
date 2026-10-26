import { describe, expect, it } from "vitest";
import { EntrySplitter, entryMatches, entryNames } from "./watch";

const ts = "2026-10-26T10:00:00.000Z";

describe("entryNames", () => {
	it("finds who an entry is about", () => {
		expect(entryNames(`${ts} qwen TOOL run_commands {}`)).toEqual(["qwen"]);
		expect(entryNames(`${ts} TASK -> qwen:`)).toEqual(["qwen"]);
		expect(entryNames(`${ts} TASK DONE deepseek:`)).toEqual(["deepseek"]);
		expect(entryNames(`${ts} SPAWN qwen provider=qwen-web`)).toEqual(["qwen"]);
		expect(entryNames(`${ts} MESSAGE lead -> qwen [hi]:`)).toEqual([
			"lead",
			"qwen",
		]);
	});

	it("keeps the manager's own lines out of a worker's view", () => {
		const managerLine = `${ts} manager TOOL team_run_task {"agentId":"qwen"}`;
		expect(entryMatches(managerLine, "qwen")).toBe(false);
		expect(entryMatches(managerLine, undefined)).toBe(true);
	});
});

describe("EntrySplitter", () => {
	it("groups continuation lines and holds back a partial entry", () => {
		const splitter = new EntrySplitter();
		expect(
			splitter.push(`${ts} qwen SAYS:\n    line one\n    line two\n${ts} qwe`),
		).toEqual([`${ts} qwen SAYS:\n    line one\n    line two`]);
		expect(splitter.push("n RESULT run_commands:\n    ok\n")).toEqual([
			`${ts} qwen RESULT run_commands:\n    ok`,
		]);
	});
});
