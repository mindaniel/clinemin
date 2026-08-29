import type { LanguageModelV2Prompt } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONTINUATION_NOTE } from "./continuation-note";
import {
	realUserMessageKey,
	stripPreviousUserBlock,
} from "./previous-user-dedupe";

function user(text: string): LanguageModelV2Prompt[number] {
	return { role: "user", content: [{ type: "text", text }] };
}

function tool(text: string): LanguageModelV2Prompt[number] {
	return { role: "tool", content: [{ type: "text", text }] } as never;
}

describe("realUserMessageKey", () => {
	it("ignores the runtime's continuation note", () => {
		const typedOnly: LanguageModelV2Prompt = [user("do the thing")];
		const afterToolRound: LanguageModelV2Prompt = [
			user("do the thing"),
			tool("result"),
			user(DEFAULT_CONTINUATION_NOTE),
		];
		// Same key across the iteration turn, so the instruction is sent once.
		expect(realUserMessageKey(afterToolRound)).toBe(
			realUserMessageKey(typedOnly),
		);
	});

	it("changes when the user types again, even with identical text", () => {
		const first: LanguageModelV2Prompt = [user("again")];
		const second: LanguageModelV2Prompt = [
			user("again"),
			tool("result"),
			user(DEFAULT_CONTINUATION_NOTE),
			user("again"),
		];
		expect(realUserMessageKey(second)).not.toBe(realUserMessageKey(first));
	});

	it("is empty when the user has typed nothing", () => {
		expect(realUserMessageKey([user(DEFAULT_CONTINUATION_NOTE)])).toBe("");
	});
});

describe("stripPreviousUserBlock", () => {
	it("drops the block but keeps tool results and the note", () => {
		const prompt = [
			"Previous user message: do the thing",
			"Tool result: 42",
			`Note: ${DEFAULT_CONTINUATION_NOTE}`,
		].join("\n\n");
		expect(stripPreviousUserBlock(prompt)).toBe(
			`Tool result: 42\n\nNote: ${DEFAULT_CONTINUATION_NOTE}`,
		);
	});

	it("strips it even when a re-injected system prompt comes first", () => {
		const prompt = [
			"You are a helpful agent.",
			"Previous user message: do the thing",
			"Tool result: 42",
		].join("\n\n");
		expect(stripPreviousUserBlock(prompt)).toBe(
			"You are a helpful agent.\n\nTool result: 42",
		);
	});

	it("handles a multi-line instruction with no trailing blocks", () => {
		const prompt = "Previous user message: line one\nline two";
		expect(stripPreviousUserBlock(prompt)).toBe("");
	});

	it("keeps the current instruction, which carries its own label", () => {
		// Providers strip unconditionally now, so the turn the user just typed
		// has to survive: `messagesToPrompt` labels it `User:`, never
		// `Previous user message:`.
		const prompt = [
			"Previous user message: an older ask",
			"Assistant: sure",
			"User: the new ask",
		].join("\n\n");
		expect(stripPreviousUserBlock(prompt)).toBe(
			"Assistant: sure\n\nUser: the new ask",
		);
	});
});
