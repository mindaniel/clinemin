/**
 * Recovery for `apply_patch` payloads written as a bare patch block.
 *
 * The smart web providers (Claude, ChatGPT, Grok, Kimi) are asked to edit files
 * by writing the canonical patch grammar directly — see
 * `simple-system-prompt.ts` for why editing goes through a patch instead of
 * PowerShell:
 *
 *     *** Begin Patch
 *     *** Update File: C:\project\foo.py
 *     @@ def calc
 *     -    return x
 *     +    return y
 *     *** End Patch
 *
 * ## Why bare, and not inside `<tool>{json}`
 *
 * The `<tool>` contract puts the payload in a JSON string, so every newline
 * becomes `\n` and every Windows path separator doubles. A patch body is
 * nothing but newlines and paths, which makes it the single worst thing to send
 * that way — and `repairQuotesAndEscapes` still does not escape raw newlines.
 * Read bare and the escaping layer disappears: the model writes the patch as
 * text and it arrives as text.
 *
 * ## Why `***` and not a tag
 *
 * A new `<edit>` tag would pull these models toward the Anthropic tool syntax
 * they already drift into under load (the whole reason `invoke-parser.ts`
 * exists), and an unknown element can be swallowed by the chat renderer before
 * the scrape ever sees it. `***` line markers have no meaning in markdown, in
 * HTML, or in any model's native tool format.
 *
 * The grammar is not invented here — it is what `apply_patch` already parses,
 * smart-quote canonicalisation and all. This module only finds the block; it
 * does not validate it. A malformed patch fails loudly in the executor, which
 * is the behaviour we want.
 */

const BEGIN_LINE_RE = /^\*\*\* Begin Patch[ \t]*\r?$/;
const END_LINE_RE = /^\*\*\* End Patch[ \t]*\r?$/;

export interface ParsedPatchBlocks {
	/** The reply with every patch block removed. */
	cleanedContent: string;
	/** One `apply_patch` call per block, in the order they were written. */
	toolCalls: Array<{ name: "apply_patch"; arguments: { input: string } }>;
}

/**
 * Find every complete `*** Begin Patch` / `*** End Patch` block in `text`.
 *
 * Markers must sit at the start of their own line. That strictness is the point:
 * a patch body containing the literal line `*** End Patch` is the only way to
 * close a block early, and requiring column zero makes an accidental match in
 * prose or in quoted output essentially impossible.
 *
 * An unterminated block is left alone. Half a patch is worse than no patch, and
 * the text falls through to the next rung in the ladder.
 */
export function parsePatchBlocks(
	text: string,
	toolNames: readonly string[],
): ParsedPatchBlocks {
	if (!toolNames.includes("apply_patch") || !text.includes("*** Begin Patch")) {
		return { cleanedContent: text, toolCalls: [] };
	}

	const lines = text.split("\n");
	const kept: string[] = [];
	const toolCalls: ParsedPatchBlocks["toolCalls"] = [];

	let index = 0;
	while (index < lines.length) {
		const line = lines[index] ?? "";
		if (!BEGIN_LINE_RE.test(line)) {
			kept.push(line);
			index++;
			continue;
		}

		let end = index + 1;
		while (end < lines.length && !END_LINE_RE.test(lines[end] ?? "")) {
			end++;
		}
		if (end >= lines.length) {
			// Unterminated — keep the rest verbatim and stop scanning.
			kept.push(...lines.slice(index));
			break;
		}

		toolCalls.push({
			name: "apply_patch",
			arguments: { input: lines.slice(index, end + 1).join("\n") },
		});
		index = end + 1;
	}

	if (toolCalls.length === 0) {
		return { cleanedContent: text, toolCalls: [] };
	}
	return { cleanedContent: kept.join("\n").trim(), toolCalls };
}

/**
 * Why a patch block in this reply is going to be ignored, if it is.
 *
 * `parsePatchBlocks` deliberately does nothing when the session has no
 * `apply_patch` — a provider still on `editor` must not have its fences
 * hijacked. But "does nothing" reaching the user as a reply that merely
 * *describes* an edit is the failure that wasted a whole session: the model
 * sent the same patch four times, each time was told the file had not changed,
 * and neither side could see that the tool was simply absent.
 *
 * `apply_patch` is enabled for these providers in act mode only (see
 * `model-tool-routing.ts`), and manager mode strips every tool but the team
 * ones, so a plan-mode or manager session genuinely cannot apply a patch. Say
 * that out loud instead of dropping it.
 */
export function unappliedPatchNotice(
	text: string,
	toolNames: readonly string[],
): string | undefined {
	if (!text.includes("*** Begin Patch") || toolNames.includes("apply_patch")) {
		return undefined;
	}
	return (
		"This session has no `apply_patch` tool, so that patch block was not " +
		"applied and no file changed. `apply_patch` is only available in act " +
		"mode, and a manager session has no file tools at all. Do not resend the " +
		"patch — say what needs to change and who should change it."
	);
}
