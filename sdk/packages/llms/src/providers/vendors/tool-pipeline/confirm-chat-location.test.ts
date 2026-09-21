import { describe, expect, it, vi } from "vitest";
import {
	ChatNotReachableError,
	confirmChatLocation,
	urlNamesChat,
} from "./confirm-chat-location";

/**
 * A CDP stub whose tab sits on `before` until `Page.navigate` is sent, and on
 * `after` from then on.
 */
function fakeCdp(before: string, after = before) {
	let navigated = false;
	const sent: string[] = [];
	return {
		sent,
		send: vi.fn(async (method: string, params?: { expression?: string }) => {
			sent.push(method);
			if (method === "Page.navigate") navigated = true;
			if (
				method === "Runtime.evaluate" &&
				params?.expression === "window.location.href"
			) {
				return { result: { value: navigated ? after : before } };
			}
			return {};
		}),
	};
}

const noSleep = async () => undefined;

describe("urlNamesChat", () => {
	it("matches the id as a whole path segment", () => {
		expect(
			urlNamesChat(
				"https://gemini.google.com/app/a537e357bb906b4d",
				"a537e357bb906b4d",
			),
		).toBe(true);
		expect(
			urlNamesChat("https://gemini.google.com/app", "a537e357bb906b4d"),
		).toBe(false);
		// A different chat whose id merely starts the same must not count.
		expect(
			urlNamesChat(
				"https://gemini.google.com/app/a537e357bb906b4dff",
				"a537e357bb906b4d",
			),
		).toBe(false);
	});
});

describe("confirmChatLocation", () => {
	const base = {
		cdpSessionId: "s",
		provider: "gemini-web",
		chatId: "a537e357bb906b4d",
		chatUrl: "https://gemini.google.com/app/a537e357bb906b4d",
		sleepImpl: noSleep,
	};

	it("does nothing when the tab is already on the saved chat", async () => {
		const cdp = fakeCdp(base.chatUrl);
		const waitReady = vi.fn(async () => undefined);
		await confirmChatLocation({ ...base, cdp: cdp as never, waitReady });
		expect(cdp.sent).not.toContain("Page.navigate");
		expect(waitReady).not.toHaveBeenCalled();
	});

	it("navigates again when the tab landed on a new chat, and succeeds", async () => {
		// The Gemini case: a just-opened tab's own routing left it on /app.
		const cdp = fakeCdp("https://gemini.google.com/app", base.chatUrl);
		const waitReady = vi.fn(async () => undefined);
		const realNow = Date.now;
		let now = 0;
		Date.now = () => (now += 100);
		try {
			await confirmChatLocation({ ...base, cdp: cdp as never, waitReady });
		} finally {
			Date.now = realNow;
		}
		expect(cdp.sent).toContain("Page.navigate");
		expect(waitReady).toHaveBeenCalledTimes(1);
	});

	it("refuses to send when the saved chat never opens", async () => {
		const cdp = fakeCdp("https://gemini.google.com/app");
		const realNow = Date.now;
		let now = 0;
		Date.now = () => (now += 500);
		try {
			await expect(
				confirmChatLocation({
					...base,
					cdp: cdp as never,
					waitReady: async () => undefined,
				}),
			).rejects.toBeInstanceOf(ChatNotReachableError);
		} finally {
			Date.now = realNow;
		}
	});
});
