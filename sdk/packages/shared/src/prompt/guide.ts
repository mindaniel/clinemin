import { renderWebProviderToolDocs, TOOL_CALL_PROTOCOL_RULES } from "./cline";
import { SIMPLE_WEB_SYSTEM_PROMPT } from "./simple-web";

/**
 * `/guide-ai <message>` — re-send the working agreement with this turn.
 *
 * A web provider is a chat box. There is no system-prompt slot that the server
 * re-reads every turn: the instructions were typed once, at the top of a
 * conversation that has since grown by tens of thousands of tokens, and the
 * model's attention to them decays. The visible symptom is always the same
 * shape — it starts answering in prose instead of sending a command, wraps a
 * patch in a code fence, invents a tool, or asks the user to edit a file by
 * hand. Nothing is broken; the contract has simply fallen out of view.
 *
 * So this is not a new instruction. It re-sends the contract the session
 * already has, in the same turn as the user's message, which is the only place
 * a chat provider will reliably look. Both halves are rebuilt from the exact
 * constants the system prompt was built from, so a reminder can never describe
 * a contract the session is not actually running.
 */
export type GuideAiStyle = "patch" | "tools";

export const GUIDE_AI_COMMAND = "guide-ai";

/**
 * The words that pick a style explicitly.
 *
 * `1` and `2` are here because the two styles are how the choice gets talked
 * about out loud ("option 1" / "option 2"), and a user who remembers the number
 * but not the word should not have to look it up.
 */
const STYLE_ALIASES: Record<string, GuideAiStyle> = {
	"1": "patch",
	patch: "patch",
	powershell: "patch",
	ps: "patch",
	"2": "tools",
	tools: "tools",
	tool: "tools",
};

export interface ParsedGuideAiCommand {
	/** The style the user asked for, or undefined to detect it. */
	style?: GuideAiStyle;
	/** Everything after the command word and the optional style word. */
	message: string;
}

const GUIDE_AI_PATTERN = new RegExp(
	String.raw`^\/${GUIDE_AI_COMMAND}(?:\s+([\s\S]*))?$`,
	"i",
);

/**
 * Split `/guide-ai [style] <message>` into its parts.
 *
 * Returns undefined when the input is not this command, so a caller can pass
 * every prompt through without checking first.
 *
 * A style word is only consumed when there is something after it. `/guide-ai
 * tools` on its own is far more likely to mean "remind them about the tools"
 * than "send an empty message in tools style", and the two readings produce the
 * same reminder anyway.
 */
export function parseGuideAiCommand(
	input: string,
): ParsedGuideAiCommand | undefined {
	const match = GUIDE_AI_PATTERN.exec(input.trim());
	if (!match) {
		return undefined;
	}
	const rest = (match[1] ?? "").trim();
	if (!rest) {
		return { message: "" };
	}
	const firstSpace = rest.search(/\s/);
	if (firstSpace === -1) {
		return { message: rest };
	}
	const head = rest.slice(0, firstSpace).toLowerCase();
	const style = STYLE_ALIASES[head];
	if (!style) {
		return { message: rest };
	}
	return { style, message: rest.slice(firstSpace + 1).trim() };
}

/**
 * Which contract this session is actually running, read off its system prompt.
 *
 * Asking the prompt beats asking the provider id. The same provider is given
 * different prompts as a plain session, a worker and a manager, and the roster
 * of which provider gets which has already been rewritten twice. The text is
 * the ground truth, and both markers are unambiguous.
 *
 * `<tool>` is checked first because the tool contract can *contain* the patch
 * grammar: a session routed to `apply_patch` documents that block inside its
 * tool list. The reverse never happens — the simple web prompt has no angle
 * brackets at all, by design.
 */
export function detectGuideAiStyle(
	systemPrompt: string | undefined,
): GuideAiStyle {
	const prompt = systemPrompt ?? "";
	if (prompt.includes("<tool>")) {
		return "tools";
	}
	if (prompt.includes("*** Begin Patch")) {
		return "patch";
	}
	return "tools";
}

/**
 * The reminder body for a style.
 *
 * `tools` takes the session's tool scope so the list it prints is the list the
 * session has. Reminding a read-only worker that it may call `editor` is worse
 * than not reminding it at all — it will call it, and spend the turn on a
 * rejection it cannot diagnose.
 */
export function buildGuideAiReminder(options: {
	style: GuideAiStyle;
	tools?: string[];
}): string {
	if (options.style === "patch") {
		return [
			"Reminder — the working agreement for this conversation, unchanged since it started. Follow it exactly for the request below.",
			"",
			SIMPLE_WEB_SYSTEM_PROMPT,
		].join("\n");
	}
	return [
		"Reminder — the tool-calling contract for this conversation, unchanged since it started. Follow it exactly for the request below.",
		"",
		TOOL_CALL_PROTOCOL_RULES,
		"",
		"Available tools (use these exact names and schemas, and no others):",
		renderWebProviderToolDocs(options.tools),
	].join("\n");
}

const MESSAGE_HEADER = "Now, with that in mind:";

/**
 * Rewrite `/guide-ai <message>` into the reminder plus the message.
 *
 * Anything else is returned untouched, so this can sit on the path every prompt
 * takes. The reminder goes first and the message last: the contract is what the
 * model should be holding while it reads the request, and a chat model weights
 * the end of a message most heavily, which is where the actual instruction
 * belongs.
 *
 * Deliberately plain text with no XML envelope. The payload is pasted into a
 * web chat box, where an unfamiliar tag is one more thing for the model to
 * reason about, and some renderers eat it outright.
 */
export function expandGuideAiPrompt(options: {
	input: string;
	systemPrompt?: string;
	tools?: string[];
}): string {
	const parsed = parseGuideAiCommand(options.input);
	if (!parsed) {
		return options.input;
	}
	const reminder = buildGuideAiReminder({
		style: parsed.style ?? detectGuideAiStyle(options.systemPrompt),
		tools: options.tools,
	});
	if (!parsed.message) {
		return reminder;
	}
	return `${reminder}\n\n${MESSAGE_HEADER}\n\n${parsed.message}`;
}
