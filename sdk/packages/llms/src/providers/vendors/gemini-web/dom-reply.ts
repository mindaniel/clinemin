/**
 * Reading Gemini's reply off the page instead of the network.
 *
 * Gemini used to stream every reply through one `/StreamGenerate` request,
 * which `capture.ts` reads with the CDP Network domain. In October 2026 the
 * page moved to a long-lived channel (`geminiweb-pa.clients6.google.com/v1/
 * processSession`) and `/StreamGenerate` stopped appearing at all, so the
 * network capture waited out its whole timeout on every turn. The rendered
 * reply is the one thing every transport ends in, so this reads that.
 *
 * Two page facts this relies on:
 * - A background tab (minimised window, or another tab in front) never
 *   renders the reply: the channel is throttled and the reply only shows
 *   after a reload. `keepGeminiPageActive` makes the page believe it is
 *   focused and visible, which is enough for it to render normally.
 * - Each reply is a `model-response` element, its text in `message-content`.
 *   While it is generating, a Stop button is shown and the reply's live
 *   region is `aria-busy="true"`.
 */

import type { CdpClient } from "../tool-pipeline/cdp-client";

/** Make a hidden or unfocused Gemini tab render like a focused one. */
export async function keepGeminiPageActive(
	cdp: CdpClient,
	cdpSessionId: string,
): Promise<void> {
	try {
		await cdp.send(
			"Emulation.setFocusEmulationEnabled",
			{ enabled: true },
			cdpSessionId,
		);
		await cdp.send(
			"Page.setWebLifecycleState",
			{ state: "active" },
			cdpSessionId,
		);
	} catch {
		// Older Chrome without one of these: the reply still renders when the
		// window happens to be in front.
	}
}

/** How many replies the page shows now; the next reply is the one after. */
export const COUNT_REPLIES_SCRIPT = `document.querySelectorAll('model-response').length`;

/**
 * Close an upgrade / promo dialog if one covers the page. Gemini shows a
 * "get Pro" offer from time to time; it does not block typing into the
 * composer, but a modal over the page can swallow the send click.
 */
export const DISMISS_PROMO_SCRIPT = `(() => {
    const dialogs = Array.from(document.querySelectorAll(
        'mat-dialog-container, [role="dialog"], [role="alertdialog"]'));
    let closed = 0;
    for (const d of dialogs) {
        if (!d.offsetWidth && !d.offsetHeight) continue;
        const buttons = Array.from(d.querySelectorAll('button'));
        const close = buttons.find(b => /close|no thanks|not now|dismiss|maybe later/i
            .test((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')));
        if (close) { close.click(); closed++; }
    }
    return closed;
})()`;

/**
 * State of reply number `index` (0-based): whether it exists, whether Gemini
 * is still writing it, and its text. Code blocks come back fenced, since the
 * tool-call parsers and plain readers both expect markdown, not the UI's
 * "Code snippet" header.
 */
export function readReplyScript(index: number): string {
	return `(() => {
    const replies = document.querySelectorAll('model-response');
    const reply = replies[${index}];
    if (!reply) return JSON.stringify({ exists: false });
    const busy = !!document.querySelector('button[aria-label*="Stop"]') ||
        !!reply.querySelector('[aria-busy="true"]');
    const content = reply.querySelector('message-content');
    let text = content ? content.innerText : '';
    if (content) {
        for (const block of content.querySelectorAll('code-block')) {
            const code = block.querySelector('code') || block.querySelector('pre');
            if (!code) continue;
            const shown = block.innerText;
            const label = ((block.querySelector('.code-block-decoration span') || {}).innerText || '').trim();
            const lang = /^code snippet$/i.test(label) ? '' : label.toLowerCase();
            const body = code.innerText.replace(/\\n$/, '');
            const fenced = '\\n\`\`\`' + lang + '\\n' + body + '\\n\`\`\`\\n';
            const at = text.indexOf(shown);
            if (at >= 0) text = text.slice(0, at) + fenced + text.slice(at + shown.length);
        }
    }
    return JSON.stringify({ exists: true, busy, text: text.replace(/\\n{3,}/g, '\\n\\n').trim() });
})()`;
}

export interface ReplyState {
	exists: boolean;
	busy?: boolean;
	text?: string;
}

export function parseReplyState(value: unknown): ReplyState {
	if (typeof value !== "string") return { exists: false };
	try {
		const parsed = JSON.parse(value) as ReplyState;
		return parsed && typeof parsed === "object" ? parsed : { exists: false };
	} catch {
		return { exists: false };
	}
}

/**
 * Whether polling can stop: the new reply is there, Gemini is no longer
 * writing it, it has text, and that text has not changed for `stablePolls`
 * polls in a row (the Stop button can drop a moment before the last chunk
 * is painted).
 */
export function replyFinished(
	history: readonly ReplyState[],
	stablePolls: number,
): boolean {
	if (history.length < stablePolls) return false;
	const recent = history.slice(-stablePolls);
	const last = recent[recent.length - 1];
	if (!last?.exists || last.busy || !last.text) return false;
	return recent.every((s) => s.exists && !s.busy && s.text === last.text);
}
