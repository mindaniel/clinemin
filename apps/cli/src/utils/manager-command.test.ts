import { describe, expect, it } from "vitest";
import { MANAGER_COMMAND_USAGE, rewriteManagerPrompt } from "./manager-command";

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
