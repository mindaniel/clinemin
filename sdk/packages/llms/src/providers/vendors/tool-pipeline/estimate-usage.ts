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
 * browser tab is holding. The caller accumulates turns, so the running total
 * tracks what this session has pushed through the chat.
 */

import { estimateTokens } from "@cline/shared";

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
