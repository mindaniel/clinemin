import { describe, expect, it } from "vitest";
import { parseReplyState, replyFinished } from "./dom-reply";

const done = (text: string) => ({ exists: true, busy: false, text });

describe("replyFinished", () => {
	it("waits until the reply exists", () => {
		expect(replyFinished([{ exists: false }, { exists: false }], 2)).toBe(
			false,
		);
	});

	it("waits while Gemini is still writing", () => {
		const busy = { exists: true, busy: true, text: "1,2" };
		expect(replyFinished([busy, busy, busy], 3)).toBe(false);
	});

	it("waits for the text to stop changing", () => {
		expect(replyFinished([done("a"), done("ab"), done("abc")], 3)).toBe(false);
	});

	it("does not finish on an empty reply", () => {
		expect(replyFinished([done(""), done(""), done("")], 3)).toBe(false);
	});

	it("finishes once the text is stable for enough polls", () => {
		expect(
			replyFinished([done("a"), done("abc"), done("abc"), done("abc")], 3),
		).toBe(true);
	});
});

describe("parseReplyState", () => {
	it("treats anything unreadable as not there yet", () => {
		expect(parseReplyState(undefined)).toEqual({ exists: false });
		expect(parseReplyState("not json")).toEqual({ exists: false });
	});

	it("reads the page script's JSON", () => {
		expect(parseReplyState('{"exists":true,"busy":false,"text":"OK"}')).toEqual(
			done("OK"),
		);
	});
});
