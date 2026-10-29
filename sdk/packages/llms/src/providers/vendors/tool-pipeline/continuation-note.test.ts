import { describe, expect, it } from "vitest";
import { keepManagerStatus } from "../claude-web/prompts";
import {
	DEFAULT_CONTINUATION_NOTE,
	isSyntheticUserText,
	splitManagerStatus,
} from "./continuation-note";

const status = "[Manager status: context 40% used (8000 of 20000 tokens).]";

describe("manager status on the continuation note", () => {
	it("still recognises the note with a status line on the end", () => {
		expect(isSyntheticUserText(`${DEFAULT_CONTINUATION_NOTE}\n${status}`)).toBe(
			true,
		);
	});

	it("keeps the handover sentence that follows the bracket", () => {
		const tail = `${status} You are past 90% of your context.`;
		expect(splitManagerStatus(`Note: go on\n${tail}`)).toEqual({
			body: "Note: go on",
			status: tail,
		});
	});

	it("leaves text without a status alone", () => {
		expect(splitManagerStatus("plain text")).toEqual({ body: "plain text" });
	});

	it("survives Claude Web dropping the Note segment", () => {
		expect(
			keepManagerStatus(["Tool result: x", `Note: go on\n${status}`]),
		).toEqual(["Tool result: x", "Note: go on", status]);
	});
});
