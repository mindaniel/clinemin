import { describe, expect, it } from "vitest";
import { parsePatchBlocks, unappliedPatchNotice } from "./patch-block";

const TOOLS = ["read_files", "run_commands", "apply_patch"];

const PATCH = [
	"*** Begin Patch",
	"*** Update File: C:\\project\\foo.py",
	"@@ def calc",
	"     keep_me()",
	"-    return x",
	"+    return y",
	"*** End Patch",
].join("\n");

describe("parsePatchBlocks", () => {
	it("reads a bare patch block into an apply_patch call", () => {
		const result = parsePatchBlocks(PATCH, TOOLS);
		expect(result.toolCalls).toEqual([
			{ name: "apply_patch", arguments: { input: PATCH } },
		]);
		expect(result.cleanedContent).toBe("");
	});

	it("keeps the prose around the block", () => {
		const result = parsePatchBlocks(
			`Here is the fix.\n\n${PATCH}\n\nRun the tests after.`,
			TOOLS,
		);
		expect(result.toolCalls).toHaveLength(1);
		expect(result.cleanedContent).toBe(
			"Here is the fix.\n\n\nRun the tests after.",
		);
	});

	it("preserves indentation and backslashes byte for byte", () => {
		const input = parsePatchBlocks(PATCH, TOOLS).toolCalls[0]?.arguments.input;
		expect(input).toContain("*** Update File: C:\\project\\foo.py");
		expect(input).toContain("     keep_me()");
		expect(input).toContain("-    return x");
	});

	it("reads several blocks in order", () => {
		const second = PATCH.replace("foo.py", "bar.py");
		const result = parsePatchBlocks(`${PATCH}\n\n${second}`, TOOLS);
		expect(result.toolCalls).toHaveLength(2);
		expect(result.toolCalls[1]?.arguments.input).toContain("bar.py");
	});

	it("ignores an unterminated block", () => {
		const text = "*** Begin Patch\n*** Update File: a.py\n-  x";
		const result = parsePatchBlocks(text, TOOLS);
		expect(result.toolCalls).toEqual([]);
		expect(result.cleanedContent).toBe(text);
	});

	it("ignores markers that are not at the start of a line", () => {
		const text = "The model writes *** Begin Patch when editing.";
		const result = parsePatchBlocks(text, TOOLS);
		expect(result.toolCalls).toEqual([]);
		expect(result.cleanedContent).toBe(text);
	});

	it("does nothing when the session has no apply_patch tool", () => {
		const result = parsePatchBlocks(PATCH, ["read_files", "editor"]);
		expect(result.toolCalls).toEqual([]);
		expect(result.cleanedContent).toBe(PATCH);
	});

	it("does nothing for a reply with no patch at all", () => {
		const result = parsePatchBlocks("Just prose.", TOOLS);
		expect(result.toolCalls).toEqual([]);
		expect(result.cleanedContent).toBe("Just prose.");
	});

	it("tolerates CRLF line endings", () => {
		const result = parsePatchBlocks(PATCH.split("\n").join("\r\n"), TOOLS);
		expect(result.toolCalls).toHaveLength(1);
	});
});

describe("unappliedPatchNotice", () => {
	const patch = [
		"*** Begin Patch",
		"*** Update File: a.ts",
		"*** End Patch",
	].join("\n");

	it("explains a patch the session cannot apply", () => {
		// The silent drop is the failure: a model resent the same patch four
		// times, was told each time the file had not changed, and neither side
		// could see that the tool was simply absent.
		expect(
			unappliedPatchNotice(patch, ["read_files", "run_commands"]),
		).toContain("no `apply_patch` tool");
	});

	it("says nothing when the tool is there", () => {
		expect(unappliedPatchNotice(patch, ["apply_patch"])).toBeUndefined();
	});

	it("says nothing when there is no patch", () => {
		expect(unappliedPatchNotice("just prose", ["read_files"])).toBeUndefined();
	});
});

describe("a patch alongside a verification command", () => {
	it("keeps the patch when a shell fence is also present", () => {
		// The reply that exposed this: "apply this patch, then run this to check
		// it". The shell fence was dispatched and the turn ended, so only the
		// check ran — against a file that had not changed.
		const reply = [
			"```diff",
			"*** Begin Patch",
			"*** Update File: apps/cli/src/foo.ts",
			"@@ export function foo",
			" const a = 1;",
			"-const b = 2;",
			"+const b = 3;",
			"*** End Patch",
			"```",
			"",
			"```powershell",
			"Get-Content .appsclisrc\foo.ts",
			"```",
		].join("\n");

		const parsed = parsePatchBlocks(reply, TOOLS);

		expect(parsed.toolCalls).toHaveLength(1);
		expect(parsed.toolCalls[0]?.arguments.input).toContain("*** Update File:");
		// The verification fence survives for the manager parser downstream.
		expect(parsed.cleanedContent).toContain("```powershell");
	});
});
