import { afterEach, describe, expect, it, vi } from "vitest";
import { findInvalidUnicode, validatePythonCode } from "./python-validator";
import {
	type ParsedToolInput,
	processResponseForTools,
	validateToolCalls,
} from "./tool-dispatcher";
import { extractToolCalls } from "./tool-parser";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("tool-pipeline extractToolCalls", () => {
	it("parses simple <tool> blocks", () => {
		const raw =
			'<tool>{"name":"read_files","arguments":{"path":"/tmp/a.txt"}}</tool>';
		const results = extractToolCalls(raw);
		expect(results).toHaveLength(1);
		expect(results[0].ok).toBe(true);
		expect(results[0].tool).toEqual({
			name: "read_files",
			arguments: { path: "/tmp/a.txt" },
		});
	});

	it("parses multiple blocks in one response", () => {
		const raw =
			'<tool>{"name":"a","arguments":{}}</tool> <tool>{"name":"b","arguments":{"x":1}}</tool>';
		const results = extractToolCalls(raw);
		expect(results.map((r) => r.tool?.name)).toEqual(["a", "b"]);
	});

	it("strips markdown fences (```json and bare ```) around the body", () => {
		const raw =
			'```json\n<tool>{"name":"editor","arguments":{"new_text":"x = 1"}}</tool>\n```';
		const results = extractToolCalls(raw);
		expect(results).toHaveLength(1);
		expect(results[0].ok).toBe(true);
		expect(results[0].tool?.name).toBe("editor");
	});

	it("repairs missing quotes on keys, trailing commas, and single quotes", () => {
		// `Type`/`Arguments` capitalization and Python-ish values are edge cases
		// jsonrepair handles; here we test the common DeepSeek sloppiness.
		const raw =
			"<tool>{name: 'editor', arguments: {path: '/a.py', new_text: 'x = 1',},}</tool>";
		const results = extractToolCalls(raw);
		expect(results[0].ok).toBe(true);
		expect(results[0].tool?.arguments).toEqual({
			path: "/a.py",
			new_text: "x = 1",
		});
	});

	it("skips (does not throw on) unparseable blocks", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const raw = "<tool>{this is not json at all</tool>";
		const results = extractToolCalls(raw);
		expect(results[0].ok).toBe(false);
		expect(results[0].error).toBeTruthy();
		expect(warn).toHaveBeenCalled();
	});

	it("returns an empty array for empty input", () => {
		expect(extractToolCalls("")).toEqual([]);
		expect(extractToolCalls("no tool blocks here")).toEqual([]);
	});
});

describe("tool-pipeline validatePythonCode", () => {
	it("accepts syntactically valid Python", () => {
		const result = validatePythonCode("for i in range(3):\n    print(i)");
		expect(result.valid).toBe(true);
		expect(result.error).toBeUndefined();
	});

	it("rejects malformed Python with a line-precise error", () => {
		const result = validatePythonCode("def broken(:\n    return 1");
		expect(result.valid).toBe(false);
		expect(result.error).toMatch(/Python syntax error at line \d+/);
	});

	it("rejects mismatched brackets", () => {
		const result = validatePythonCode("x = [1, 2, 3");
		expect(result.valid).toBe(false);
		expect(result.error).toMatch(/line 1/);
	});

	it("treats empty code as valid", () => {
		expect(validatePythonCode("").valid).toBe(true);
		expect(validatePythonCode("   ").valid).toBe(true);
	});

	it("validates Python containing proper (valid UTF-8) CJK characters", () => {
		// `万泽股份` written via proper escapes — this must PASS, not produce a
		// "surrogates not allowed" error. Chinese text is fully supported.
		const cjk = "\u4e07\u6cfd\u80a1\u4efd"; // 万泽股份
		const code = `DATA.append(("000533", F))\n# ${cjk} 2025\nF = "${cjk}_2025.pdf"\n`;
		expect(findInvalidUnicode(code)).toBeUndefined();
		expect(validatePythonCode(code).valid).toBe(true);
	});

	it("rejects a lone low surrogate with an actionable Unicode message (not a cryptic encode crash)", () => {
		// A mangled CJK char (orphaned low surrogate) — the exact cause of the
		// old "UnicodeEncodeError: 'surrogates not allowed'" crash the AI saw.
		const lone = String.fromCharCode(0xdc90);
		const code = `x = 1\n# \u4e07\u6cfd${lone}\u80a1\n`;
		const issue = findInvalidUnicode(code);
		expect(issue?.offset).toBeDefined();
		expect(issue?.description).toContain("surrogate");

		const result = validatePythonCode(code);
		expect(result.valid).toBe(false);
		expect(result.error).toMatch(/Unicode error at offset \d+/);
		expect(result.error).toMatch(/proper UTF-8/);
		// Must NOT surface Node's internal encode error as a misleading
		// "Python syntax error".
		expect(result.error).not.toMatch(/Python syntax error/);
	});

	it("accepts a well-formed surrogate pair (e.g. an emoji) — not flagged", () => {
		// Emoji is a correct high+low surrogate pair; must not be treated as invalid.
		const code = 'x = "start \ud83d\ude00 end"\n';
		expect(findInvalidUnicode(code)).toBeUndefined();
		expect(validatePythonCode(code).valid).toBe(true);
	});
});

