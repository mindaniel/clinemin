import { describe, expect, it, vi } from "vitest";
import {
	createContextBar,
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
