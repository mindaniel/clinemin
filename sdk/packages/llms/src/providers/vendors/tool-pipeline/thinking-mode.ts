/**
 * Recovery for replies whose tool call never left the thinking stream.
 *
 * The web chat UIs stream reasoning separately from the answer body. Sometimes
 * a model works out the whole tool call while "thinking" and then stops without
 * repeating it in the answer — the visible reply is an empty or trailing-off
 * body, while the thinking text holds a perfectly good `<tool>` block we are
 * not allowed to act on (reasoning is the model's scratchpad, not its output;
 * treating it as a real call would execute things the model never committed
 * to). The turn then looks like the model simply stalled.
 *
 * Detecting this is cheap: a tool-shaped fragment in the reasoning with nothing
 * matching in the answer body. The fix is cheap too — send one short follow-up
 * asking it to emit the call for real, in the same chat, so the model sees the
 * nudge as an ordinary message.
 */

/** The nudge sent when a tool call was left behind in the thinking stream. */
export const THINKING_MODE_NUDGE =
	"Continue and send your tool call outside of thinking mode. " +
	'Emit it in your reply as exactly: <tool>{"name": "<tool_name>", "arguments": { ... }}</tool>';

/**
 * Whether `text` looks like it contains a tool call: either the `<tool>` tag in
 * any of its usual mangled forms, or a bare JSON object naming a known tool.
 */
function hasToolSignal(text: string, toolNames: readonly string[]): boolean {
	if (/<\s*tool\b/i.test(text)) {
		return true;
	}
	return toolNames.some((name) =>
		new RegExp(`"name\\"?\\s*:\\s*"${escapeRegExp(name)}"`, "i").test(text),
	);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when the model left its tool call in the thinking stream: the reasoning
 * carries a tool-shaped fragment and the answer body carries none.
 *
 * Callers should only act on this when tools are actually wired up for the turn
 * and they still have retries left, then resend `THINKING_MODE_NUDGE` into the
 * same chat.
 */
export function isToolCallStuckInThinking(input: {
	text: string;
	reasoning: string;
	toolNames: readonly string[];
}): boolean {
	if (input.toolNames.length === 0 || !input.reasoning.trim()) {
		return false;
	}
	return (
		hasToolSignal(input.reasoning, input.toolNames) &&
		!hasToolSignal(input.text, input.toolNames)
	);
}
