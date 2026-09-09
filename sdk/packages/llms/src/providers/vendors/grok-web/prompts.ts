import type { WebProviderPrompts } from "@cline/shared";
import { SIMPLE_WEB_SYSTEM_PROMPT } from "../tool-pipeline/simple-system-prompt";

/**
 * Grok Web's three prompts.
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
 * had. See `kimi-web/prompts.ts` for the placeholder list available to
 * `default` and `worker`.
 */
export const grokWebPrompts: WebProviderPrompts = {
	// The human-in-the-loop prompt: PowerShell to read with, a patch block to
	// edit with. Grok is a strong reasoner behind a scraped chat box, not a
	// function-calling API, and handing it the JSON tool contract makes it
	// worse — it spends the turn formatting JSON instead of thinking.
	//
	// `grok-web` is on the `web-chat-providers-use-apply-patch` rule in
	// `model-tool-routing.ts`, which is what makes the patch grammar this
	// prompt teaches actually parse. The two lists have to stay in step.
	//
	// Backup: `default: undefined` restores the shared coding-agent prompt built
	// by `buildClineSystemPrompt` — the full tool-calling contract with
	// `{{AVAILABLE_TOOLS}}` substituted in.
	default: SIMPLE_WEB_SYSTEM_PROMPT,

	// Workers get the same human-in-the-loop prompt as a plain session, not the
	// `<tool>{"name": ...}</tool>` JSON contract. Same reason as `default`: a
	// scraped chat box has no function-calling API behind it, so the contract
	// buys nothing and costs the turn formatting JSON instead of thinking.
	//
	// Backup: `worker: undefined` restores the shared "# ROLE & OBJECTIVE"
	// contract, whose `{{AVAILABLE_TOOLS}}` renders only the tools that worker
	// was actually granted. The manager's role text is appended after whichever
	// of the two is used, under a "# Team Teammate Role" heading.
	worker: SIMPLE_WEB_SYSTEM_PROMPT,

	// Unset: a manager keeps the shared manager prompt.
	manager: undefined,
};
