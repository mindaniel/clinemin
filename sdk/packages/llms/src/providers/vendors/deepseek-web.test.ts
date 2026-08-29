import type {
	LanguageModelV2FunctionTool,
	LanguageModelV2Message,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
	consumeDeepSeekSse,
	estimateDeepSeekWebUsage,
	messagesToPrompt,
	parseDeepSeekToolCalls,
	parseLooseDeepSeekToolCalls,
	serializeDeepSeekToolPrompt,
	sha3_256Hex,
	solveDeepSeekPow,
} from "./deepseek-web";

// DeepSeekHashV1 digests (SHA3-256 with the Keccak-f[1600] permutation running
// only rounds 1..23 — validated against OmniRoute's working solver).
const SHA3_VECTORS: Array<[string, string]> = [
	["", "e594808bc5b7151ac160c6d39a02e0a8e261ed588578403099e3561dc40c26b3"],
	["abc", "f841106c601ce9be9bc38525e90d4178d47f21dd8eb9f238fc55ffaa4ca94506"],
	[
		"The quick brown fox jumps over the lazy dog",
		"9a7f4e87d535e6fff80182224c6c4ddf5ab4042314bd07714b56ff5c55384811",
	],
	// Exact block boundary (136 bytes).
	[
		"a".repeat(136),
		"680364b336f77918ed390287a581f96f1371599825acd1e348fa7649fcecbbab",
	],
	// Multi-block input.
	[
		"a".repeat(137),
		"dfeb7768d4d48053c083d849570e84cc8120520790f2d09cb56e40038081fab4",
	],
	// Non-ASCII input forces multi-byte UTF-8 encoding.
	[
		"héllo wörld",
		"1fcbaafc8ccfea760b430346d482adbe49ee9f10f9ba3de78414a09d90514c92",
	],
];

describe("deepseek-web sha3_256Hex", () => {
	for (const [input, expected] of SHA3_VECTORS) {
		it(`matches DeepSeekHashV1 for ${JSON.stringify(input.slice(0, 24))}${input.length > 24 ? "…" : ""}`, () => {
			expect(sha3_256Hex(input)).toBe(expected);
		});
	}
});

describe("deepseek-web solveDeepSeekPow", () => {
	it("solves the real OmniRoute challenge (nonce 0)", () => {
		const response = solveDeepSeekPow({
			algorithm: "DeepSeekHashV1",
			challenge:
				"311b26ae1e0fe7375e242958ce46db5552a6c67fea3f96880dcd846c63a74286",
			salt: "1122334455667788",
			signature: "sig123",
			difficulty: 1000,
			expire_at: 1778891543095,
			expire_after: 300000,
			target_path: "/api/v0/chat/completion",
		});

		const decoded = JSON.parse(
			Buffer.from(response, "base64").toString("utf8"),
		) as Record<string, unknown>;
		expect(decoded.algorithm).toBe("DeepSeekHashV1");
		expect(decoded.answer).toBe(0);
		expect(decoded.challenge).toBe(
			"311b26ae1e0fe7375e242958ce46db5552a6c67fea3f96880dcd846c63a74286",
		);
		expect(decoded.salt).toBe("1122334455667788");
	});

	it("solves a real server challenge (nonce 66373)", () => {
		const response = solveDeepSeekPow({
			algorithm: "DeepSeekHashV1",
			challenge:
				"41229b28a80e78ce87c90aaa17f415ca16f59ad857c8b14d65382a966b6d917a",
			salt: "a6b811dea4a94b24701f",
			signature:
				"d5285a52cd81eb1d360130f3d34f8d85a77db90fe1434c45446d978e512fe7ae",
			difficulty: 144000,
			expire_at: 1787345141314,
			expire_after: 300000,
			target_path: "/api/v0/chat/completion",
		});

		const decoded = JSON.parse(
			Buffer.from(response, "base64").toString("utf8"),
		) as Record<string, unknown>;
		expect(decoded.answer).toBe(66373);
		expect(decoded.signature).toBe(
			"d5285a52cd81eb1d360130f3d34f8d85a77db90fe1434c45446d978e512fe7ae",
		);
		expect(decoded.target_path).toBe("/api/v0/chat/completion");
	});

	it("throws when no nonce in range matches the challenge", () => {
		expect(() =>
			solveDeepSeekPow({
				algorithm: "DeepSeekHashV1",
				challenge: sha3_256Hex("salt_1710000000_42"),
				salt: "salt",
				signature: "sig",
				difficulty: 10,
				expire_at: 1710000000,
				expire_after: 3600,
				target_path: "/api/v0/chat/completion",
			}),
		).toThrow(/no nonce matched/i);
	});
});

