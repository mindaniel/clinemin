import { describe, expect, it } from "vitest";
import { getWebProviderPrompts } from "./prompt-registry";
import { SIMPLE_WEB_SYSTEM_PROMPT } from "./simple-system-prompt";

describe("getWebProviderPrompts", () => {
	it("returns undefined for a provider with no overrides", () => {
		// Undefined rather than {} so a caller spreading the result adds nothing
		// at all for the providers that have not been given a prompts file yet.
		expect(getWebProviderPrompts("cline")).toBeUndefined();
		expect(getWebProviderPrompts(undefined)).toBeUndefined();
	});

	it("hands the human-in-the-loop prompt to the providers wired for it", () => {
		// This prompt reached nobody before the registry existed:
		// `applySimpleWebSystemPrompt` tested for a heading no web provider is
		// sent, so it never fired.
		for (const providerId of ["kimi-web", "chatgpt-web"]) {
			expect(getWebProviderPrompts(providerId)?.default).toBe(
				SIMPLE_WEB_SYSTEM_PROMPT,
			);
		}
	});

	it("uses the shorter web prompt for chatgpt-web workers, leaving manager shared", () => {
		// ChatGPT workers now use SIMPLE_WEB_SYSTEM_PROMPT to avoid the full
		// JSON tool-calling contract, which causes ChatGPT to format JSON
		// instead of doing the work. Managers still use the shared prompt.
		const chatgpt = getWebProviderPrompts("chatgpt-web");
		expect(chatgpt?.worker).toBe(SIMPLE_WEB_SYSTEM_PROMPT);
		expect(chatgpt?.manager).toBeUndefined();
	});

	it("provides the web prompt for gemini-web, with worker using the shorter prompt and manager undefined", () => {
		const gemini = getWebProviderPrompts("gemini-web");
		expect(gemini?.default).toBe(SIMPLE_WEB_SYSTEM_PROMPT);
		expect(gemini?.worker).toBe(SIMPLE_WEB_SYSTEM_PROMPT);
		expect(gemini?.manager).toBeUndefined();
	});
});
