import type { AgentResult } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { diagnoseRun } from "./team-tools";

function runWith(
	messages: Array<{ role: string; metrics?: { inputTokens?: number } }>,
	aggregateInputTokens: number,
): AgentResult {
	return {
		text: "done",
		usage: { inputTokens: aggregateInputTokens, outputTokens: 1000 },
		messages,
		toolCalls: [],
		iterations: 132,
		finishReason: "completed",
		model: { id: "m", provider: "p", info: { contextWindow: 200000 } },
		startedAt: new Date(),
		endedAt: new Date(),
		durationMs: 1,
	} as unknown as AgentResult;
}

describe("diagnoseRun context reporting", () => {
	it("reports the last turn's context, not the run's aggregate", () => {
		// The aggregate sums every iteration's input tokens, so a long run looks
		// catastrophically over budget: 14.3M against a 200k window. A manager
		// told that kills a healthy worker.
		const diagnostics = diagnoseRun(
			runWith(
				[
					{ role: "assistant", metrics: { inputTokens: 90_000 } },
					{ role: "user" },
					{ role: "assistant", metrics: { inputTokens: 141_000 } },
				],
				14_300_000,
			),
			"deepseek",
		);

		expect(diagnostics.contextUsedTokens).toBe(141_000);
		expect(diagnostics.contextUsedPct).toBeCloseTo(70.5);
		expect(diagnostics.note ?? "").not.toContain("80%");
	});

	it("says nothing rather than guessing when no turn carries metrics", () => {
		const diagnostics = diagnoseRun(
			runWith([{ role: "assistant" }], 14_300_000),
			"qwen",
		);

		expect(diagnostics.contextUsedTokens).toBeUndefined();
		expect(diagnostics.contextUsedPct).toBeUndefined();
	});

	it("still warns when the last turn really is near the limit", () => {
		const diagnostics = diagnoseRun(
			runWith(
				[{ role: "assistant", metrics: { inputTokens: 180_000 } }],
				500_000,
			),
			"gemini",
		);

		expect(diagnostics.note).toContain("fresh");
	});
});