describe("deepseek-web parseDeepSeekToolCalls", () => {
	it("parses a <tool>{json}</tool> block and strips it from the text", () => {
		const reply =
			'Let me read that file.\n<tool>{"name":"read_file","arguments":{"path":"/tmp/a.txt"}}</tool>\nDone reading.';
		const { cleanedContent, toolCalls } = parseDeepSeekToolCalls(reply, [
			"read_file",
		]);
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]).toEqual({
			name: "read_file",
			arguments: { path: "/tmp/a.txt" },
		});
		expect(cleanedContent).toContain("Let me read that file.");
		expect(cleanedContent).toContain("Done reading.");
		expect(cleanedContent).not.toContain("<tool>");
	});

	it("ignores tool blocks whose name is not in the allowed list", () => {
		const reply = '<tool>{"name":"rm_rf","arguments":{}}</tool> hi';
		const { cleanedContent, toolCalls } = parseDeepSeekToolCalls(reply, [
			"read_file",
		]);
		expect(toolCalls).toHaveLength(0);
		expect(cleanedContent).toContain("hi");
	});

	it("parses the <tool:name> variant", () => {
		const reply = '<tool:search>{"query":"cline"}</tool:search>';
		const { toolCalls } = parseDeepSeekToolCalls(reply, ["search_codebase"]);
		// The bare `search` tag-name is normalized to the real tool name.
		expect(toolCalls).toEqual([
			{ name: "search_codebase", arguments: { query: "cline" } },
		]);
	});

	it("normalizes _codebase to search_codebase so the search still runs", () => {
		const reply =
			'<tool>{"name": "_codebase", "arguments": {"queries": ["CompactionDividerRow"]}}</tool>';
		const { toolCalls, cleanedContent } = parseDeepSeekToolCalls(reply, [
			"search_codebase",
		]);
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].name).toBe("search_codebase");
		expect(toolCalls[0].arguments).toEqual({
			queries: ["CompactionDividerRow"],
		});
		expect(cleanedContent).not.toContain("<tool>");
	});

	it("tolerates spaces in the tags and markdown bullets around the block", () => {
		const reply =
			'*< tool >{"name":"search_codebase","arguments":{"queries":["a"]}}< /tool >';
		const { toolCalls, cleanedContent } = parseDeepSeekToolCalls(reply, [
			"search_codebase",
		]);
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].name).toBe("search_codebase");
		expect(cleanedContent).not.toContain("<tool");
	});

	it("repairs broken JSON (trailing commas, single quotes, leading prose)", () => {
		const reply =
			"Let me look. <tool>{'name': 'search_codebase', 'arguments': {'queries': ['x','y',],},}</tool> Done.";
		const { toolCalls, cleanedContent } = parseDeepSeekToolCalls(reply, [
			"search_codebase",
		]);
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]).toEqual({
			name: "search_codebase",
			arguments: { queries: ["x", "y"] },
		});
		expect(cleanedContent).toContain("Let me look.");
		expect(cleanedContent).toContain("Done.");
		expect(cleanedContent).not.toContain("<tool");
	});

	it("recovers run_commands with a Windows path that has invalid single-backslash escapes", () => {
		// The model often emits `C:\Users\...` inside a JSON string; `\U`, `\u`,
		// `\q` are illegal JSON escapes, so plain JSON.parse fails. The parser
		// must repair them without mangling single quotes inside the command.
		const reply =
			'<tool>{"name":"run_commands","arguments":{"commands":["Get-ChildItem -Path \'C:\\Users\\quang\\Downloads\\clinemin\' -Recurse -File | Where-Object { $_.Name -like \'compaction\' } | Select-Object FullName"]}}</tool>';
		const { cleanedContent, toolCalls } = parseDeepSeekToolCalls(reply, [
			"run_commands",
		]);
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].name).toBe("run_commands");
		expect(toolCalls[0].arguments.commands[0]).toBe(
			"Get-ChildItem -Path 'C:\\Users\\quang\\Downloads\\clinemin' -Recurse -File | Where-Object { $_.Name -like 'compaction' } | Select-Object FullName",
		);
		expect(cleanedContent).not.toContain("<tool");
	});
});