describe("tool-pipeline processResponseForTools", () => {
	it("returns tools with no retryPrompt when everything parses cleanly", () => {
		const raw =
			'<tool>{"name":"read_files","arguments":{"path":"/x"}}</tool>' +
			'<tool>{"name":"editor","arguments":{"path":"/a.py","new_text":"def f():\\n    return 1"}}</tool>';
		const { tools, retryPrompt } = processResponseForTools(raw);
		expect(tools.map((t) => t.name)).toEqual(["read_files", "editor"]);
		expect(retryPrompt).toBeUndefined();
	});

	it("keeps a non-editor tool even when it has a new_text-like field", () => {
		// Only `editor` calls get Python validation; run_commands must pass through.
		const raw =
			'<tool>{"name":"run_commands","arguments":{"commands":["echo hi"]}}</tool>';
		const { tools, retryPrompt } = processResponseForTools(raw);
		expect(tools.map((t) => t.name)).toEqual(["run_commands"]);
		expect(retryPrompt).toBeUndefined();
	});

	it("rejects an editor call with invalid Python and produces a retryPrompt", () => {
		const raw =
			'<tool>{"name":"editor","arguments":{"path":"/a.py","new_text":"def broken(:"}}</tool>';
		const { tools, retryPrompt } = processResponseForTools(raw);
		// The offending call is dropped — zero execution.
		expect(tools).toEqual([]);
		expect(retryPrompt).toMatch(/^Tool call rejected: \[Tool: editor\]/);
		expect(retryPrompt).toMatch(/Python syntax error at line \d+/);
		expect(retryPrompt).toMatch(/emit a corrected <tool> block\.$/);
	});

	it("feeds back guidance when the AI emits an unparseable <tool> block", () => {
		// Even when the JSON body can't be recovered, the model must be told it
		// tried to call a tool and how to emit it correctly (no silent skip).
		const raw =
			"<tool>{ this is not valid json at all </tool>" +
			'<tool>{"name":"read_files","arguments":{"path":"/ok"}}</tool>';
		const { tools, retryPrompt } = processResponseForTools(raw);
		// The valid call still executes; the malformed attempt is reported.
		expect(tools.map((t) => t.name)).toEqual(["read_files"]);
		expect(retryPrompt).toMatch(
			/^Tool call rejected: Attempted a <tool> block/,
		);
		expect(retryPrompt).toContain('"name"');
		expect(retryPrompt).toContain("<tool>");
	});

	it("routes feedback for a mix of parse + python failures", () => {
		const raw =
			"<tool>{broken</tool>" +
			'<tool>{"name":"editor","arguments":{"new_text":"x = ["}}</tool>' +
			'<tool>{"name":"search_codebase","arguments":{"queries":["a"]}}</tool>';
		const { tools, retryPrompt } = processResponseForTools(raw);
		expect(tools.map((t) => t.name)).toEqual(["search_codebase"]);
		expect(retryPrompt).toContain("Tool call rejected:");
		// Both distinct rejection kinds present.
		expect(retryPrompt).toContain("Attempted a <tool> block");
		expect(retryPrompt).toContain("[Tool: editor]");
	});

	it("accumulates multiple rejections and keeps the valid calls", () => {
		const raw =
			'<tool>{"name":"editor","arguments":{"new_text":"if x"}}</tool>' +
			'<tool>{"name":"read_files","arguments":{"path":"/ok"}}</tool>' +
			'<tool>{"name":"editor","arguments":{"new_text":"def f(:"}}</tool>';
		const { tools, retryPrompt } = processResponseForTools(raw);
		expect(tools.map((t) => t.name)).toEqual(["read_files"]);
		expect(retryPrompt?.split("Tool call rejected:").length).toBeGreaterThan(2);
	});

	it("returns an empty tools array with no retry when there are no tool blocks", () => {
		const { tools, retryPrompt } = processResponseForTools(
			"the model replied with a plain plan",
		);
		expect(tools).toEqual([]);
		expect(retryPrompt).toBeUndefined();
	});
});

describe("tool-pipeline validateToolCalls (provider integration entry)", () => {
	it("filters invalid editor new_text from an already-parsed call list", () => {
		const calls: ParsedToolInput[] = [
			{
				name: "editor",
				arguments: { path: "/a.py", new_text: "x = [1,2" },
			},
			{
				name: "read_files",
				arguments: { path: "/ok" },
			},
		];
		const { tools, retryPrompt } = validateToolCalls(calls);
		expect(tools.map((t) => t.name)).toEqual(["read_files"]);
		expect(retryPrompt).toMatch(/\[Tool: editor\]/);
	});

	it("passes through clean calls with no retryPrompt", () => {
		const calls: ParsedToolInput[] = [
			{ name: "search_codebase", arguments: { queries: ["x"] } },
		];
		const { tools, retryPrompt } = validateToolCalls(calls);
		expect(tools).toHaveLength(1);
		expect(retryPrompt).toBeUndefined();
	});
});
