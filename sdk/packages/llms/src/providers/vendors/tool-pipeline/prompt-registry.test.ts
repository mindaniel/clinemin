import { describe, expect, it } from "vitest";
import { getWebProviderPrompts } from "./prompt-registry";
import { SIMPLE_WEB_SYSTEM_PROMPT } from "./simple-system-prompt";

/**
 * Every web provider, i.e. every provider on the
 * `web-chat-providers-use-apply-patch` rule in `model-tool-routing.ts`. The
 * two lists have to stay in step: the prompt teaches the patch grammar and the
 * routing rule is what makes it parse, so a provider on one and not the other
 * writes patches nothing reads.
 */
const WEB_PROVIDERS = [
	"chatgpt-web",
	"claude-web",
	"deepseek-web",
	"deepseek-web-v2",
	"gemini-web",
	"grok-web",
	"kimi-web",
	"qwen-web",
];

describe("getWebProviderPrompts", () => {
	it("returns undefined for a provider with no overrides", () => {
		// Undefined rather than {} so a caller spreading the result adds nothing
		// at all for the providers that have not been given a prompts file yet.
		expect(getWebProviderPrompts("cline")).toBeUndefined();
		expect(getWebProviderPrompts(undefined)).toBeUndefined();
	});

	it("hands the human-in-the-loop prompt to every web provider", () => {
		// This prompt reached nobody before the registry existed:
		// `applySimpleWebSystemPrompt` tested for a heading no web provider is
		// sent, so it never fired.
		for (const providerId of WEB_PROVIDERS) {
			expect(getWebProviderPrompts(providerId)?.default).toBe(
				SIMPLE_WEB_SYSTEM_PROMPT,
			);
		}
	});

	it("gives workers the same short prompt, since the JSON contract buys nothing", () => {
		// A scraped chat box has no function-calling API behind it, so the full
		// `<tool>{"name": ...}</tool>` contract only costs the turn.
		for (const providerId of WEB_PROVIDERS) {
			expect(getWebProviderPrompts(providerId)?.worker).toBe(
				SIMPLE_WEB_SYSTEM_PROMPT,
			);
		}
	});

	it("leaves every manager on the shared manager prompt", () => {
		// A manager has no file or shell tools at all, so a prompt about
		// PowerShell and patch blocks is the wrong brief for it.
		for (const providerId of WEB_PROVIDERS) {
			expect(getWebProviderPrompts(providerId)?.manager).toBeUndefined();
		}
	});
});
