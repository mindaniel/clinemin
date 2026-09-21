import { describe, expect, it, vi } from "vitest";
import {
	buildTelegramConnectArgs,
	looksLikeBotToken,
	maskBotToken,
	telegramBotIdFromToken,
	verifyTelegramBotToken,
} from "./telegram-connector-config";

describe("telegramBotIdFromToken", () => {
	it("reads the bot id out of a token", () => {
		expect(telegramBotIdFromToken("8569020955:AAH-abc")).toBe("8569020955");
	});

	it("returns nothing for a malformed token", () => {
		expect(telegramBotIdFromToken("")).toBeUndefined();
		expect(telegramBotIdFromToken("not-a-token")).toBeUndefined();
	});
});

describe("verifyTelegramBotToken", () => {
	it("names the bot the saved token belongs to", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					ok: true,
					result: { id: 8569020955, username: "Minhcline_bot" },
				}),
			),
		);

		const result = await verifyTelegramBotToken(
			"8569020955:AAH-abc",
			fetchImpl as unknown as typeof fetch,
		);

		expect(result).toEqual({
			ok: true,
			botId: "8569020955",
			username: "Minhcline_bot",
		});
		expect(fetchImpl.mock.calls[0][0]).toBe(
			"https://api.telegram.org/bot8569020955:AAH-abc/getMe",
		);
	});

	it("reports a revoked or mistyped token instead of looking like success", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), {
				status: 401,
				statusText: "Unauthorized",
			}),
		);

		const result = await verifyTelegramBotToken(
			"1:bad",
			fetchImpl as unknown as typeof fetch,
		);

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toContain("Unauthorized");
	});

	it("does not call Telegram when nothing was saved", async () => {
		const fetchImpl = vi.fn();
		const result = await verifyTelegramBotToken(
			"   ",
			fetchImpl as unknown as typeof fetch,
		);
		expect(result).toEqual({ ok: false, error: "no bot token saved" });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("survives a network failure", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
		const result = await verifyTelegramBotToken(
			"1:abc",
			fetchImpl as unknown as typeof fetch,
		);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toContain("ENOTFOUND");
	});
});

describe("whitespace in a pasted token", () => {
	it("is stripped from the middle, not only the ends", () => {
		// A token pasted into a terminal box can arrive broken mid-string; left
		// as-is it produces a 404 that looks nothing like a paste problem.
		expect(
			buildTelegramConnectArgs({
				botToken: " 8569020955: AAH-abc\n",
				chatId: " 8524560136 ",
			}),
		).toEqual(["-k", "8569020955:AAH-abc", "--allowed-user-id", "8524560136"]);
	});
});

describe("buildTelegramConnectArgs", () => {
	it("passes the chat id as the allow-list id, which is also the announce target", () => {
		expect(
			buildTelegramConnectArgs({ botToken: "1:abc", chatId: "8524560136" }),
		).toEqual(["-k", "1:abc", "--allowed-user-id", "8524560136"]);
	});
});

describe("looksLikeBotToken", () => {
	it("accepts a real token shape and rejects mangled pastes", () => {
		expect(
			looksLikeBotToken("8569020955:AAH1234567890abcdefghijklmnopqrstuv"),
		).toBe(true);
		// A space mid-token is what a terminal paste actually produced.
		expect(
			looksLikeBotToken("8569020955: AAH1234567890abcdefghijklmnopqrstuv"),
		).toBe(true);
		// Half-pasted secret, no colon, or nothing at all.
		expect(looksLikeBotToken("8569020955:AAH")).toBe(false);
		expect(looksLikeBotToken("8569020955")).toBe(false);
		expect(looksLikeBotToken("")).toBe(false);
	});
});

describe("maskBotToken", () => {
	it("shows enough to tell two tokens apart without printing the secret", () => {
		const masked = maskBotToken("8569020955:AAH1234567890abcdefghijklmnopqrs");
		expect(masked).toContain("8569020955");
		expect(masked).toContain("pqrs");
		expect(masked).not.toContain("AAH1234567890");
		expect(masked).toContain("chars");
		expect(maskBotToken("")).toBe("(none)");
	});
});
