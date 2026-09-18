import { describe, expect, it } from "vitest";
import {
	isManagerOffRequest,
	MANAGER_COMMAND_USAGE,
	rewriteManagerPrompt,
} from "./manager-command";

describe("rewriteManagerPrompt", () => {
	it("passes the task through unchanged", () => {
		expect(rewriteManagerPrompt("/manager delete the kanban feature")).toEqual({
			kind: "rewritten",
			prompt: "delete the kanban feature",
		});
	});

	it("asks for a task when given none", () => {
		expect(rewriteManagerPrompt("/manager").kind).toBe("usage");
		expect(rewriteManagerPrompt("  /manager   ").kind).toBe("usage");
		expect(MANAGER_COMMAND_USAGE).toContain("/manager");
	});

	it("ignores anything that is not the command", () => {
		expect(rewriteManagerPrompt("tell the manager to start").kind).toBe("none");
		// A word that merely starts with the command name is not the command.
		expect(rewriteManagerPrompt("/managerial duties").kind).toBe("none");
	});
});

describe("isManagerOffRequest", () => {
	it("recognises the bare off words", () => {
		for (const word of ["off", "stop", "exit", "end", "quit"]) {
			expect(isManagerOffRequest(word)).toBe(true);
			expect(isManagerOffRequest(`  ${word.toUpperCase()} `)).toBe(true);
		}
	});

	it("leaves a real task alone", () => {
		// `/manager stop the release script` is work for the workers, not a
		// request to stop being a manager.
		expect(isManagerOffRequest("stop the release script")).toBe(false);
		expect(isManagerOffRequest("turn off the feature flag")).toBe(false);
		expect(isManagerOffRequest("")).toBe(false);
	});
});