describe("deepseek-web serializeDeepSeekToolPrompt", () => {
	const tools: LanguageModelV2FunctionTool[] = [
		{
			type: "function",
			name: "read_file",
			description: "Read a file",
			inputSchema: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		},
	];

	it("documents the strict <tool> contract and lists available tools", () => {
		const prompt = serializeDeepSeekToolPrompt(tools);
		expect(prompt).toContain("<tool>{");
		expect(prompt).toContain('"name": "<tool_name>"');
		expect(prompt).toContain("Available tools:");
		expect(prompt).toContain("- read_file: Read a file");
		expect(prompt).toContain('"path"');
	});
});

describe("deepseek-web messagesToPrompt", () => {
	it("stitches system + user content into a flat prompt", () => {
		const messages: LanguageModelV2Message[] = [
			{
				role: "system",
				content: [{ type: "text", text: "You are a helpful assistant." }],
			},
			{ role: "user", content: [{ type: "text", text: "Hello!" }] },
		];
		const prompt = messagesToPrompt(messages);
		expect(prompt).toContain("You are a helpful assistant.");
		expect(prompt).toContain("Hello!");
	});

	it("folds tool results into the recent-turn window", () => {
		const messages: LanguageModelV2Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: "Check the weather" }],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call_1",
						toolName: "weather",
						result: { temp: 21 },
					},
				],
			},
		];
		const prompt = messagesToPrompt(messages);
		expect(prompt).toContain("(weather)");
		expect(prompt).toContain('"temp":21');
	});

	it("extracts AI SDK v2 tool-result output (text)", () => {
		const messages: LanguageModelV2Message[] = [
			{ role: "user", content: [{ type: "text", text: "run a command" }] },
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call_1",
						toolName: "run_commands",
						// v2 shape: { type: "text", value }
						output: { type: "text", value: "output line 1\noutput line 2" },
					},
				],
			},
		];
		const prompt = messagesToPrompt(messages);
		expect(prompt).toContain("(run_commands)");
		expect(prompt).toContain("output line 1");
		expect(prompt).toContain("output line 2");
	});

	it("extracts AI SDK v2 tool-result output (json)", () => {
		const messages: LanguageModelV2Message[] = [
			{ role: "user", content: [{ type: "text", text: "list things" }] },
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call_2",
						toolName: "list_things",
						output: { type: "json", value: { ok: true, count: 3 } },
					},
				],
			},
		];
		const prompt = messagesToPrompt(messages);
		expect(prompt).toContain('"ok":true');
		expect(prompt).toContain('"count":3');
	});

	it("extracts AI SDK v2 tool-result output (error-text)", () => {
		const messages: LanguageModelV2Message[] = [
			{ role: "user", content: [{ type: "text", text: "cmd" }] },
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call_3",
						toolName: "run_commands",
						output: { type: "error-text", value: "command failed" },
					},
				],
			},
		];
		const prompt = messagesToPrompt(messages);
		expect(prompt).toContain("command failed");
	});

	it("extracts AI SDK v2 tool-result output (plain object without type)", () => {
		const messages: LanguageModelV2Message[] = [
			{ role: "user", content: [{ type: "text", text: "echo" }] },
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call_4",
						toolName: "echo",
						output: { error: "denied by test" },
					},
				],
			},
		];
		const prompt = messagesToPrompt(messages);
		expect(prompt).toContain('"error":"denied by test"');
	});
});

describe("deepseek-web consumeDeepSeekSse (accumulated_token_usage)", () => {
	it("extracts the last accumulated token count from the response envelope", async () => {
		const sse = [
			'data: {"v":{"response":{"thinking_enabled":false,"accumulated_token_usage":134905,"fragments":[{"id":1,"type":"RESPONSE","content":"I"}]}}}\n\n',
			'data: {"v":" search"}\n\n',
			'data: {"p":"accumulated_token_usage","o":"APPEND","v":135010}\n\n',
			"data: [DONE]\n\n",
		].join("");
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(sse));
				controller.close();
			},
		});

		const { text, accumulatedTokenUsage } = await consumeDeepSeekSse(stream);
		expect(text).toBe("I search");
		expect(accumulatedTokenUsage).toBe(135010);
	});

	it("extracts the count from a BATCH update", async () => {
		const sse =
			'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":250000},{"p":"quasi_status","v":"FINISHED"}]}\n\n';
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(sse));
				controller.close();
			},
		});

		const { accumulatedTokenUsage } = await consumeDeepSeekSse(stream);
		expect(accumulatedTokenUsage).toBe(250000);
	});

	it("leaves accumulatedTokenUsage undefined when the server reports none", async () => {
		const sse = 'data: {"v":"plain text"}\n\n';
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(sse));
				controller.close();
			},
		});

		const { accumulatedTokenUsage } = await consumeDeepSeekSse(stream);
		expect(accumulatedTokenUsage).toBeUndefined();
	});
});

