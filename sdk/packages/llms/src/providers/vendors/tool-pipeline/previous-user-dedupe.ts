import type { LanguageModelV2Prompt } from "@ai-sdk/provider";
import { isContinuationNoteText } from "./continuation-note";

/**
 * Keeps the user's instruction out of every single web-chat turn.
 *
 * The web providers flatten the conversation into one text prompt, labeling the
 * user's instruction `Previous user message:` so the model reads it as context
 * rather than a fresh ask. But a web chat is stateful: it already holds
 * everything sent before. Re-sending the instruction on each iteration of a
 * tool loop teaches the model nothing and grows the chat's context every round
 * — which is exactly the cost we are trying to avoid on these providers.
 *
 * So it goes out once, when it is new, and is stripped from every turn after
 * that until the user actually types something else.
 *
 * ## Why the key is not simply "the last user message"
 *
 * On an iteration turn the LAST user message is the runtime's synthetic
 * continuation note (see `continuation-note.ts`), not anything the user typed.
 * Keying the dedup on it means the key flips from the typed text to the note on
 * the first iteration, so the instruction goes out a second time before the
 * comparison finally settles. Skipping continuation notes fixes that.
 *
 * The key also carries how many real user messages have been seen, so a user
 * who repeats themselves verbatim still gets their message delivered instead of
 * silently deduped against the identical earlier one.
 */

function messageText(message: LanguageModelV2Prompt[number]): string {
	const content = Array.isArray(message.content)
		? message.content
				.map((block) => ("text" in block ? block.text : ""))
				.join("\n")
		: message.content;
	return typeof content === "string" ? content.trim() : "";
}

/**
 * Dedup key for the user's current instruction: `<count>:<text>` over the last
 * user message that the user actually typed. Empty when there is none.
 */
export function realUserMessageKey(prompt: LanguageModelV2Prompt): string {
	let count = 0;
	let latest = "";
	for (const message of prompt) {
		if (message.role !== "user") continue;
		const text = messageText(message);
		if (!text || isContinuationNoteText(text)) continue;
		count += 1;
		latest = text;
	}
	return latest ? `${count}:${latest}` : "";
}

/**
 * Remove every `Previous user message:` block from a flattened prompt, leaving
 * the fresh tool results and the continuation note (which change each round and
 * must still be sent).
 *
 * Matches anywhere rather than only at the start, because a turn that
 * re-injects the system prompt puts it in front of the block.
 */
export function stripPreviousUserBlock(prompt: string): string {
	return prompt
		.replace(
			/(?:^|\n\n)Previous user message:[\s\S]*?(?=\n\n(?:Tool result|Assistant|Note|Previous user message):|$)/g,
			"",
		)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
