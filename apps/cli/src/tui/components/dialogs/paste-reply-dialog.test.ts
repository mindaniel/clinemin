import { describe, expect, it } from "vitest";
import { describePasteReply } from "./paste-reply-preview";

describe("describePasteReply", () => {
	it("names a JSON tool call", () => {
		const preview = describePasteReply('<tool>{"name": "read_files"}</tool>');
		expect(preview.looksLikeToolCall).toBe(true);
		expect(preview.toolNames).toContain("read_files");
	});

	it("recognises a manager block", () => {
		// The manager writes delegations as a <manager> block, which carries no
		// tool name anywhere in its text. The preview used to call this a plain
		// text answer, so /paste looked like it had refused the delegation.
		const preview = describePasteReply(
			["<manager>", "TO: extractor", "Read src/index.ts.", "</manager>"].join(
				"\n",
			),
		);
		expect(preview.looksLikeToolCall).toBe(true);
		expect(preview.toolNames).toEqual(["team_run_task"]);
	});

	it("recognises a bare patch block", () => {
		const preview = describePasteReply(
			["*** Begin Patch", "*** Update File: C:/x.ts", "*** End Patch"].join(
				"\n",
			),
		);
		expect(preview.toolNames).toEqual(["apply_patch"]);
	});

	it("recognises a tagged PowerShell fence but not an untagged one", () => {
		const tagged = describePasteReply(
			["```powershell", "ls", "```"].join("\n"),
		);
		expect(tagged.toolNames).toEqual(["run_commands"]);

		// An untagged fence is quoted text to every provider — the mistake this
		// preview exists to catch, so it must keep reporting no tool call.
		const untagged = describePasteReply(["```", "ls", "```"].join("\n"));
		expect(untagged.looksLikeToolCall).toBe(false);
	});

	it("reports plain prose as a text answer", () => {
		const preview = describePasteReply("I read the file and it looks fine.");
		expect(preview.looksLikeToolCall).toBe(false);
		expect(preview.toolNames).toEqual([]);
	});
});
