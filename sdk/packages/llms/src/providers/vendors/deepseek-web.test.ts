import type {
	LanguageModelV2FunctionTool,
	LanguageModelV2Message,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
	messagesToPrompt,
	parseDeepSeekToolCalls,
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
	["a".repeat(136), "680364b336f77918ed390287a581f96f1371599825acd1e348fa7649fcecbbab"],
	// Multi-block input.
	["a".repeat(137), "dfeb7768d4d48053c083d849570e84cc8120520790f2d09cb56e40038081fab4"],
	// Non-ASCII input forces multi-byte UTF-8 encoding.
	["héllo wörld", "1fcbaafc8ccfea760b430346d482adbe49ee9f10f9ba3de78414a09d90514c92"],
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
			challenge: "311b26ae1e0fe7375e242958ce46db5552a6c67fea3f96880dcd846c63a74286",
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
			challenge: "41229b28a80e78ce87c90aaa17f415ca16f59ad857c8b14d65382a966b6d917a",
			salt: "a6b811dea4a94b24701f",
			signature: "d5285a52cd81eb1d360130f3d34f8d85a77db90fe1434c45446d978e512fe7ae",
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
		const { toolCalls } = parseDeepSeekToolCalls(reply, ["search"]);
		expect(toolCalls).toEqual([{ name: "search", arguments: { query: "cline" } }]);
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
});
