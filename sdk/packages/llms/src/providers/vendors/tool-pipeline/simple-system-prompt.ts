import type { LanguageModelV2Prompt } from "@ai-sdk/provider";
import { SIMPLE_WEB_SYSTEM_PROMPT, withWebPromptFolder } from "@cline/shared";

/**
 * The human-in-the-loop prompt for the smart web providers.
 *
 * The text itself now lives in `@cline/shared` (see `prompt/simple-web.ts`),
 * because `/guide-ai` re-sends the same rules mid-conversation and that package
 * sits below this one. It is re-exported here so every provider's existing
 * import keeps working and there is still exactly one copy of the grammar.
 */
export { SIMPLE_WEB_SYSTEM_PROMPT };

/**
 * Is this the stock coding-agent prompt every plain session gets?
 *
 * Three prompts reach these providers. The stock one carries the tool-calling
 * contract and nothing else; a teammate's is that same contract with its role
 * appended; a manager's has no tool contract at all. Only the first is a
 * default worth overriding.
 */
export function isStockWebSystemPrompt(content: string): boolean {
	return (
		content.includes("# CRITICAL TOOL CALLING PROTOCOL") &&
		!content.includes("# Team Teammate Role")
	);
}

/**
 * Swap the stock system prompt for the human-in-the-loop one.
 *
 * Runs BEFORE the conversation is built, because the first turn passes the
 * prompt through unchanged — replacing it afterwards would already have sent
 * the full "# ROLE & OBJECTIVE ..." contract.
 *
 * Only the stock prompt is replaced. A session whose prompt the runtime chose
 * deliberately — a manager, or a teammate that needs the tool contract to do
 * anything at all — would otherwise have that prompt silently thrown away and
 * be told to hand PowerShell back to a human instead, which is the opposite of
 * its job.
 */
export function applySimpleWebSystemPrompt(
	prompt: LanguageModelV2Prompt,
): LanguageModelV2Prompt {
	return prompt.map((message) =>
		message.role === "system" && isStockWebSystemPrompt(message.content)
			? { ...message, content: withWebPromptFolder(SIMPLE_WEB_SYSTEM_PROMPT) }
			: message,
	);
}
