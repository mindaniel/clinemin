import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	newChatUrl,
	readTemporaryChat,
	temporaryButtonScript,
	writeTemporaryChat,
} from "./temporary-chat";

describe("temporary chat", () => {
	let dir: string;
	const saved = process.env.CLINE_DIR;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-temp-chat-"));
		process.env.CLINE_DIR = dir;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.CLINE_DIR;
		else process.env.CLINE_DIR = saved;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("is off by default and leaves new-chat URLs alone", () => {
		expect(readTemporaryChat()).toBe(false);
		expect(newChatUrl("chatgpt-web", "https://chatgpt.com/")).toBe("https://chatgpt.com/");
	});

	it("switches the URL-based sites when on", () => {
		writeTemporaryChat(true);
		expect(readTemporaryChat()).toBe(true);
		expect(newChatUrl("chatgpt-web", "https://chatgpt.com/")).toBe(
			"https://chatgpt.com/?temporary-chat=true",
		);
		expect(newChatUrl("qwen-web", "https://chat.qwen.ai/")).toBe(
			"https://chat.qwen.ai/?temporary-chat=true",
		);
		expect(newChatUrl("claude-web", "https://claude.ai/")).toBe(
			"https://claude.ai/new?incognito",
		);
		expect(newChatUrl("deepseek-web-v2", "https://chat.deepseek.com/")).toBe(
			"https://chat.deepseek.com/",
		);
	});

	it("has button scripts only for the button sites", () => {
		expect(temporaryButtonScript("gemini-web")).toContain("temporary chat");
		expect(temporaryButtonScript("grok-web")).toContain("private chat");
		expect(temporaryButtonScript("chatgpt-web")).toBeUndefined();
	});
});
