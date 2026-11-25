import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractRawWebMessage, RAW_WEB_MESSAGE_MARKER } from "@cline/shared";
import { describe, expect, it } from "vitest";
import type { ChatEntry } from "../types";
import {
	batchMessage,
	isLimitNotice,
	parsePathList,
	replyAfter,
	replyPathFor,
} from "./use-batch-runner";

describe("runbatch helpers", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "runbatch "));
	const a = path.join(dir, "batch_01.txt");
	const b = path.join(dir, "batch_02.txt");
	writeFileSync(a, "x");
	writeFileSync(b, "y");

	it("parses dragged paths: quoted, one per line or several on a line", () => {
		expect(parsePathList(`"${a}"\n"${b}"`)).toEqual([a, b]);
		expect(parsePathList(`"${a}" "${b}"`)).toEqual([a, b]);
		// unquoted path with a space in the folder name, whole line
		expect(parsePathList(a)).toEqual([a]);
	});

	it("names replies next to the batch without overwriting", () => {
		const first = replyPathFor(a);
		expect(first).toBe(path.join(dir, "batch_01_reply.txt"));
		writeFileSync(first, "r");
		expect(replyPathFor(a)).toBe(path.join(dir, "batch_01_reply_2.txt"));
	});

	it("marks web messages to be sent verbatim", () => {
		expect(batchMessage(" B ", false)).toBe("B");
		expect(batchMessage(" B ", true)).toBe(`${RAW_WEB_MESSAGE_MARKER}\nB`);
		const wrapped = `<user_input mode="act">${batchMessage("P", true)}</user_input>`;
		expect(
			extractRawWebMessage([
				{ role: "system", content: "SYSTEM PROMPT" },
				{ role: "user", content: [{ type: "text", text: wrapped }] },
			]),
		).toBe("P");
		expect(
			extractRawWebMessage([{ role: "user", content: "plain" }]),
		).toBeUndefined();
		// a chat tag changes the message (so a new web chat opens), not the text sent
		const tagged = batchMessage("P", true, "k1");
		expect(tagged).not.toBe(batchMessage("P", true));
		expect(extractRawWebMessage([{ role: "user", content: tagged }])).toBe("P");
	});

	it("collects assistant text after the marker only", () => {
		const marker: ChatEntry = { kind: "status", text: "m" };
		const entries = [
			{ kind: "assistant_text", text: "old", streaming: false },
			marker,
			{ kind: "assistant_text", text: "one", streaming: false },
			{ kind: "status", text: "x" },
			{ kind: "assistant_text", text: "two", streaming: false },
		] as ChatEntry[];
		expect(replyAfter(entries, marker)).toBe("one\n\ntwo");
		// a copy of the marker (appendEntry stamps the mode) still matches
		expect(replyAfter(entries, { kind: "status", text: "m" })).toBe(
			"one\n\ntwo",
		);
		expect(replyAfter(entries, { kind: "status", text: "other" })).toBe("");
	});
});

describe("isLimitNotice", () => {
	it("spots a site's limit notice but not an answer", () => {
		expect(
			isLimitNotice(
				"You've reached your daily limit. Get more usage now or check back at 12:00 AM.",
			),
		).toBe(true);
		expect(isLimitNotice('{"report_id": "1", "forecasts": []}')).toBe(false);
	});
});
