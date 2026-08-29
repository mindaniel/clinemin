import { describe, expect, it } from "vitest";
import { parseInvokeStyleToolCalls } from "./invoke-parser";

const TOOLS = ["read_files", "run_commands", "editor"];

describe("parseInvokeStyleToolCalls", () => {
	it("parses a real reply, wrapper and unclosed tags included", () => {
		const reply = [
			"I'll read both files.",
			"",
			"<tool>",
			'<invoke name="read_files">',
			'<parameter name="files">[{"path": "a.py", "start_line": 100, "end_line": 560}]</parameter>',
			"</invoke>",
		].join("\n");

		const { cleanedContent, toolCalls } = parseInvokeStyleToolCalls(
			reply,
			TOOLS,
		);
		expect(toolCalls).toEqual([
			{
				name: "read_files",
				arguments: {
					files: [{ path: "a.py", start_line: 100, end_line: 560 }],
				},
			},
		]);
		expect(cleanedContent).toBe("I'll read both files.");
	});

	it("handles several calls in one reply", () => {
		const reply = [
			'<invoke name="read_files">',
			'<parameter name="files">["a.ts"]</parameter>',
			"</invoke>",
			'<invoke name="run_commands">',
			'<parameter name="command">bun test</parameter>',
			"</invoke>",
		].join("\n");
		const { toolCalls } = parseInvokeStyleToolCalls(reply, TOOLS);
		expect(toolCalls.map((call) => call.name)).toEqual([
			"read_files",
			"run_commands",
		]);
		expect(toolCalls[1].arguments).toEqual({ command: "bun test" });
	});

	it("coerces only unambiguous values", () => {
		const reply = [
			'<invoke name="editor">',
			'<parameter name="start_line">100</parameter>',
			'<parameter name="recursive">true</parameter>',
			'<parameter name="path">C:\\Users\\me\\a.ts</parameter>',
			'<parameter name="version">1.0</parameter>',
			"</invoke>",
		].join("\n");
		const { toolCalls } = parseInvokeStyleToolCalls(reply, TOOLS);
		expect(toolCalls[0].arguments).toEqual({
			start_line: 100,
			recursive: true,
			path: "C:\\Users\\me\\a.ts",
			// A decimal stays a string: "1.0" must not silently become 1.
			version: "1.0",
		});
	});

	it("ignores names that are not wired-up tools", () => {
		const reply =
			'<invoke name="launch_missiles"><parameter name="x">1</parameter></invoke>';
		const { cleanedContent, toolCalls } = parseInvokeStyleToolCalls(
			reply,
			TOOLS,
		);
		expect(toolCalls).toEqual([]);
		expect(cleanedContent).toBe(reply);
	});

	it("leaves ordinary prose alone", () => {
		const reply = "You can invoke the parameter parser from the CLI.";
		const { cleanedContent, toolCalls } = parseInvokeStyleToolCalls(
			reply,
			TOOLS,
		);
		expect(toolCalls).toEqual([]);
		expect(cleanedContent).toBe(reply);
	});

	it("recovers a call cut off before its closing tags", () => {
		const reply =
			'<tool>\n<invoke name="read_files">\n<parameter name="files">["a.ts"]';
		const { toolCalls } = parseInvokeStyleToolCalls(reply, TOOLS);
		expect(toolCalls).toEqual([
			{ name: "read_files", arguments: { files: ["a.ts"] } },
		]);
	});

	it("repairs a Windows path written with single backslashes", () => {
		// The model writes the path the way it appears in a shell, which is not
		// valid JSON: `\\U` is not an escape sequence.
		const reply =
			'<tool><invoke name="read_files"><parameter name="files">[{"path": "C:\\\\Users\\\\me\\\\a.ts"}]</parameter></invoke>';
		const { toolCalls } = parseInvokeStyleToolCalls(reply, TOOLS);
		expect(toolCalls).toEqual([
			{
				name: "read_files",
				arguments: { files: [{ path: "C:\\Users\\me\\a.ts" }] },
			},
		]);
	});
});
