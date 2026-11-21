import { describe, expect, it } from "vitest";
import { geminiLimitProviderMetadata } from "./limit";
import { parseGeminiUsage } from "./usage";

// Trimmed from a real Settings > Usage response (a JSON array of deferred parts).
const BODY = JSON.stringify([
	{
		data: {
			viewer: {
				rpcs: {
					getUserStatus: { featureGates: ["CAN_SEE_USAGE_LIMITS"] },
					getUsageInfo: {
						subscriptionTier: "TIER0",
						pools: [
							{
								poolType: "GXU_FIVE_HOURLY",
								percentageUsed: 0.5,
								gxu: { windowRefreshesAt: "2026-11-21T16:55:48.498951Z" },
							},
							{
								poolType: "GXU_WEEKLY",
								percentageUsed: 0.02494821,
								gxu: { windowRefreshesAt: "2026-11-23T08:55:48.499182Z" },
							},
						],
					},
				},
			},
		},
		path: [],
	},
	{ data: { __typename: "Viewer" }, path: ["viewer"] },
]);

describe("parseGeminiUsage", () => {
	it("reads both pools and picks the fuller one", () => {
		const usage = parseGeminiUsage(BODY);
		expect(usage?.fiveHour?.percent).toBeCloseTo(50);
		expect(usage?.weekly?.percent).toBeCloseTo(2.494821);
		expect(usage?.binding.percent).toBeCloseTo(50);
		expect(usage?.binding.resetsAt).toBe("2026-11-21T16:55:48.498Z");
	});

	it("returns undefined for an empty or foreign body", () => {
		expect(parseGeminiUsage("")).toBeUndefined();
		expect(parseGeminiUsage("not json")).toBeUndefined();
		expect(parseGeminiUsage(JSON.stringify({ data: {} }))).toBeUndefined();
	});

	it("publishes the meter, and a full pool as the limit", () => {
		const usage = parseGeminiUsage(BODY);
		const meta = geminiLimitProviderMetadata(undefined, usage).providerMetadata[
			"gemini-web"
		] as Record<string, unknown>;
		expect(meta.limitReached).toBe(false);
		expect(meta.sessionPercent).toBeCloseTo(50);
		expect(meta.sessionResetsAt).toBe("2026-11-21T16:55:48.498Z");

		const full = parseGeminiUsage(
			BODY.replace('"percentageUsed":0.5', '"percentageUsed":1'),
		);
		const fullMeta = geminiLimitProviderMetadata(undefined, full)
			.providerMetadata["gemini-web"] as Record<string, unknown>;
		expect(fullMeta.limitReached).toBe(true);
		expect(fullMeta.limitResetsAt).toBe("2026-11-21T16:55:48.498Z");
	});
});
