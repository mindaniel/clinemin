import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractRawWebMessage, RAW_WEB_MESSAGE_MARKER } from "@cline/shared";
import { describe, expect, it } from "vitest";
import type { ChatEntry } from "../types";
import {
	batchMessage,
	byFileName,
	isLimitNotice,
	parsePathList,
	replyAfter,
	replyPathFor,
	unrepliedBatches,
	wrongReplyReason,
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

describe("batch order and folders", () => {
	it("sorts batch files by number", () => {
		const list = ["b/batch_0010.txt", "b/batch_0009.txt", "a/batch_0100.txt"];
		expect([...list].sort(byFileName)).toEqual([
			"a/batch_0100.txt",
			"b/batch_0009.txt",
			"b/batch_0010.txt",
		]);
	});

	it("queues only the batches in a folder that have no reply", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "rb-"));
		const part = path.join(dir, "part01");
		mkdirSync(part);
		for (const n of ["batch_0002.txt", "batch_0010.txt", "batch_0001.txt"])
			writeFileSync(path.join(part, n), "x");
		writeFileSync(path.join(part, "batch_0001_reply.txt"), "y");
		writeFileSync(path.join(part, "batch_0010_reply_2.txt"), "y");
		expect(unrepliedBatches(dir).map((p) => path.basename(p))).toEqual([
			"batch_0002.txt",
		]);
	});
});

describe("wrongReplyReason", () => {
	const batch =
		"=== REPORT 4493 | ABC | SSI | 2023-01-01 ===\ntext\n=== REPORT 4491 | XYZ | VCSC | 2023-01-02 ===\n";
	const own =
		'{"report_id": "4493", "forecasts": []}\n{"report_id": "4491", "forecasts": []}';
	const stale =
		'{"report_id": "4455", "forecasts": []}\n{"report_id": "4458", "forecasts": []}';

	it("accepts the batch's own answer", () => {
		expect(wrongReplyReason(batch, own, stale)).toBeUndefined();
		expect(wrongReplyReason(batch, own, null)).toBeUndefined();
	});

	it("rejects the previous reply handed back again", () => {
		expect(wrongReplyReason(batch, `${stale}\n`, stale)).toMatch(/same as/);
	});

	it("rejects a reply for other reports", () => {
		expect(wrongReplyReason(batch, stale, null)).toMatch(/other reports/);
	});

	it("does not judge replies without report IDs", () => {
		expect(
			wrongReplyReason("plain batch", "plain answer", "other"),
		).toBeUndefined();
	});
});
