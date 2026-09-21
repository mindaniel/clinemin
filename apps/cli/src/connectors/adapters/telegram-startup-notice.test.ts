import { describe, expect, it, vi } from "vitest";
import {
	buildTelegramStartupNotice,
	sendTelegramStartupNotice,
} from "./telegram-startup-notice";

const baseInput = {
	botUsername: "my_bot",
	cliVersion: "1.2.3",
	pid: 4242,
	rpcAddress: "127.0.0.1:7777",
	cwd: "C:\\work\\repo",
	provider: "deepseek-web",
	model: "deepseek-reasoner",
	mode: "act",
	enableTools: true,
	hostname: "DESKTOP-A",
	startedAt: new Date("2026-09-20T12:00:00.000Z"),
};

describe("buildTelegramStartupNotice", () => {
	it("names the process, machine and version so the right one is identifiable", () => {
		const text = buildTelegramStartupNotice(baseInput);
		// Everything needed to tell two bots on one token apart.
		expect(text).toContain("v1.2.3");
		expect(text).toContain("@my_bot");
		expect(text).toContain("DESKTOP-A pid 4242");
		expect(text).toContain("C:\\work\\repo");
		expect(text).toContain("deepseek-web/deepseek-reasoner");
		expect(text).toContain("mode: act, tools on");
		expect(text).toContain("127.0.0.1:7777");
		expect(text).toContain("2026-09-20T12:00:00.000Z");
		// Says which program it is, since the example bridge answers alike.
		expect(text).toContain("cline connect telegram");
	});

	it("still reads cleanly when no provider or model is set", () => {
		const text = buildTelegramStartupNotice({
			...baseInput,
			provider: undefined,
			model: undefined,
			enableTools: false,
		});
		expect(text).toContain("model: (default)");
		expect(text).toContain("tools off");
	});
});

describe("sendTelegramStartupNotice", () => {
	it("posts the text to the configured chat", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify({ ok: true })));

		const result = await sendTelegramStartupNotice({
			botToken: "123:abc",
			chatId: "555",
			text: "hello",
			fetchImpl,
		});

		expect(result).toEqual({ ok: true });
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
		expect(JSON.parse(init.body)).toMatchObject({
			chat_id: "555",
			text: "hello",
		});
	});

	it("reports the API's own reason instead of throwing", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({ ok: false, description: "chat not found" }),
				{
					status: 400,
					statusText: "Bad Request",
				},
			),
		);

		const result = await sendTelegramStartupNotice({
			botToken: "123:abc",
			chatId: "555",
			text: "hello",
			fetchImpl,
		});

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toContain("chat not found");
	});

	it("survives a transport failure — a connector that cannot announce still runs", async () => {
		const fetchImpl = vi
			.fn()
			.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));

		const result = await sendTelegramStartupNotice({
			botToken: "123:abc",
			chatId: "555",
			text: "hello",
			fetchImpl,
		});

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toContain("ENOTFOUND");
	});
});
