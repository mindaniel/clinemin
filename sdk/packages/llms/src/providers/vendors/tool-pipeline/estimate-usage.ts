/**
 * Token estimates for web providers that report no usage of their own.
 *
 * A browser chat has no usage payload: the page streams text and nothing
 * else. Left at zero, the status bar shows `0/1M` forever, the per-turn
 * tokens-per-second readout is blank, and the session total never moves --
 * so there is no way to tell how much of the context window a long session
 * has eaten.
 *
 * So estimate from the two strings we do have: the prompt sent this turn and
 * the reply read back. `estimateTokens` is the repo-wide chars/3 rule, the
 * same one deepseek-web-v2 and gemini-web already use, so every provider's
 * numbers are comparable even though none of them are exact.
 *
 * Note what this counts: one turn's prompt, not the whole conversation the
 * browser tab is holding. `addToChatContext` turns that into the size of the
 * conversation itself, which is what the context bar is meant to show.
 */

import { estimateTokens } from "@cline/shared";
import { processGlobal } from "./process-global";

export interface EstimatedUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
}

/** Chars/3, or 0 for an empty string -- `estimateTokens` has a floor of 1. */
function countTokens(text: string | undefined): number {
	const length = text?.length ?? 0;
	return length > 0 ? estimateTokens(length) : 0;
}

/** Chars/3 estimate of one turn's prompt and reply. */
export function estimateWebUsage(
	promptText: string,
	replyText: string,
): EstimatedUsage {
	const inputTokens = countTokens(promptText);
	const outputTokens = countTokens(replyText);
	return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

const chatContextTotals = () =>
	processGlobal<Map<string, number>>("webChatContextTotals", () => new Map());

/**
 * Report a turn's usage as the size of the whole web chat so far.
 *
 * The context bar reads `inputTokens` off the latest reply, which for an API
 * model is the whole conversation it was just sent. A web chat is sent only
 * the new message -- the rest already lives in the browser tab -- so the bar
 * showed one turn's size (Gemini at "839/1M" deep into a session) instead of
 * how full the chat actually is. So keep a running total per chat: every
 * earlier prompt and reply, plus this prompt, is this turn's input.
 *
 * `freshChat` starts the count over, for a turn that opened a new web chat.
 * The total lives in memory, so after a hub restart it counts from zero again.
 */
export function addToChatContext(
	provider: string,
	chatKey: string,
	usage: EstimatedUsage,
	freshChat: boolean,
): EstimatedUsage {
	const totals = chatContextTotals();
	const key = `${provider}:${chatKey}`;
	const before = freshChat ? 0 : (totals.get(key) ?? 0);
	const inputTokens = before + usage.inputTokens;
	totals.set(key, inputTokens + usage.outputTokens);
	return {
		inputTokens,
		outputTokens: usage.outputTokens,
		totalTokens: inputTokens + usage.outputTokens,
	};
}

/**
 * The provider's own usage when it reported any, an estimate otherwise. A
 * provider that reports only output tokens (or only input) keeps what it
 * reported and gets the missing side filled in.
 */
export function usageOrEstimate(
	reported: Partial<EstimatedUsage> | undefined,
	promptText: string,
	replyText: string,
): EstimatedUsage {
	const estimate = estimateWebUsage(promptText, replyText);
	const inputTokens =
		typeof reported?.inputTokens === "number" && reported.inputTokens > 0
			? reported.inputTokens
			: estimate.inputTokens;
	const outputTokens =
		typeof reported?.outputTokens === "number" && reported.outputTokens > 0
			? reported.outputTokens
			: estimate.outputTokens;
	const reportedTotal =
		typeof reported?.totalTokens === "number" && reported.totalTokens > 0
			? reported.totalTokens
			: 0;
	return {
		inputTokens,
		outputTokens,
		totalTokens: reportedTotal || inputTokens + outputTokens,
	};
}
