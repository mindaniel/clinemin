import type { WebProviderPrompts } from "@cline/shared";
import { SIMPLE_WEB_SYSTEM_PROMPT } from "./tool-pipeline/simple-system-prompt";

/**
 * ChatGPT Web's three prompts.
 *
 * This file sits beside `chatgpt-web.ts` rather than inside a folder because
 * that provider has not been split yet. When it is, move it in as
 * `prompts.ts` and fix the registry's import path — nothing else changes.
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
 * placeholder that is not there.
 *
 * `{{AVAILABLE_TOOLS}}` is the one worth keeping in a `worker` prompt: it
 * renders only the tools that worker was actually granted.
 */
export const chatgptWebPrompts: WebProviderPrompts = {
	// The human-in-the-loop prompt: PowerShell to read with, a patch block to
	// edit with. This is what `applySimpleWebSystemPrompt` was meant to apply
	// here and never did — it tests for "# CRITICAL TOOL CALLING PROTOCOL", a
	// heading that lives in DEFAULT_CLINE_SYSTEM_PROMPT, which no web provider
	// is ever given.
	default: SIMPLE_WEB_SYSTEM_PROMPT,

	// ChatGPT workers get the same short human-in-the-loop prompt as the
	// default session, not the raw `<tool>{"name": ...}</tool>` JSON contract:
	// ChatGPT is the worst of the web providers at that contract — it
	// reformats, wraps in fences, and loses turns to malformed blocks.
	worker: SIMPLE_WEB_SYSTEM_PROMPT,

	// Unset: a manager keeps the shared manager prompt from
	// `@cline/shared/prompt/manager`. A value here replaces it verbatim, with
	// no placeholder substitution.
	manager: undefined,
};
