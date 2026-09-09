import type { WebProviderPrompts } from "@cline/shared";
import { SIMPLE_WEB_SYSTEM_PROMPT } from "../tool-pipeline/simple-system-prompt";

/**
 * Gemini Web's three prompts.
 *
 * A session reaches a web provider as one of three things, and they want
 * different wording:
 *
 * - `default` — a plain session. One human, one chat box.
 * - `worker` — a teammate a manager delegated to. Its tool list lives in this
 *   text and nowhere else, because there is no function-calling API behind a
 *   scraped chat, so a worker handed only its role prompt knows the job and has
 *   no way to do any of it.
 * - `manager` — a coordinator. No file or shell tools at all; it delegates and
 *   reads reports.
 *
 * Leave a slot `undefined` and that role gets the shared prompt it has always
 * had. That is the safe default and it is why adding this file to a provider
 * changes nothing until a slot is actually filled in.
 *
 * Placeholders available to `default` and `worker`, substituted by
 * `buildClineSystemPrompt`: `{{PLATFORM_NAME}}`, `{{CWD}}`, `{{CURRENT_DATE}}`,
 * `{{IDE_NAME}}`, `{{AVAILABLE_TOOLS}}`, `{{WORKFLOW}}`, `{{CLINE_RULES}}`,
 * `{{CLINE_METADATA}}`. Omitting one is fine — nothing is substituted into a
 * placeholder that is not there, which is how a self-contained prompt like
 * `SIMPLE_WEB_SYSTEM_PROMPT` sits in the same slot as the full tool contract.
 *
 * `{{AVAILABLE_TOOLS}}` is the one worth keeping in a `worker` prompt: it
 * renders only the tools that worker was actually granted. Documenting one it
 * cannot call guarantees it calls it and burns the turn on a rejection it
 * cannot diagnose.
 */
export const geminiWebPrompts: WebProviderPrompts = {
	// The human-in-the-loop prompt: PowerShell to read with, a patch block to
	// edit with. Gemini is a strong reasoner behind a scraped chat box, not a
	// function-calling API, and handing it the JSON tool contract makes it
	// worse — it spends the turn formatting JSON instead of thinking.
	//
	// This is also the first time this prompt has actually reached a provider.
	// It was applied by `applySimpleWebSystemPrompt`, which tests for
	// "# CRITICAL TOOL CALLING PROTOCOL" — a heading that lives in
	// DEFAULT_CLINE_SYSTEM_PROMPT, which no web provider is ever given. The
	// check has never once matched. See the note in simple-system-prompt.ts.
	//
	// Backup: `default: undefined` restores the shared coding-agent prompt built
	// by `buildClineSystemPrompt` — the full tool-calling contract with
	// `{{AVAILABLE_TOOLS}}` substituted in.
	default: SIMPLE_WEB_SYSTEM_PROMPT,

	// Gemini workers now use the shorter Web prompt (SIMPLE_WEB_SYSTEM_PROMPT)
	// instead of the full "# ROLE & OBJECTIVE" tool-calling contract.
	// The full JSON contract causes Gemini to spend turns formatting JSON
	// rather than doing the work. The shorter prompt asks for PowerShell to
	// read with and a patch block to edit with, which works much better.
	worker: SIMPLE_WEB_SYSTEM_PROMPT,

	// Unset: a manager keeps the shared manager prompt from
	// `@cline/shared/prompt/manager`. A value here replaces it verbatim, with
	// no placeholder substitution.
	manager: undefined,
};
