import type { WebProviderPrompts } from "@cline/shared";
import { chatgptWebPrompts } from "../chatgpt-web/prompts";
import { claudeWebPrompts } from "../claude-web/prompts";
import { deepseekWebPrompts } from "../deepseek-web/prompts";
import { deepseekWebV2Prompts } from "../deepseek-web-v2/prompts";
import { geminiWebPrompts } from "../gemini-web/prompts";
import { grokWebPrompts } from "../grok-web/prompts";
import { kimiWebPrompts } from "../kimi-web/prompts";
import { qwenWebPrompts } from "../qwen-web/prompts";

/**
 * Which providers override which of the three prompts.
 *
 * A static object, not a registration call. Providers register themselves in
 * several other places in this codebase and every one of those lists has
 * drifted at least once — a provider missing from one of them fails silently,
 * in a way that looks like a model problem rather than a missing entry. A
 * literal here is checked by the compiler and readable in one screen.
 *
 * A provider absent from this map, or present with an empty object, gets the
 * shared prompts exactly as it did before any of this existed. That is what
 * makes filling it in one provider at a time safe.
 *
 * The map lives in `@cline/llms` because the prompts do, next to the provider
 * whose wording they are. `@cline/shared` builds the prompt but cannot import
 * this: it sits below this package and also builds for the browser, where none
 * of the provider code can load. So the prompts are handed *down* to
 * `buildClineSystemPrompt` as an argument rather than looked up inside it.
 */
const WEB_PROVIDER_PROMPTS: Record<string, WebProviderPrompts> = {
	"chatgpt-web": chatgptWebPrompts,
	"claude-web": claudeWebPrompts,
	"deepseek-web": deepseekWebPrompts,
	"deepseek-web-v2": deepseekWebV2Prompts,
	"gemini-web": geminiWebPrompts,
	"grok-web": grokWebPrompts,
	"kimi-web": kimiWebPrompts,
	"qwen-web": qwenWebPrompts,
};

/**
 * A provider's prompt overrides, or undefined when it has none.
 *
 * Undefined rather than an empty object so a caller spreading the result into
 * prompt options adds nothing at all for a provider that has no overrides.
 */
export function getWebProviderPrompts(
	providerId: string | undefined,
): WebProviderPrompts | undefined {
	if (!providerId) return undefined;
	return WEB_PROVIDER_PROMPTS[providerId];
}
