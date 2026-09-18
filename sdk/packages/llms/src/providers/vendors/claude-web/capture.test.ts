import { describe, expect, it } from "vitest";
import { isFinishedReply } from "./capture";

const baseline = { count: 3, text: "previous reply" };

describe("isFinishedReply", () => {
	it("accepts a new reply even when the node count cannot grow", () => {
		// claude.ai virtualises the transcript to ~3 nodes, so a long chat keeps
		// the same count forever. This is the case that used to hang the turn.
		expect(
			isFinishedReply(
				{ count: 3, streaming: false, text: "the new reply" },
				baseline,
			),
		).toBe(true);
	});

	it("accepts a reply that did grow the node count", () => {
		expect(
			isFinishedReply(
				{ count: 4, streaming: false, text: "the new reply" },
				baseline,
			),
		).toBe(true);
	});

	it("waits while the last node is still the previous reply", () => {
		expect(
			isFinishedReply(
				{ count: 3, streaming: false, text: "  previous reply  " },
				baseline,
			),
		).toBe(false);
	});

	it("waits while the reply is still streaming", () => {
		expect(
			isFinishedReply(
				{ count: 4, streaming: true, text: "half a rep" },
				baseline,
			),
		).toBe(false);
	});

	it("waits on an empty reply node", () => {
		expect(
			isFinishedReply({ count: 4, streaming: false, text: "   " }, baseline),
		).toBe(false);
	});

	it("waits when the page could not be read", () => {
		expect(isFinishedReply(undefined, baseline)).toBe(false);
	});
});
