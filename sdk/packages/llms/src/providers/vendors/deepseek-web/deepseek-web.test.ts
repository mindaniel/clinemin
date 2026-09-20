import type {
	LanguageModelV2FunctionTool,
	LanguageModelV2Message,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONTINUATION_NOTE } from "../tool-pipeline/continuation-note";
import { runCompletion } from "./client";
import {
	computeSendDelay,
	consumeDeepSeekSse,
	DEEPSEEK_WEB_TOOL_RESULT_MAX_LINES,
	describeEmptyDeepSeekStream,
	estimateDeepSeekWebUsage,
	isRateLimitDiagnostic,
	messagesToPrompt,
	parseDeepSeekToolCalls,
	parseLooseDeepSeekToolCalls,
	resolveDeepSeekWebPacing,
	serializeDeepSeekToolPrompt,
	sha3_256Hex,
	solveDeepSeekPow,
} from "./index";

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

function sseStream(body: string): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(body));
			controller.close();
		},
	});
}

describe("deepseek-web consumeDeepSeekSse (empty-stream diagnostics)", () => {
	// Before this, only `context_length_exceeded` was recognised: every other
	// hint error was parsed, matched nothing, and was dropped by the catch. The
	// turn then surfaced as the runtime's opaque "Model returned empty response"
	// with the server's own explanation discarded inside this parser.
	it("keeps a hint error the parser has no special handling for", async () => {
		const sse = [
			'event: hint\ndata: {"type":"error","finish_reason":"content_filter","message":"blocked"}\n\n',
			"data: [DONE]\n\n",
		].join("");

		const { text, diagnostics } = await consumeDeepSeekSse(sseStream(sse));

		expect(text).toBe("");
		expect(diagnostics.hintErrors).toHaveLength(1);
		expect(diagnostics.hintErrors[0]).toContain("content_filter");
		expect(describeEmptyDeepSeekStream(diagnostics)).toContain(
			"content_filter",
		);
	});

	it("reports the event count and last payload when nothing explained the silence", async () => {
		const sse = [
			'data: {"p":"quasi_status","v":"FINISHED"}\n\n',
			"data: [DONE]\n\n",
		].join("");

		const { text, diagnostics } = await consumeDeepSeekSse(sseStream(sse));

		expect(text).toBe("");
		expect(diagnostics.dataEvents).toBe(1);
		const described = describeEmptyDeepSeekStream(diagnostics);
		expect(described).toContain("1 SSE events");
		expect(described).toContain("quasi_status");
	});

	it("says so when the stream carried no events at all", async () => {
		const { diagnostics } = await consumeDeepSeekSse(
			sseStream("data: [DONE]\n\n"),
		);

		expect(diagnostics.dataEvents).toBe(0);
		expect(describeEmptyDeepSeekStream(diagnostics)).toContain(
			"no SSE events at all",
		);
	});

	it("still surfaces a context-length hint as its own error", async () => {
		const sse =
			'event: hint\ndata: {"type":"error","finish_reason":"context_length_exceeded"}\n\n';

		await expect(consumeDeepSeekSse(sseStream(sse))).rejects.toThrow(
			/Length limit reached/,
		);
	});
});

describe("deepseek-web tool-result truncation", () => {
	// A few-hundred-line file read is what made chat.deepseek.com answer with an
	// empty stream: the flattened prompt goes out in one request, so the tool
	// result has to be capped the same way `claude-web` caps its own.
	const longOutput = Array.from(
		{ length: DEEPSEEK_WEB_TOOL_RESULT_MAX_LINES + 56 },
		(_unused, index) => `line ${index + 1}`,
	).join("\n");

	const messages: LanguageModelV2Message[] = [
		{ role: "user", content: [{ type: "text", text: "read the file" }] },
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "call_1",
					toolName: "read_files",
					output: { type: "text", value: longOutput },
				},
			],
		},
	];

	it("caps a long tool result and says how much was dropped", () => {
		const prompt = messagesToPrompt(messages, {
			toolResultMaxLines: DEEPSEEK_WEB_TOOL_RESULT_MAX_LINES,
		});

		expect(prompt).toContain(`line ${DEEPSEEK_WEB_TOOL_RESULT_MAX_LINES}`);
		expect(prompt).not.toContain(
			`line ${DEEPSEEK_WEB_TOOL_RESULT_MAX_LINES + 1}`,
		);
		expect(prompt).toContain("[output truncated: 56 more lines]");
	});

	it("leaves the result whole when no cap is asked for", () => {
		const prompt = messagesToPrompt(messages);

		expect(prompt).toContain(`line ${DEEPSEEK_WEB_TOOL_RESULT_MAX_LINES + 56}`);
		expect(prompt).not.toContain("[output truncated");
	});
});

