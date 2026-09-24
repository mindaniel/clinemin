import { describe, expect, it, vi } from "vitest";
import { readWebSessionStatus } from "../hooks/use-agent-events";
import {
	createContextBar,
	formatResetTime,
	formatStatusBarUsageText,
	resolveContextBarFilledForeground,
	resolveModelDisplayName,
} from "./status-bar";

vi.mock("@opentui/react", () => ({
	useTerminalDimensions: () => ({ width: 80, height: 24 }),
}));

describe("createContextBar", () => {
	it("keeps a stable width while changing segment lengths", () => {
		expect(createContextBar(0, 100)).toEqual({
			filled: "",
			empty: "\u2588\u2588\u2588\u2588\u2588\u2588",
		});
		expect(createContextBar(50, 100)).toEqual({
			filled: "\u2588\u2588\u2588",
			empty: "\u2588\u2588\u2588",
		});
		expect(createContextBar(100, 100)).toEqual({
			filled: "\u2588\u2588\u2588\u2588\u2588\u2588",
			empty: "",
		});
	});

	it("shows a non-empty fill when usage is above zero", () => {
		expect(createContextBar(7_000, 1_000_000)).toEqual({
			filled: "\u2588",
			empty: "\u2588\u2588\u2588\u2588\u2588",
		});
	});

	it("reserves the final segment for usage at or above the limit", () => {
		expect(createContextBar(999_999, 1_000_000)).toEqual({
			filled: "\u2588\u2588\u2588\u2588\u2588",
			empty: "\u2588",
		});
		expect(createContextBar(1_000_000, 1_000_000)).toEqual({
			filled: "\u2588\u2588\u2588\u2588\u2588\u2588",
			empty: "",
		});
	});

	it("uses explicit white when terminal foreground would inherit gray", () => {
		expect(resolveContextBarFilledForeground(undefined)).toBe("#ffffff");
		expect(resolveContextBarFilledForeground("#1a1a1a")).toBe("#1a1a1a");
	});
});

describe("formatStatusBarUsageText", () => {
	it("includes cost when usage cost is visible", () => {
		expect(
			formatStatusBarUsageText({
				totalTokens: 12_345,
				totalCost: 0.123,
				providerId: "cline",
			}),
		).toBe("(12,345) $0.12");
	});

	it("rounds cost to two decimals even when tiny", () => {
		expect(
			formatStatusBarUsageText({
				totalTokens: 12_345,
				totalCost: 0.0004,
				providerId: "cline",
			}),
		).toBe("(12,345) $0.00");
	});

	it("hides cost entirely for subscription providers", () => {
		expect(
			formatStatusBarUsageText({
				totalTokens: 12_345,
				totalCost: 0.123,
				providerId: "cline-pass",
			}),
		).toBe("(12,345)");
	});

	it("shows used/total context when the effective limit is known", () => {
		expect(
			formatStatusBarUsageText({
				totalTokens: 60_000,
				totalCost: 0.123,
				providerId: "cline-pass",
				maxInputTokens: 1_000_000,
			}),
		).toBe("(60k/1M)");
	});

	it("formats fractional used totals compactly", () => {
		expect(
			formatStatusBarUsageText({
				totalTokens: 6_300,
				totalCost: 0.123,
				providerId: "cline-pass",
				maxInputTokens: 200_000,
			}),
		).toBe("(6.3k/200k)");
	});

	it("keeps the bare token count when no limit is known", () => {
		expect(
			formatStatusBarUsageText({
				totalTokens: 12_345,
				totalCost: 0.123,
				providerId: "cline-pass",
				maxInputTokens: 0,
			}),
		).toBe("(12,345)");
	});

	it("shows ChatGPT Web's remaining messages instead of tokens", () => {
		const now = new Date("2026-08-25T20:00:00Z");
		const resetsAt = "2026-08-26T00:29:00Z";
		const time = new Date(resetsAt).toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});
		expect(
			formatStatusBarUsageText({
				totalTokens: 60_000,
				totalCost: 0,
				providerId: "chatgpt-web",
				maxInputTokens: 1_000_000,
				webSessionStatus: { messagesRemaining: 148, resetsAt },
				now,
			}),
		).toBe(`(148 messages left · resets ${time})`);
	});

	it("says the limit was reached instead of counting zero messages", () => {
		// ChatGPT keeps answering on a fallback model once the metered one is
		// capped, so "0 messages left" would read as "session over".
		const now = new Date("2026-09-17T20:35:00Z");
		const resetsAt = "2026-09-18T01:18:40Z";
		const time = new Date(resetsAt).toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});
		expect(
			formatStatusBarUsageText({
				totalTokens: 60_000,
				totalCost: 0,
				providerId: "chatgpt-web",
				webSessionStatus: { messagesRemaining: 0, resetsAt },
				now,
			}),
		).toBe(`(limit reached · resets ${time})`);
	});

	it("still says the limit was reached with no reset time", () => {
		expect(
			formatStatusBarUsageText({
				totalTokens: 60_000,
				totalCost: 0,
				providerId: "chatgpt-web",
				webSessionStatus: { messagesRemaining: 0 },
			}),
		).toBe("(limit reached · reset time unknown)");
	});

	it("shows a placeholder for ChatGPT Web before the first reply", () => {
		expect(
			formatStatusBarUsageText({
				totalTokens: 60_000,
				totalCost: 0,
				providerId: "chatgpt-web",
				maxInputTokens: 1_000_000,
			}),
		).toBe("(messages left: —)");
	});

	it("counts Grok's remaining queries against its window", () => {
		expect(
			formatStatusBarUsageText({
				totalTokens: 60_000,
				totalCost: 0,
				providerId: "grok-web",
				maxInputTokens: 1_000_000,
				webSessionStatus: { messagesRemaining: 17, messagesTotal: 20 },
			}),
		).toBe("(17/20 queries left)");
	});

	it("shows a placeholder for Grok before its limits are read", () => {
		expect(
			formatStatusBarUsageText({
				totalTokens: 60_000,
				totalCost: 0,
				providerId: "grok-web",
			}),
		).toBe("(queries left: —)");
	});

	it("shows Kimi's subscription percentage like Claude Web's", () => {
		expect(
			formatStatusBarUsageText({
				totalTokens: 60_000,
				totalCost: 0,
				providerId: "kimi-web",
				maxInputTokens: 1_000_000,
				webSessionStatus: { percent: 37.5 },
			}),
		).toBe("(37.5/100%)");
	});

	it("adds the date to a reset more than a day away", () => {
		const text = formatResetTime(
			"2026-09-24T22:00:00Z",
			new Date("2026-09-17T10:00:00Z"),
		);
		expect(text).toContain(
			new Date("2026-09-24T22:00:00Z").toLocaleDateString([], {
				month: "short",
				day: "numeric",
			}),
		);
	});
});

