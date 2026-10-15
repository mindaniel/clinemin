import { describe, expect, it } from "vitest";
import {
	ATTACH_MARKER,
	attachToolResults,
	PASTED_FILE_MESSAGE,
	splitAttachment,
	typedMessage,
} from "./paste-attachment";

describe("splitAttachment / typedMessage", () => {
	it("treats an unmarked prompt as all attachment", () => {
		const split = splitAttachment("long text");
		expect(split).toEqual({ head: "", body: "long text", marked: false });
		expect(typedMessage("long text", split, true)).toBe(PASTED_FILE_MESSAGE);
		expect(typedMessage("long text", split, false)).toBe("long text");
	});

	it("types the head and attaches the body of a marked prompt", () => {
		const prompt = `Read this paper.\n${ATTACH_MARKER}\n=== PAGE 1 ===`;
		const split = splitAttachment(prompt);
		expect(split.head).toBe("Read this paper.");
		expect(split.body).toBe("=== PAGE 1 ===");
		expect(typedMessage(prompt, split, true)).toBe("Read this paper.");
		expect(typedMessage(prompt, split, false)).toBe(
			"Read this paper.\n\n=== PAGE 1 ===",
		);
	});

	it("types everything when nothing follows the marker", () => {
		const prompt = `Instructions only.\n${ATTACH_MARKER}`;
		const split = splitAttachment(prompt);
		expect(typedMessage(prompt, split, false)).toBe("Instructions only.");
	});
});

describe("attachToolResults", () => {
	const big = "x".repeat(5000);
	const prompt = [
		`Tool result: (read_files) ${big}`,
		"Tool result: (run_commands) done",
		"Note: Use tool to continue the task.",
	].join("\n\n");

	it("moves tool results behind the marker and keeps the note typed", () => {
		const out = attachToolResults(prompt, 4000);
		const split = splitAttachment(out);
		expect(split.head).toContain("Note: Use tool to continue the task.");
		expect(split.head).not.toContain("Tool result:");
		expect(split.body).toContain(`Tool result: (read_files) ${big}`);
		expect(split.body).toContain("Tool result: (run_commands) done");
	});

	it("keeps tool results whose body spans blank lines together", () => {
		const out = attachToolResults(
			`Tool result: (read_files) a\n\nb ${big}\n\nNote: go`,
			4000,
		);
		const split = splitAttachment(out);
		expect(split.body).toContain(`a\n\nb ${big}`);
		expect(split.head).toContain("Note: go");
	});

	it("leaves short results, disabled mode and marked prompts alone", () => {
		expect(attachToolResults(prompt, 100_000)).toBe(prompt);
		expect(attachToolResults(prompt, 0)).toBe(prompt);
		const marked = `a\n${ATTACH_MARKER}\nb`;
		expect(attachToolResults(marked, 1)).toBe(marked);
	});
});
