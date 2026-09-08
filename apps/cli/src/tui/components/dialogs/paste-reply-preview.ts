/**
 * Clipboard inspection for the `/paste` dialog.
 *
 * Split out of the dialog so it can be tested: importing the `.tsx` pulls in
 * OpenTUI's React reconciler, which does not load under vitest.
 */

/**
 * What `/paste` is about to hand the model, described well enough to catch the
 * usual mistake: the clipboard holds something else entirely (an old copy, a
 * URL, half a reply) and the queued "answer" only fails several seconds later,
 * inside a turn.
 */
export interface PasteReplyPreview {
	text: string;
	lines: number;
	/** Tool names the reply appears to call, in the order they appear. */
	toolNames: string[];
	/** True when the reply carries a tool envelope of some kind. */
	looksLikeToolCall: boolean;
}

/**
 * Cheap, display-only inspection of the clipboard. The real parse ladder lives
 * in the provider (llms' tool-pipeline) and is the authority on what actually
 * runs; this only has to be right often enough to be useful in a preview.
 *
 * It has to know every envelope that ladder dispatches, not just the ones that
 * name a tool. A manager's `<manager>` block, a bare `*** Begin Patch`, and a
 * tagged PowerShell fence all become tool calls (`team_run_task`,
 * `apply_patch`, `run_commands`), and a preview that only knew `<tool>` and
 * `<invoke>` announced every one of them as "no tool call found". The paste ran
 * anyway; the banner just said it would not, which reads as a refusal.
 */
export function describePasteReply(raw: string): PasteReplyPreview {
	const text = raw.trim();
	const toolNames: string[] = [];

	const invokePattern = /<\s*invoke\s+name\s*=\s*["']([^"']+)["']/gi;
	let match: RegExpExecArray | null;
	while ((match = invokePattern.exec(text)) !== null) {
		if (match[1]) toolNames.push(match[1]);
	}

	const jsonNamePattern = /"(?:name|tool)"\s*:\s*"([^"]+)"/g;
	while ((match = jsonNamePattern.exec(text)) !== null) {
		if (match[1] && !toolNames.includes(match[1])) toolNames.push(match[1]);
	}

	// The envelopes that carry no tool name of their own. Each is named after
	// the tool the provider turns it into, so the preview line reads the same
	// way as it does for a JSON call.
	const hasManagerBlock = /<\s*manager\b/i.test(text);
	if (hasManagerBlock && !toolNames.includes("team_run_task")) {
		toolNames.push("team_run_task");
	}
	const hasPatchBlock = text.includes("*** Begin Patch");
	if (hasPatchBlock && !toolNames.includes("apply_patch")) {
		toolNames.push("apply_patch");
	}
	// Only a tagged fence. An untagged ``` block is quoted text to every
	// provider, which is exactly the mistake this preview exists to catch.
	const hasShellFence = /^\s*```(?:powershell|pwsh|ps1)\b/im.test(text);
	if (hasShellFence && !toolNames.includes("run_commands")) {
		toolNames.push("run_commands");
	}
	return {
		text,
		lines: text === "" ? 0 : text.split("\n").length,
		toolNames,
		looksLikeToolCall:
			toolNames.length > 0 ||
			/<\s*tool\b/i.test(text) ||
			hasManagerBlock ||
			hasPatchBlock ||
			hasShellFence,
	};
}