describe("readWebSessionStatus", () => {
	it("reads ChatGPT Web's message allowance", () => {
		expect(
			readWebSessionStatus({
				"chatgpt-web": {
					messagesRemaining: 12,
					messagesResetAt: "2026-08-26T00:29:00Z",
				},
			}),
		).toEqual({ messagesRemaining: 12, resetsAt: "2026-08-26T00:29:00Z" });
	});

	it("reads Grok's remaining queries, including the window size", () => {
		expect(
			readWebSessionStatus({
				"grok-web": {
					messagesRemaining: 17,
					messagesTotal: 20,
					messagesResetAt: "2026-08-26T00:29:00Z",
				},
			}),
		).toEqual({
			messagesRemaining: 17,
			messagesTotal: 20,
			resetsAt: "2026-08-26T00:29:00Z",
		});
	});

	it("reads Kimi's subscription percentage", () => {
		expect(
			readWebSessionStatus({
				"kimi-web": {
					sessionPercent: 37.5,
					sessionResetsAt: "2026-10-01T00:00:00Z",
				},
			}),
		).toEqual({ percent: 37.5, resetsAt: "2026-10-01T00:00:00Z" });
	});

	it("still reads Claude Web's session percentage", () => {
		expect(
			readWebSessionStatus({ "claude-web": { sessionPercent: 42 } }),
		).toEqual({ percent: 42 });
		expect(readWebSessionStatus({ openai: {} })).toBeUndefined();
	});
});

describe("resolveModelDisplayName", () => {
	it("uses the friendly model name with a ClinePass prefix", () => {
		expect(
			resolveModelDisplayName({
				providerId: "cline-pass",
				modelId: "zai/glm-5.2",
				knownModels: {
					"zai/glm-5.2": { name: "GLM 5.2" },
				},
			}),
		).toBe("ClinePass: GLM 5.2");
	});

	it("falls back to the bare model id with a ClinePass prefix when unknown", () => {
		expect(
			resolveModelDisplayName({
				providerId: "cline-pass",
				modelId: "zai/glm-5.2",
			}),
		).toBe("ClinePass: glm-5.2");
	});

	it("keeps the reasoning effort next to the model name", () => {
		expect(
			resolveModelDisplayName({
				providerId: "cline-pass",
				modelId: "zai/glm-5.2",
				knownModels: {
					"zai/glm-5.2": { name: "GLM 5.2" },
				},
				thinking: true,
				reasoningEffort: "high",
			}),
		).toBe("ClinePass: GLM 5.2 (high)");
	});

	it("uses the friendly model name for non-ClinePass providers", () => {
		expect(
			resolveModelDisplayName({
				providerId: "cline",
				modelId: "zai/glm-5.2",
				knownModels: {
					"zai/glm-5.2": { name: "GLM 5.2" },
				},
			}),
		).toBe("GLM 5.2");
	});
});
