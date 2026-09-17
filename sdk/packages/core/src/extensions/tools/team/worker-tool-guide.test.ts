import { describe, expect, it } from "vitest";
import { appendWorkerToolGuide } from "./worker-tool-guide";

describe("appendWorkerToolGuide", () => {
	it("leaves the task alone for tools the web prompt already teaches", () => {
		expect(
			appendWorkerToolGuide(
				"Do it.",
				["run_commands", "apply_patch"],
				"deepseek-web-v2",
			),
		).toBe("Do it.");
	});

	it("teaches a web worker a tool its prompt never mentions", () => {
		const text = appendWorkerToolGuide(
			"Find it.",
			["run_commands", "search_codebase"],
			"deepseek-web-v2",
		);
		expect(text.startsWith("Find it.")).toBe(true);
		expect(text).toContain('{"name":"search_codebase","arguments":{"queries"');
		expect(text).not.toContain('"name":"run_commands"');
	});

	it("adds nothing for a native tool-calling provider", () => {
		expect(appendWorkerToolGuide("Find it.", ["read_files"], "anthropic")).toBe(
			"Find it.",
		);
	});

	it("adds the guide when the worker inherits the session provider", () => {
		expect(
			appendWorkerToolGuide("Find it.", ["read_files"], undefined),
		).toContain('"name":"read_files"');
	});
});
