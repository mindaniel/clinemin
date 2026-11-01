import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWithCliSession } from "../tool-pipeline/cli-session-scope";
import { fetchChatTitles, matchesMaskedEmail } from "./account";
import {
	listRegistrySessionIds,
	recordChatSession,
	setChatTitles,
} from "./chat-registry";

describe("matchesMaskedEmail", () => {
	it("matches the site's masked form", () => {
		expect(
			matchesMaskedEmail("qmn1@st-andrews.ac.uk", "q***@st-andrews.ac.uk"),
		).toBe(true);
		expect(
			matchesMaskedEmail("QMN1@St-Andrews.ac.uk", "q***@st-andrews.ac.uk"),
		).toBe(true);
	});

	it("rejects a different address", () => {
		expect(
			matchesMaskedEmail("xmn1@st-andrews.ac.uk", "q***@st-andrews.ac.uk"),
		).toBe(false);
		expect(
			matchesMaskedEmail("q@st-andrews.ac.uk", "q***@st-andrews.ac.uk"),
		).toBe(false);
		expect(
			matchesMaskedEmail("qmn1@stXandrews.ac.uk", "q***@st-andrews.ac.uk"),
		).toBe(false);
	});
});

/** A CDP stub that answers `fetch_page` from canned pages, keyed by cursor. */
function fakeCdp(pages: Record<string, unknown>) {
	const paths: string[] = [];
	return {
		paths,
		send: async (_method: string, params: { expression: string }) => {
			const apiPath = /fetch\("([^"]+)"/.exec(params.expression)?.[1] ?? "";
			paths.push(apiPath);
			const cursor = /updated_at=([\d.]+)/.exec(apiPath)?.[1] ?? "";
			return { result: { value: pages[cursor] ?? null } };
		},
	};
}

describe("fetchChatTitles", () => {
	it("follows the cursor until the wanted chats are found", async () => {
		const cdp = fakeCdp({
			"": {
				chat_sessions: [
					{ id: "a", title: "Alpha", updated_at: 30.5 },
					{ id: "b", title: " Beta ", updated_at: 20.5 },
				],
				has_more: true,
			},
			"20.5": {
				chat_sessions: [{ id: "c", title: "Gamma", updated_at: 10 }],
				has_more: true,
			},
		});
		const titles = await fetchChatTitles(cdp, "s", {
			wanted: new Set(["c"]),
		});
		expect([...titles]).toEqual([
			["a", "Alpha"],
			["b", "Beta"],
			["c", "Gamma"],
		]);
		expect(cdp.paths).toHaveLength(2);
		expect(cdp.paths[1]).toContain("lte_cursor.pinned=false");
	});

	it("returns nothing when signed out", async () => {
		const titles = await fetchChatTitles(fakeCdp({}), "s");
		expect(titles.size).toBe(0);
	});
});

describe("chat registry titles", () => {
	let dir: string;
	let chatsFile: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-titles-"));
		chatsFile = path.join(dir, "chats.json");
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("stores titles and keeps them across later turns", () => {
		runWithCliSession("cli-1", () =>
			recordChatSession(chatsFile, "key", "site-1"),
		);
		expect(setChatTitles(chatsFile, new Map([["site-1", "My chat"]]))).toBe(1);
		expect(setChatTitles(chatsFile, new Map([["site-1", "My chat"]]))).toBe(0);
		recordChatSession(chatsFile, "key", "site-1");
		const record = JSON.parse(fs.readFileSync(chatsFile, "utf-8")).key;
		expect(record.title).toBe("My chat");
		expect(record.cli_session_id).toBe("cli-1");
		expect(listRegistrySessionIds(chatsFile)).toEqual(["site-1"]);
	});

	it("drops the title when the key moves to another site chat", () => {
		recordChatSession(chatsFile, "key", "site-1");
		setChatTitles(chatsFile, new Map([["site-1", "Old"]]));
		recordChatSession(chatsFile, "key", "site-2");
		const record = JSON.parse(fs.readFileSync(chatsFile, "utf-8")).key;
		expect(record.title).toBeUndefined();
	});
});
