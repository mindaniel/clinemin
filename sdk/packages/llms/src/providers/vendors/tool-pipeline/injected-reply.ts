/**
 * One-shot manual reply injection for the browser-driven web providers.
 *
 * When a web chat turn dies to a network hiccup the reply is still sitting in
 * the browser — the user can read it, we just never captured it. Rather than
 * losing the turn (and any `<tool>` call inside it), the user can copy that
 * reply and hand it back with `/paste`. The next model request short-circuits:
 * instead of driving the browser it returns the pasted text, which then flows
 * through the exact same tool parsing, validation, approval, and tool-result
 * feedback path a live reply would have taken.
 *
 * Deliberately a single slot: a manual paste is a rare, explicitly
 * user-initiated recovery, and the next model request always consumes it. The
 * slot is process-wide rather than module-level because `/paste` sets it from a
 * different copy of `@cline/llms` than the provider consumes it from — see
 * `process-global.ts`.
 */

import { processGlobal } from "./process-global";

const state = () =>
	processGlobal("injectedReply", () => ({
		pending: undefined as string | undefined,
	}));

/** Queue `text` as the reply for the next web-provider model request. */
export function setPendingInjectedReply(text: string): void {
	const trimmed = text.trim();
	state().pending = trimmed || undefined;
}

/** Whether a paste is waiting to be consumed. */
export function hasPendingInjectedReply(): boolean {
	return state().pending !== undefined;
}

/**
 * Take the queued reply, clearing it. Returns `undefined` when nothing is
 * queued, which is the signal to talk to the browser as usual.
 */
export function consumePendingInjectedReply(): string | undefined {
	const slot = state();
	const reply = slot.pending;
	slot.pending = undefined;
	return reply;
}

/** Discard a queued reply without using it (e.g. the user cancelled). */
export function clearPendingInjectedReply(): void {
	state().pending = undefined;
}
