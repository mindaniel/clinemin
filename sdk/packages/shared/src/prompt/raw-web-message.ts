/**
 * Verbatim messages for the browser-driven web providers (`/runbatch`).
 *
 * A web provider normally puts Cline's system prompt (the tool contract) in
 * front of the first message of a chat, and wraps later turns in history
 * labels. A user message that starts with this marker is sent to the web chat
 * exactly as written instead: no system prompt, no history, no labels. The
 * marker travels inside the message itself because the provider usually runs
 * in the hub daemon, a different process from the TUI that sets it.
 */
export const RAW_WEB_MESSAGE_MARKER = "[[cline:raw-message]]";

/**
 * Optional `#<tag>` right after the marker, dropped before sending. The web
 * providers pick the chat by hashing the first message, so a new tag makes the
 * same prompt open a new web chat instead of the old one.
 */
const TAG = /^#[A-Za-z0-9_-]+/;

type PromptLike = ReadonlyArray<{
	role: string;
	content: unknown;
}>;

function partText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((p) =>
			p && typeof p === "object" && (p as { type?: string }).type === "text"
				? String((p as { text?: unknown }).text ?? "")
				: "",
		)
		.join("\n");
}

/**
 * The text after the marker when the newest user message carries it (any
 * `<user_input>` wrapper around it removed), else undefined.
 */
export function extractRawWebMessage(prompt: PromptLike): string | undefined {
	for (let i = prompt.length - 1; i >= 0; i--) {
		const m = prompt[i];
		if (!m || m.role !== "user") continue;
		const text = partText(m.content);
		const at = text.indexOf(RAW_WEB_MESSAGE_MARKER);
		if (at < 0) return undefined;
		let body = text.slice(at + RAW_WEB_MESSAGE_MARKER.length).replace(TAG, "");
		const close = body.lastIndexOf("</user_input>");
		if (close >= 0) body = body.slice(0, close);
		return body.trim();
	}
	return undefined;
}
