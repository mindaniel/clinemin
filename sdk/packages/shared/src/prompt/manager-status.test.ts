import { describe, expect, it } from "vitest";
import { parseTeamRoster } from "../team/roster";
import {
	buildManagerStatusLine,
	buildManagerSystemPrompt,
	MANAGER_DONE_TOKEN,
	readManagerUsageLimit,
} from "./manager";

const now = new Date("2026-10-29T10:00:00Z");

describe("buildManagerStatusLine", () => {
	it("reports context use and when the limit resets", () => {
		const line = buildManagerStatusLine({
			contextUsedTokens: 50_000,
			contextWindow: 200_000,
			limit: { percent: 40, resetsAt: "2026-10-29T12:30:00Z" },
			now,
		});
		expect(line).toContain("context 25% used (50000 of 200000 tokens)");
		expect(line).toContain("usage limit 40% used, resets at");
		expect(line).toContain("(in 2h 30m)");
		expect(line).not.toContain("handover");
	});

	it("tells the manager to hand over past 90%", () => {
		const line = buildManagerStatusLine({
			contextUsedTokens: 185_000,
			contextWindow: 200_000,
			now,
		});
		expect(line).toContain("context 93% used");
		expect(line).toContain("handover summary");
		expect(line).toContain(MANAGER_DONE_TOKEN);
	});

	it("reports a message count limit", () => {
		expect(
			buildManagerStatusLine({
				limit: { messagesRemaining: 3, messagesTotal: 40 },
				now,
			}),
		).toBe("[Manager status: 3 of 40 messages left.]");
	});

	it("leaves out a reset time already past", () => {
		const line = buildManagerStatusLine({
			limit: { percent: 10, resetsAt: "2026-10-29T09:00:00Z" },
			now,
		});
		expect(line).toBe("[Manager status: usage limit 10% used.]");
	});

	it("sends nothing when there is nothing to report", () => {
		expect(buildManagerStatusLine({ now })).toBeUndefined();
	});
});

describe("readManagerUsageLimit", () => {
	it("reads a session percentage from any provider", () => {
		expect(
			readManagerUsageLimit({
				"claude-web": {
					sessionPercent: 61,
					sessionResetsAt: "2026-10-29T12:00:00Z",
				},
			}),
		).toEqual({ percent: 61, resetsAt: "2026-10-29T12:00:00Z" });
	});

	it("reads a remaining message count", () => {
		expect(
			readManagerUsageLimit({
				"grok-web": { messagesRemaining: 5, messagesResetAt: "x" },
			}),
		).toEqual({ messagesRemaining: 5, resetsAt: "x" });
	});

	it("ignores metadata with no limit in it", () => {
		expect(readManagerUsageLimit({ gateway: { cost: 1 } })).toBeUndefined();
		expect(readManagerUsageLimit(undefined)).toBeUndefined();
	});
});

describe("handover wording", () => {
	it("points at a <handover> block when there is a manager to hand to", () => {
		const line = buildManagerStatusLine({
			contextUsedTokens: 95,
			contextWindow: 100,
			canHandOver: true,
			now,
		});
		expect(line).toContain("<handover>");
		expect(line).not.toContain(MANAGER_DONE_TOKEN);
	});

	it("lists the other managers and the block in the prompt", () => {
		const prompt = buildManagerSystemPrompt({
			workers: [{ agentId: "qwen" }],
			managers: [{ agentId: "claude-2", notes: "second Claude account" }],
		});
		expect(prompt).toContain("- claude-2 — second Claude account");
		expect(prompt).toContain("<handover>\nTO: claude-2");
	});

	it("falls back to a final-answer summary with no other managers", () => {
		const prompt = buildManagerSystemPrompt({ workers: [{ agentId: "qwen" }] });
		expect(prompt).not.toContain("<handover>");
		expect(prompt).toContain("handover summary as your final answer");
	});
});

describe("roster managers", () => {
	it("parses a managers list", () => {
		const parsed = parseTeamRoster(
			JSON.stringify({
				version: 1,
				workers: [{ agentId: "qwen", rolePrompt: "edits" }],
				managers: [{ agentId: "claude-2", profile: "claude-second" }],
			}),
		);
		expect(parsed.ok && parsed.roster.managers?.[0]?.agentId).toBe("claude-2");
	});

	it("rejects a name used by both a worker and a manager", () => {
		const parsed = parseTeamRoster(
			JSON.stringify({
				version: 1,
				workers: [{ agentId: "claude-2", rolePrompt: "edits" }],
				managers: [{ agentId: "claude-2" }],
			}),
		);
		expect(parsed.ok).toBe(false);
	});
});