describe("deepseek-web estimateDeepSeekWebUsage", () => {
	it("estimates input from the exact prompt string and output from the reply", () => {
		const usage = estimateDeepSeekWebUsage("x".repeat(300), "hello world");

		expect(usage.inputTokens).toBe(100);
		expect(usage.outputTokens).toBe(4);
		expect(usage.totalTokens).toBe(104);
	});

	it("never reports zero tokens", () => {
		const usage = estimateDeepSeekWebUsage("", "");

		expect(usage.inputTokens).toBe(1);
		expect(usage.outputTokens).toBe(1);
		expect(usage.totalTokens).toBe(2);
	});

	it("scales with both prompt and reply length", () => {
		const small = estimateDeepSeekWebUsage("a".repeat(30), "b".repeat(30));
		const large = estimateDeepSeekWebUsage(
			"a".repeat(3_000),
			"b".repeat(3_000),
		);

		expect(large.inputTokens).toBeGreaterThan(small.inputTokens * 10);
		expect(large.outputTokens).toBeGreaterThan(small.outputTokens * 10);
	});
});

describe("deepseek-web parseLooseDeepSeekToolCalls", () => {
	it("recovers a bare <tool name=...> with a JSON body", () => {
		const reply = '<tool name="search_codebase">{"queries":["loop"]}</tool>';
		const toolCalls = parseLooseDeepSeekToolCalls(reply, ["search_codebase"]);
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]).toEqual({
			name: "search_codebase",
			arguments: { queries: ["loop"] },
		});
	});

	it("recovers an unbalanced <tool> block with no closing tag", () => {
		// The block's extent now comes from its JSON envelope, so `</tool>` is an
		// optional terminator and the strict parser recovers a truncated block on
		// its own. The loose parser still covers it for the shapes with no
		// envelope to scan.
		const reply =
			'<tool>{"name":"run_commands","arguments":{"commands":["ls"]}}';
		const strict = parseDeepSeekToolCalls(reply, ["run_commands"]);
		expect(strict.toolCalls).toEqual([
			{ name: "run_commands", arguments: { commands: ["ls"] } },
		]);

		const loose = parseLooseDeepSeekToolCalls(reply, ["run_commands"]);
		expect(loose).toHaveLength(1);
		expect(loose[0]).toEqual({
			name: "run_commands",
			arguments: { commands: ["ls"] },
		});
	});

	it("recovers a <tool_call> variant", () => {
		const reply =
			'<tool_call>{"name":"read_files","arguments":{"path":"/tmp/a.txt"}}</tool_call>';
		const loose = parseLooseDeepSeekToolCalls(reply, ["read_files"]);
		expect(loose).toHaveLength(1);
		expect(loose[0]).toEqual({
			name: "read_files",
			arguments: { path: "/tmp/a.txt" },
		});
	});

	it("normalizes common aliases (bash -> run_commands)", () => {
		const reply = '<tool>{"name":"bash","arguments":{"commands":["echo hi"]}}';
		const loose = parseLooseDeepSeekToolCalls(reply, ["run_commands"]);
		expect(loose).toHaveLength(1);
		expect(loose[0].name).toBe("run_commands");
	});

	it("ignores prose that merely contains <tool and no real name", () => {
		const reply = "Please use the <tool> tag when you need to call a function.";
		const loose = parseLooseDeepSeekToolCalls(reply, ["search_codebase"]);
		expect(loose).toHaveLength(0);
	});

	it("ignores tool names not in the accepted list", () => {
		const reply = '<tool>{"name":"rm_rf","arguments":{}}</tool>';
		const loose = parseLooseDeepSeekToolCalls(reply, ["read_files"]);
		expect(loose).toHaveLength(0);
	});

	it("repairs broken single-quoted JSON inside a malformed block", () => {
		const reply =
			"<tool>{'name': 'search_codebase', 'arguments': {'queries': ['a','b',],},}";
		const loose = parseLooseDeepSeekToolCalls(reply, ["search_codebase"]);
		expect(loose).toHaveLength(1);
		expect(loose[0]).toEqual({
			name: "search_codebase",
			arguments: { queries: ["a", "b"] },
		});
	});
});
