import type { LanguageModelV2Prompt } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
	applySimpleWebSystemPrompt,
	isStockWebSystemPrompt,
	SIMPLE_WEB_SYSTEM_PROMPT,
} from "./simple-system-prompt";

const STOCK = "# ROLE & OBJECTIVE\n# CRITICAL TOOL CALLING PROTOCOL\n<tool>...";
const TEAMMATE = `${STOCK}\n\n# Team Teammate Role\nRead files and report.`;
const MANAGER = "You are a manager. Delegate with <manager> blocks.";

function systemPrompt(content: string): LanguageModelV2Prompt {
	return [
		{ role: "system", content },
		{ role: "user", content: [{ type: "text", text: "hi" }] },
	];
}

function systemOf(prompt: LanguageModelV2Prompt): string {
	const message = prompt.find((m) => m.role === "system");
	return message?.role === "system" ? message.content : "";
}

describe("isStockWebSystemPrompt", () => {
	it("matches the stock coding-agent prompt", () => {
		expect(isStockWebSystemPrompt(STOCK)).toBe(true);
	});

	it("rejects a teammate prompt, which needs the tool contract", () => {
		expect(isStockWebSystemPrompt(TEAMMATE)).toBe(false);
	});

	it("rejects a manager prompt, which has no tool contract at all", () => {
		expect(isStockWebSystemPrompt(MANAGER)).toBe(false);
	});
});

describe("applySimpleWebSystemPrompt", () => {
	it("replaces the stock prompt", () => {
		expect(systemOf(applySimpleWebSystemPrompt(systemPrompt(STOCK)))).toBe(
			SIMPLE_WEB_SYSTEM_PROMPT,
		);
	});

	it("leaves a teammate prompt alone", () => {
		expect(systemOf(applySimpleWebSystemPrompt(systemPrompt(TEAMMATE)))).toBe(
			TEAMMATE,
		);
	});

	it("leaves a manager prompt alone", () => {
		expect(systemOf(applySimpleWebSystemPrompt(systemPrompt(MANAGER)))).toBe(
			MANAGER,
		);
	});

	it("does not touch non-system messages", () => {
		const result = applySimpleWebSystemPrompt(systemPrompt(STOCK));
		expect(result[1]).toEqual({
			role: "user",
			content: [{ type: "text", text: "hi" }],
		});
	});
});

describe("SIMPLE_WEB_SYSTEM_PROMPT", () => {
	it("teaches the patch grammar the apply_patch parser accepts", () => {
		expect(SIMPLE_WEB_SYSTEM_PROMPT).toContain("*** Begin Patch");
		expect(SIMPLE_WEB_SYSTEM_PROMPT).toContain("*** Update File: ");
		expect(SIMPLE_WEB_SYSTEM_PROMPT).toContain("*** End Patch");
	});

	it("does not ask for PowerShell that writes files", () => {
		expect(SIMPLE_WEB_SYSTEM_PROMPT).toContain(
			"do not send PowerShell code that writes to the file",
		);
	});
});
