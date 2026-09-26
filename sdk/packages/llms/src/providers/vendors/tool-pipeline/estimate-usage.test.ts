import { describe, expect, it } from "vitest";
import {
	addToChatContext,
	estimateWebUsage,
	usageOrEstimate,
} from "./estimate-usage";

describe("estimateWebUsage", () => {
	it("counts prompt and reply at the repo-wide chars/3 rate", () => {
		const usage = estimateWebUsage("a".repeat(300), "b".repeat(600));
		expect(usage.inputTokens).toBe(100);
		expect(usage.outputTokens).toBe(200);
		expect(usage.totalTokens).toBe(300);
	});

	it("reports zero for an empty turn instead of NaN", () => {
		expect(estimateWebUsage("", "")).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
		});
	});
});

describe("usageOrEstimate", () => {
	it("keeps what the provider reported", () => {
		const usage = usageOrEstimate(
			{ inputTokens: 11, outputTokens: 22, totalTokens: 33 },
			"a".repeat(300),
			"b".repeat(600),
		);
		expect(usage).toEqual({
			inputTokens: 11,
			outputTokens: 22,
			totalTokens: 33,
		});
	});

	it("fills in only the side the provider left at zero", () => {
		const usage = usageOrEstimate(
			{ inputTokens: 0, outputTokens: 22, totalTokens: 0 },
			"a".repeat(300),
			"b".repeat(600),
		);
		expect(usage).toEqual({
			inputTokens: 100,
			outputTokens: 22,
			totalTokens: 122,
		});
	});

	it("estimates both sides when nothing was reported", () => {
		expect(
			usageOrEstimate(undefined, "a".repeat(300), "b".repeat(600)),
		).toEqual({ inputTokens: 100, outputTokens: 200, totalTokens: 300 });
	});
});

describe("addToChatContext", () => {
	it("reports the whole chat so far as this turn's input", () => {
		const turn = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };
		expect(addToChatContext("p-ctx", "chat", turn, true)).toEqual({
			inputTokens: 100,
			outputTokens: 50,
			totalTokens: 150,
		});
		// Second turn: the first prompt and reply are still in the chat.
		expect(addToChatContext("p-ctx", "chat", turn, false)).toEqual({
			inputTokens: 250,
			outputTokens: 50,
			totalTokens: 300,
		});
	});

	it("starts over for a new chat and keeps chats apart", () => {
		const turn = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
		addToChatContext("p-ctx2", "a", turn, true);
		addToChatContext("p-ctx2", "a", turn, false);
		expect(addToChatContext("p-ctx2", "b", turn, false).inputTokens).toBe(10);
		expect(addToChatContext("p-ctx2", "a", turn, true).inputTokens).toBe(10);
	});
});