describe("deepseek-web send pacing", () => {
	const pacing = {
		minSendDelayMs: 800,
		maxSendDelayMs: 2_800,
		toolTurnExtraMinMs: 1_500,
		toolTurnExtraMaxMs: 4_500,
	};

	it("always waits, so no send is back to back", () => {
		// rng at the bottom of the range is the fastest send the config allows.
		expect(computeSendDelay(pacing, { isToolTurn: false }, () => 0)).toBe(800);
	});

	it("waits longer on a tool turn", () => {
		const plain = computeSendDelay(pacing, { isToolTurn: false }, () => 0.5);
		const tool = computeSendDelay(pacing, { isToolTurn: true }, () => 0.5);
		expect(tool).toBeGreaterThan(plain);
	});

	it("stays inside the configured bounds at both extremes", () => {
		expect(computeSendDelay(pacing, { isToolTurn: true }, () => 0)).toBe(2_300);
		expect(
			computeSendDelay(pacing, { isToolTurn: true }, () => 0.999999),
		).toBeLessThanOrEqual(pacing.maxSendDelayMs + pacing.toolTurnExtraMaxMs);
	});

	it("survives an inverted range instead of producing a negative delay", () => {
		const delay = computeSendDelay(
			{ ...pacing, minSendDelayMs: 5_000, maxSendDelayMs: 1_000 },
			{ isToolTurn: false },
			() => 0.5,
		);
		expect(delay).toBeGreaterThanOrEqual(1_000);
		expect(delay).toBeLessThanOrEqual(5_000);
	});

	it("reads the env overrides", () => {
		const resolved = resolveDeepSeekWebPacing({
			DEEPSEEK_WEB_MIN_SEND_DELAY_MS: "4000",
			DEEPSEEK_WEB_MAX_SEND_DELAY_MS: "9000",
		} as NodeJS.ProcessEnv);

		expect(resolved.minSendDelayMs).toBe(4_000);
		expect(resolved.maxSendDelayMs).toBe(9_000);
		// Unset keys keep their defaults rather than becoming NaN.
		expect(resolved.toolTurnExtraMinMs).toBe(1_500);
	});

	it("keeps the retry knobs at their defaults when nothing sets them", () => {
		const resolved = resolveDeepSeekWebPacing({} as NodeJS.ProcessEnv);
		expect(resolved.rateLimitRetryDelayMs).toBe(60_000);
		expect(resolved.rateLimitMaxRetries).toBe(3);
	});

	it("treats 0 retries as off rather than falling back to the default", () => {
		const resolved = resolveDeepSeekWebPacing({
			DEEPSEEK_WEB_RATE_LIMIT_MAX_RETRIES: "0",
			DEEPSEEK_WEB_RATE_LIMIT_RETRY_DELAY_MS: "90000",
		} as NodeJS.ProcessEnv);
		expect(resolved.rateLimitMaxRetries).toBe(0);
		expect(resolved.rateLimitRetryDelayMs).toBe(90_000);
	});

	it("recognises the throttle hint among other stream errors", () => {
		expect(
			isRateLimitDiagnostic({
				dataEvents: 2,
				hintErrors: [
					'{"type":"error","content":"Messages too frequent. Try again later.","finish_reason":"rate_limit_reached"}',
				],
			}),
		).toBe(true);
		expect(
			isRateLimitDiagnostic({
				dataEvents: 2,
				hintErrors: ['{"type":"error","finish_reason":"content_filter"}'],
			}),
		).toBe(false);
	});
});

