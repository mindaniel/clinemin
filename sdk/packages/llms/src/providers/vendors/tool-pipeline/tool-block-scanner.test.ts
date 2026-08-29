import { describe, expect, it } from "vitest";
import { parseDeepSeekToolCalls } from "../deepseek-web";
import { scanToolBlocks } from "./tool-block-scanner";
import { extractToolCalls } from "./tool-parser";

// The reply that motivated the scanner: the model asked to write a line of
// source containing a literal `</tool>` into a file. Its JSON was correctly
// escaped; the old non-greedy regex still cut the block short at the `</tool>`
// inside the string, so the call was dropped and the remainder leaked as prose.
const SELF_REFERENTIAL = JSON.stringify({
	name: "editor",
	arguments: {
		path: "deepseek-web-v2.ts",
		old_text: "\treturn null;\n}\n",
		new_text:
			"\tconst example = '<tool>' + JSON.stringify(call) + '</tool>';\n\treturn null;\n}\n",
	},
});

describe("scanToolBlocks", () => {
	it("ends the block at the JSON envelope, not at a `</tool>` in the payload", () => {
		const blocks = scanToolBlocks(`<tool>${SELF_REFERENTIAL}</tool>`);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].scanned).toBe(true);
		expect(blocks[0].unterminated).toBe(false);
		expect(JSON.parse(blocks[0].body)).toMatchObject({ name: "editor" });
	});

	it("does not open a second block from a `<tool>` inside the payload", () => {
		const blocks = scanToolBlocks(
			`prose\n<tool>${SELF_REFERENTIAL}</tool>\nmore prose`,
		);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].end).toBeLessThan(
			"prose\n".length + 20 + SELF_REFERENTIAL.length + 20,
		);
	});

	it("keeps adjacent blocks separate", () => {
		const one = JSON.stringify({ name: "read_files", arguments: { a: 1 } });
		const two = JSON.stringify({ name: "run_commands", arguments: { b: 2 } });
		const blocks = scanToolBlocks(`<tool>${one}</tool>\n<tool>${two}</tool>`);
		expect(blocks.map((b) => JSON.parse(b.body).name)).toEqual([
			"read_files",
			"run_commands",
		]);
	});

	it("tolerates a missing closing tag", () => {
		const body = JSON.stringify({ name: "read_files", arguments: {} });
		const blocks = scanToolBlocks(`<tool>${body}`);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].unterminated).toBe(true);
		expect(JSON.parse(blocks[0].body)).toMatchObject({ name: "read_files" });
	});

	it("still uses the closing tag for a non-JSON body", () => {
		const blocks = scanToolBlocks(
			"<tool><name>read_files</name><arguments>{}</arguments></tool>",
		);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].scanned).toBe(false);
		expect(blocks[0].body).toContain("<name>read_files</name>");
	});

	it("unwraps a fenced JSON body", () => {
		const body = JSON.stringify({ name: "read_files", arguments: {} });
		const blocks = scanToolBlocks(
			"<tool>\n```json\n" + body + "\n```\n</tool>",
		);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].scanned).toBe(true);
	});
});

describe("payload containing the closing tag", () => {
	it("parseDeepSeekToolCalls executes the call and strips it from the text", () => {
		const { cleanedContent, toolCalls } = parseDeepSeekToolCalls(
			`Step 1:\n\n<tool>${SELF_REFERENTIAL}</tool>`,
			["editor"],
		);
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].name).toBe("editor");
		expect(toolCalls[0].arguments.new_text).toContain("</tool>");
		expect(cleanedContent).toBe("Step 1:");
	});

	it("extractToolCalls parses it instead of reporting broken JSON", () => {
		const results = extractToolCalls(`<tool>${SELF_REFERENTIAL}</tool>`);
		expect(results).toHaveLength(1);
		expect(results[0].ok).toBe(true);
		expect(results[0].tool?.name).toBe("editor");
	});
});

// The shape that was still leaking after the first fix: the payload contains a
// literal `</tool>` AND the model dropped the object's final `}`. With nothing
// to balance, the terminator has to be chosen by string state instead.
const UNBALANCED_SELF_REFERENTIAL =
	'<tool>\n{"name": "editor", "arguments": {"path": "a.ts", "old_text": "}", ' +
	'"new_text": "const example = \\"<tool>\\" + j + \\"</tool>\\";"}\n</tool>';

describe("unbalanced envelope whose payload contains the closing tag", () => {
	it("ends at the closing tag written outside a string", () => {
		const blocks = scanToolBlocks(UNBALANCED_SELF_REFERENTIAL);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].scanned).toBe(false);
		expect(blocks[0].unterminated).toBe(false);
		expect(blocks[0].body).toContain('\\"</tool>\\"');
		expect(blocks[0].end).toBe(UNBALANCED_SELF_REFERENTIAL.length);
	});

	it("parseDeepSeekToolCalls repairs the missing brace and runs the call", () => {
		const { cleanedContent, toolCalls } = parseDeepSeekToolCalls(
			UNBALANCED_SELF_REFERENTIAL,
			["editor"],
		);
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].name).toBe("editor");
		expect(toolCalls[0].arguments.new_text).toContain("</tool>");
		expect(cleanedContent).toBe("");
	});
});
