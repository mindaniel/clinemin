import { describe, expect, it } from "vitest";
import {
	type ChatGPTQuotaSnapshot,
	mergeChatGPTMessageQuota,
	pickChatGPTMessageQuota,
} from "./quota";
import { consumeChatGPTSse } from "./sse";

const METADATA_EVENT =
	'data: {"type":"conversation_detail_metadata","banner_info":null,"blocked_features":[],"model_limits":[],"limits_progress":[{"feature_name":"deep_research","remaining":5,"reset_after":"2026-09-24T22:00:15.372094+00:00"},{"feature_name":"reason","remaining":148,"reset_after":"2026-08-26T00:29:49.924685+00:00"}],"default_model_slug":"auto"}';

// Captured verbatim from chatgpt.com on the turn the cap was reached, and on
// the turn after it. `limits_progress` goes to null and only the blocked
// features carry the account's reset time from then on.
const CAP_REACHED_EVENT =
	'data: {"type":"conversation_detail_metadata","blocked_features":[{"name":"file_upload","resets_after":"2026-09-18T01:18:40.634111+00:00","resets_after_text":"in 5 hours","limit":5.0},{"name":"image_gen","resets_after":"2026-09-18T01:18:40.658860+00:00","resets_after_text":"in 5 hours","limit":3.0}],"model_limits":[{"model_slug":"gpt-5-6","using_default_model_slug":"gpt-5-6","resets_after":"2026-09-18T01:18:40.605202+00:00","description":null}],"limits_progress":[{"feature_name":"reason","remaining":0,"reset_after":"2026-09-18T01:18:40.683777+00:00"}],"default_model_slug":"auto"}';
const EXHAUSTED_EVENT =
	'data: {"type":"conversation_detail_metadata","blocked_features":[{"name":"file_upload","resets_after":"2026-09-18T01:18:40.325441+00:00","resets_after_text":"in 5 hours","limit":5.0},{"name":"image_gen","resets_after":"2026-09-18T01:18:40.389897+00:00","resets_after_text":"in 5 hours","limit":3.0}],"model_limits":[],"limits_progress":null,"default_model_slug":"auto"}';

function snapshotOf(event: string): ChatGPTQuotaSnapshot | undefined {
	let snapshot: ChatGPTQuotaSnapshot | undefined;
	consumeChatGPTSse(
		`${event}\n\ndata: [DONE]\n`,
		() => {},
		() => {},
		() => {},
		undefined,
		(q) => {
			snapshot = q;
		},
	);
	return snapshot;
}

const emptySnapshot: ChatGPTQuotaSnapshot = {
	entries: [],
	modelLimits: [],
	blockedFeatures: [],
};

describe("ChatGPT web message quota", () => {
	it("reads the reason allowance out of a captured stream", () => {
		expect(pickChatGPTMessageQuota(snapshotOf(METADATA_EVENT))).toEqual({
			remaining: 148,
			resetsAt: "2026-08-26T00:29:49.924685+00:00",
		});
	});

	it("names the capped model on the turn the cap is reached", () => {
		expect(pickChatGPTMessageQuota(snapshotOf(CAP_REACHED_EVENT))).toEqual({
			remaining: 0,
			resetsAt: "2026-09-18T01:18:40.683777+00:00",
			limitedModel: "gpt-5-6",
		});
	});

	it("still finds the reset time once limits_progress goes null", () => {
		// The whole exhausted stretch used to show "—" here, which is exactly
		// when the reset time is the only thing worth knowing.
		expect(pickChatGPTMessageQuota(snapshotOf(EXHAUSTED_EVENT))).toEqual({
			remaining: 0,
			resetsAt: "2026-09-18T01:18:40.325441+00:00",
		});
	});

	it("falls back to a named model limit when no counter is sent", () => {
		expect(
			pickChatGPTMessageQuota({
				...emptySnapshot,
				modelLimits: [
					{ modelSlug: "gpt-5-6", resetsAfter: "2026-09-18T01:18:40Z" },
				],
			}),
		).toEqual({
			remaining: 0,
			resetsAt: "2026-09-18T01:18:40Z",
			limitedModel: "gpt-5-6",
		});
	});

	it("returns nothing when the stream carried no usable limit at all", () => {
		expect(
			pickChatGPTMessageQuota({
				...emptySnapshot,
				entries: [{ featureName: "image_gen", remaining: 25, resetAfter: "" }],
			}),
		).toBeUndefined();
		expect(pickChatGPTMessageQuota(undefined)).toBeUndefined();
	});

	it("ignores a blocked feature with no usable reset time", () => {
		expect(
			pickChatGPTMessageQuota({
				...emptySnapshot,
				blockedFeatures: [{ name: "file_upload", resetsAfter: "soon" }],
			}),
		).toBeUndefined();
	});

	it("drops an unparseable reset time but keeps the count", () => {
		expect(
			pickChatGPTMessageQuota({
				...emptySnapshot,
				entries: [{ featureName: "reason", remaining: 3, resetAfter: "soon" }],
			}),
		).toEqual({ remaining: 3 });
	});
});

describe("mergeChatGPTMessageQuota", () => {
	const previous = { remaining: 0, resetsAt: "2026-09-18T01:18:40Z" };

	it("prefers what this turn reported", () => {
		const next = { remaining: 12, resetsAt: "2026-09-19T01:18:40Z" };
		expect(mergeChatGPTMessageQuota(previous, next)).toEqual(next);
	});

	it("holds the last known answer on a turn that reported nothing", () => {
		expect(
			mergeChatGPTMessageQuota(
				previous,
				undefined,
				new Date("2026-09-18T00:00:00Z"),
			),
		).toEqual(previous);
	});

	it("expires it once the reset time has passed", () => {
		expect(
			mergeChatGPTMessageQuota(
				previous,
				undefined,
				new Date("2026-09-18T02:00:00Z"),
			),
		).toBeUndefined();
	});

	it("has nothing to hold when no quota was ever reported", () => {
		expect(mergeChatGPTMessageQuota(undefined, undefined)).toBeUndefined();
	});
});
