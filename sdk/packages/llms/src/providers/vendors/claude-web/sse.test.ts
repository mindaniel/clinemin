import { describe, expect, it } from "vitest";
import { consumeClaudeSse } from "./sse";

function sessionPercentOf(event: unknown): {
	percent?: number;
	resetsAt?: string;
} {
	let result: { percent?: number; resetsAt?: string } = {};
	consumeClaudeSse(
		`event: message_limit\ndata: ${JSON.stringify(event)}\n\n`,
		() => {},
		() => {},
		() => {},
		undefined,
		undefined,
		(percent, resetsAt) => {
			result = { percent, resetsAt };
		},
	);
	return result;
}

describe("consumeClaudeSse session percentage", () => {
	it("reads Claude's resolved session limit", () => {
		expect(
			sessionPercentOf({
				type: "message_limit",
				message_limit: {
					windows: { "5h": { utilization: 0.03, resets_at: 1789224600 } },
					resolved: {
						limit: { percent: 3, resets_at: "2026-09-12T14:50:00+00:00" },
					},
				},
			}),
		).toEqual({ percent: 3, resetsAt: "2026-09-12T14:50:00+00:00" });
	});

	it("falls back to the five-hour window when there is no summary", () => {
		expect(
			sessionPercentOf({
				type: "message_limit",
				message_limit: {
					windows: { "5h": { utilization: 0.425, resets_at: 1789224600 } },
				},
			}),
		).toEqual({
			percent: 42.5,
			resetsAt: new Date(1789224600 * 1000).toISOString(),
		});
	});
});
