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

interface PendingReply {
	text: string;
	/** The provider the reply was copied out of, when the caller knows it. */
	providerId?: string;
}

const state = () =>
	processGlobal("injectedReply", () => ({
		pending: undefined as PendingReply | undefined,
	}));

/**
 * Queue `text` as the reply for the next model request from `providerId`.
 *
 * The provider matters: each web provider parses replies its own way (Gemini
 * emits native JSON tool calls, Claude Web answers in prose with shell fences,
 * DeepSeek uses the `<tool>` contract), so a reply copied out of one browser
 * must be parsed by that provider and no other. Without the tag, whichever
 * model request happens to run next — a summarizer, a title generator, a turn
 * the user switched providers for — would swallow the paste and run it through
 * the wrong ladder.
 *
 * Omitting `providerId` keeps the old any-provider behaviour.
 */
export function setPendingInjectedReply(
	text: string,
	providerId?: string,
): void {
	const trimmed = text.trim();
	state().pending = trimmed ? { text: trimmed, providerId } : undefined;
}

/** Whether a paste is waiting to be consumed. */
export function hasPendingInjectedReply(): boolean {
	return state().pending !== undefined;
}

/**
 * Take the queued reply, clearing it. Returns `undefined` when nothing is
 * queued, which is the signal to talk to the browser as usual.
 *
 * A reply tagged for another provider is left in place rather than consumed:
 * the paste waits for the provider it belongs to.
 */
export function consumePendingInjectedReply(
	providerId?: string,
): string | undefined {
	const slot = state();
	const reply = slot.pending;
	if (!reply) return undefined;
	if (reply.providerId && providerId && reply.providerId !== providerId) {
		return undefined;
	}
	slot.pending = undefined;
	return reply.text;
}

/** Discard a queued reply without using it (e.g. the user cancelled). */
export function clearPendingInjectedReply(): void {
	state().pending = undefined;
}