describe("deepseek-web history window", () => {
	// A long tool loop produces more turns than the window holds, so the
	// message stating the task scrolls out and the model receives only tool
	// output plus the synthetic continuation note. It then says it was never
	// told the problem — which is exactly what it was sent.
	function longToolLoop(rounds: number): LanguageModelV2Message[] {
		const messages: LanguageModelV2Message[] = [
			{ role: "system", content: "SYSTEM PROMPT" },
			{
				role: "user",
				content: [{ type: "text", text: "ORIGINAL REQUEST: fix the bridge" }],
			},
		];
		// Each round is three turns: the assistant, the tool result, and the
		// runtime's continuation note. That third turn is what makes the window
		// run out roughly twice as fast as the round count suggests.
		for (let index = 0; index < rounds; index++) {
			messages.push({
				role: "assistant",
				content: [{ type: "text", text: `step ${index}` }],
			});
			messages.push({
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: `call_${index}`,
						toolName: "run_commands",
						output: { type: "text", value: `output ${index}` },
					},
				],
			});
			messages.push({
				role: "user",
				content: [{ type: "text", text: DEFAULT_CONTINUATION_NOTE }],
			});
		}
		return messages;
	}

	function countOccurrences(haystack: string, needle: string): number {
		return haystack.split(needle).length - 1;
	}

	it("drops the request once the loop outgrows the window", () => {
		const prompt = messagesToPrompt(longToolLoop(12), { historyWindow: 20 });

		expect(prompt).toContain("SYSTEM PROMPT");
		expect(prompt).not.toContain("ORIGINAL REQUEST");
		// And repeats the same subject-less nudge for most of the window.
		expect(countOccurrences(prompt, DEFAULT_CONTINUATION_NOTE)).toBeGreaterThan(
			1,
		);
	});

	it("keeps the task visible once the loop outgrows the window", () => {
		const prompt = messagesToPrompt(longToolLoop(12), {
			historyWindow: 20,
			keepTaskVisible: true,
		});

		expect(prompt).toContain("SYSTEM PROMPT");
		expect(prompt).toContain("ORIGINAL REQUEST");
		// The task rides on the trailing note — the last thing the model reads.
		expect(prompt.trimEnd()).toMatch(/ORIGINAL REQUEST[^\n]*$/);
	});

	it("collapses the repeated continuation notes to the trailing one", () => {
		const prompt = messagesToPrompt(longToolLoop(12), {
			historyWindow: 20,
			keepTaskVisible: true,
		});

		expect(countOccurrences(prompt, DEFAULT_CONTINUATION_NOTE)).toBe(1);
		// The freed slots go back to real content: the same window now reaches
		// further into the tool history than it did with the notes in the way.
		const before = messagesToPrompt(longToolLoop(12), { historyWindow: 20 });
		expect(countOccurrences(prompt, "Tool result:")).toBeGreaterThan(
			countOccurrences(before, "Tool result:"),
		);
	});

	it("does not state the task twice when the window still holds it", () => {
		const prompt = messagesToPrompt(longToolLoop(2), {
			historyWindow: 20,
			keepTaskVisible: true,
		});

		// Once in place, once on the trailing note — never a third copy from
		// the above-window restatement as well.
		expect(countOccurrences(prompt, "ORIGINAL REQUEST")).toBe(2);
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

	it("reads a <tool_name> element, the prefixed spelling of <name>", () => {
		// Qwen's real output: the wrapper is <tool_calls>, and the name element
		// carries the same prefix. This used to leave `name` empty and the whole
		// block was returned as visible text, so the command never ran.
		const reply = [
			"<tool_calls>",
			"<tool>",
			"<tool_name>run_commands</tool_name>",
			'<arguments>{"commands": ["Get-Content a.ts"]}</arguments>',
			"</tool>",
			"</tool_calls>",
		].join("\n");
		const { toolCalls } = parseDeepSeekToolCalls(reply, [
			"run_commands",
			"read_files",
		]);
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]?.name).toBe("run_commands");
		expect(toolCalls[0]?.arguments).toEqual({
			commands: ["Get-Content a.ts"],
		});
	});

	it("still reads the plain <name> spelling", () => {
		const reply =
			'<tool><name>read_files</name><arguments>{"files":["a.ts"]}</arguments></tool>';
		const { toolCalls } = parseDeepSeekToolCalls(reply, ["read_files"]);
		expect(toolCalls[0]?.name).toBe("read_files");
		expect(toolCalls[0]?.arguments).toEqual({ files: ["a.ts"] });
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

	it("normalizes powershell and applypatch aliases", () => {
		const powershellReply =
			'<tool>{"name":"powershell","arguments":{"commands":["Get-ChildItem"]}}</tool>';
		const applyPatchReply =
			'<tool>{"name":"applypatch","arguments":{"patch":"*** Begin Patch\\n*** End Patch"}}</tool>';
		const powershell = parseLooseDeepSeekToolCalls(powershellReply, [
			"run_commands",
		]);
		const applyPatch = parseLooseDeepSeekToolCalls(applyPatchReply, [
			"apply_patch",
		]);
		expect(powershell).toHaveLength(1);
		expect(powershell[0].name).toBe("run_commands");
		expect(applyPatch).toHaveLength(1);
		expect(applyPatch[0].name).toBe("apply_patch");
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

describe("deepseek-web throttle retry", () => {
	const THROTTLE_HINT =
		'{"type":"error","content":"Messages too frequent. Try again later.","clear_response":true,"finish_reason":"rate_limit_reached"}';

	function sseStream(lines: string): ReadableStream<Uint8Array> {
		const bytes = new TextEncoder().encode(lines);
		return new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		});
	}

	function powChallenge() {
		// The solver walks nonces until SHA3-256(`${salt}_${expire_at}_${nonce}`)
		// matches, so the challenge has to be a real digest of a reachable nonce.
		const salt = "salt";
		const expireAt = 1;
		return {
			algorithm: "DeepSeekHashV1",
			challenge: sha3_256Hex(`${salt}_${expireAt}_3`),
			salt,
			signature: "sig",
			difficulty: 10,
			expire_at: expireAt,
			expire_after: 10,
			target_path: "/api/v0/chat/completion",
		};
	}

	/** A fetch that throttles the first `throttleCount` completion POSTs. */
	function fakeFetch(throttleCount: number) {
		let completions = 0;
		const impl = (async (url: string | URL | Request) => {
			const href = String(url);
			const json = (body: unknown) =>
				new Response(JSON.stringify(body), { status: 200 });
			if (href.includes("/users/current")) {
				return json({ data: { biz_data: { token: "access" } } });
			}
			if (href.includes("/chat_session/create")) {
				return json({
					data: { biz_data: { chat_session: { id: "session-1" } } },
				});
			}
			if (href.includes("/chat_session/delete")) return json({});
			if (href.includes("create_pow_challenge")) {
				return json({ data: { biz_data: { challenge: powChallenge() } } });
			}
			completions++;
			const body =
				completions <= throttleCount
					? `event: hint\ndata: ${THROTTLE_HINT}\n\n`
					: 'data: {"p":"response/fragments","v":[{"type":"ANSWER","content":"hello"}]}\n\n';
			return new Response(sseStream(body), { status: 200 });
		}) as unknown as typeof fetch;
		return { impl, completions: () => completions };
	}

	const noSleep = async () => {};

	it("waits and resends instead of failing the turn", async () => {
		const fetchStub = fakeFetch(1);
		const waits: number[] = [];

		const result = await runCompletion({
			userToken: "token",
			modelId: "deepseek-chat",
			prompt: "hi",
			fetchImpl: fetchStub.impl,
			sleepImpl: async (ms) => {
				waits.push(ms);
			},
			onRateLimitRetry: ({ waitMs }) => waits.push(-waitMs),
		});

		expect(result.text).toBe("hello");
		// Two completion POSTs: the throttled one and the retry.
		expect(fetchStub.completions()).toBe(2);
		// The retry was announced before the wait, so the CLI can say why it
		// is idle for a minute.
		expect(waits).toContain(-60_000);
	});

	it("gives up with an actionable error once the retries run out", async () => {
		const previous = process.env.DEEPSEEK_WEB_RATE_LIMIT_MAX_RETRIES;
		process.env.DEEPSEEK_WEB_RATE_LIMIT_MAX_RETRIES = "1";
		try {
			const fetchStub = fakeFetch(Number.POSITIVE_INFINITY);
			await expect(
				runCompletion({
					userToken: "token",
					modelId: "deepseek-chat",
					prompt: "hi",
					fetchImpl: fetchStub.impl,
					sleepImpl: noSleep,
				}),
			).rejects.toThrow(/Still throttled after 1 retry/);
			// One original send plus the single configured retry.
			expect(fetchStub.completions()).toBe(2);
		} finally {
			if (previous === undefined) {
				delete process.env.DEEPSEEK_WEB_RATE_LIMIT_MAX_RETRIES;
			} else {
				process.env.DEEPSEEK_WEB_RATE_LIMIT_MAX_RETRIES = previous;
			}
		}
	});

	it("does not retry a non-throttle failure", async () => {
		let calls = 0;
		const fetchImpl = (async (url: string | URL | Request) => {
			if (String(url).includes("/users/current")) {
				calls++;
				return new Response("nope", { status: 401 });
			}
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;

		await expect(
			runCompletion({
				userToken: "token",
				modelId: "deepseek-chat",
				prompt: "hi",
				fetchImpl,
				sleepImpl: noSleep,
			}),
		).rejects.toThrow(/invalid or expired/);
		expect(calls).toBe(1);
	});
});
