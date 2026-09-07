import type { LanguageModelV2Prompt } from "@ai-sdk/provider";

/**
 * The human-in-the-loop prompt for the smart web providers.
 *
 * Claude, ChatGPT, Grok, Kimi and Gemini on the web are strong reasoners behind
 * a scraped chat box, not a function-calling API. Handing them our tool-calling
 * contract makes them worse: they spend the turn formatting JSON instead of
 * thinking. So they get a prompt that asks for PowerShell to read with and a
 * patch block to edit with, and the human pastes results back.
 *
 * ## Why editing is a patch block and not PowerShell
 *
 * A PowerShell edit has to survive the chat renderer, the copy, and then
 * PowerShell's own parser — three escaping layers, and `Set-Content` writes
 * system ANSI by default, so a bad round trip corrupts the file silently.
 *
 * The patch grammar has none of that. It is the same format `apply_patch`
 * already parses (see `apply-patch-parser.ts`) — so every provider given this
 * prompt must also be routed to `apply_patch` in `model-tool-routing.ts`, or it
 * writes patches that nothing reads — it carries no angle brackets to
 * pull the model toward its native tool syntax, and a context line that does not
 * match is a loud failure instead of a wrong write.
 */
export const SIMPLE_WEB_SYSTEM_PROMPT = [
	"Help me with this problem. Do not give me multiple code options, just 1 option.",
	"",
	"Before helping me with my task, you must first help me understand the project folder structure and read the relevant files — send me PowerShell commands to do that, and I will paste you the results. but send 1 powershell command at a time to prevent long outputs.",
	"",
	"Always put a PowerShell command in a fence tagged ```powershell. An untagged ``` fence is treated as quoted text and will not run.",
	"",
	"When a file needs to be edited, do not ask me to edit it manually, and do not send PowerShell code that writes to the file. Instead send the change as a patch block that I paste into my auto-patcher, in exactly this format:",
	"",
	"*** Begin Patch",
	"*** Update File: C:\\full\\path\\to\\file.py",
	"@@ def calc",
	"     unchanged_context_line",
	"-    return x",
	"+    return y",
	"*** End Patch",
	"",
	"Patch rules:",
	'- Absolute path after "*** Update File:".',
	'- Context lines start with one space. Removed lines start with "-". Added lines start with "+". Indentation after that prefix must match the file byte for byte.',
	"- Include 2-3 unchanged context lines around every change so it locates correctly.",
	'- Use "*** Add File:" for a new file, "*** Delete File:" to remove one.',
	'- One "*** Begin Patch" / "*** End Patch" per reply. Multiple files and multiple "@@" sections inside it are fine.',
	"- Do not wrap the patch in a code fence, and do not explain anything inside the block.",
	"",
	"I will then paste you the results of what has been done that I followed you.",
].join("\n");

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
			? { ...message, content: SIMPLE_WEB_SYSTEM_PROMPT }
			: message,
	);
}
