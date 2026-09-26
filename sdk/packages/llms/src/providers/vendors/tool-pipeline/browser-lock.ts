/**
 * One turn at a time per browser-driven web provider.
 *
 * These providers do not talk to an API. They drive a real Chrome profile over
 * CDP: find the provider's tab, navigate it to a chat, type into that chat's
 * composer, press send, then read the streamed reply back off the page. All of
 * that is stateful in a way an HTTP request is not — there is exactly one tab,
 * one composer, and one visible conversation.
 *
 * A single CLI process runs one session at a time, so that was never a problem.
 * The hub daemon is long-lived and serves every session at once, and nothing
 * stopped two of them from driving the same profile simultaneously. The result
 * is not an error, which is what makes it hard to recognise: session A opens
 * its new chat, session B navigates the same tab to a different one, and A then
 * types into whatever is now on screen — or types nothing at all, because the
 * composer it was waiting for was replaced. Observed in the wild as three
 * concurrent runs against `claude-web`, one of them heartbeating for twenty
 * minutes, and a brand-new chat that opened correctly and stayed empty.
 *
 * So turns queue per provider. The queue is FIFO, and it is process-global
 * because `@cline/llms` is loaded twice in one process — see `process-global.ts`
 * for why a module-level `let` would give the two halves separate queues and no
 * mutual exclusion at all.
 *
 * Waiting is abortable. A queued turn whose session is cancelled must not run
 * when its turn comes up: by then the user has moved on, and driving the
 * browser for a dead turn would steal the tab from a live one.
 */

import { abortError, abortRace, throwIfAborted } from "./abort";
import { processGlobal } from "./process-global";

interface BrowserLockState {
	/**
	 * Tail of each provider's queue: a promise that settles when the currently
	 * held turn releases. Chaining onto it is what makes waiters FIFO.
	 */
	tails: Map<string, Promise<void>>;
}

const state = () =>
	processGlobal<BrowserLockState>("browserLock", () => ({
		tails: new Map<string, Promise<void>>(),
	}));

/**
 * Run `turn` with exclusive use of `key`'s browser, waiting for any turn
 * already running on it to finish first.
 *
 * `key` identifies the browser, not the session — every session using the same
 * provider shares one profile and so must share one queue.
 */
export async function withBrowserLock<T>(
	key: string,
	signal: AbortSignal | undefined,
	turn: () => Promise<T>,
): Promise<T> {
	throwIfAborted(signal);

	const slot = state();
	const previous = slot.tails.get(key);

	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	// Claim the queue position before awaiting anything, so two callers racing
	// into this function cannot both chain onto the same predecessor.
	const tail = previous ? previous.then(() => held) : held;
	slot.tails.set(key, tail);

	// A cancelled turn gives the browser back at once, and a queued turn can
	// be cancelled while it waits. The lock used to be held until whatever CDP
	// step the turn was in returned -- for a wait on the page, possibly never --
	// so after pressing esc every later message on that provider queued behind
	// a dead turn and sat on "Thinking..." for good. The abandoned turn may
	// still finish a step in the background; its result is ignored.
	const cancelled = abortRace(signal);
	// Raced below, but not on every path; never an unhandled rejection.
	cancelled.promise.catch(() => undefined);
	try {
		if (previous) {
			// A failed predecessor still released its slot; its rejection is
			// that turn's problem, not this one's.
			await Promise.race([previous.catch(() => undefined), cancelled.promise]);
		}
		// Re-checked after the wait: a turn cancelled while queued must not touch
		// the browser now that the user has moved on.
		throwIfAborted(signal);
		const running = turn();
		running.catch(() => undefined);
		return await Promise.race([running, cancelled.promise]);
	} finally {
		cancelled.dispose();
		release();
		// Only clear the tail if nobody queued behind this turn, otherwise the
		// next waiter's position would be dropped and the queue would unbound.
		if (slot.tails.get(key) === tail) {
			slot.tails.delete(key);
		}
	}
}

/**
 * Whether a turn is currently holding or waiting on `key`. Diagnostics only —
 * never branch on this to decide whether to take the lock, since the answer can
 * change between the check and the call.
 */
export function isBrowserBusy(key: string): boolean {
	return state().tails.has(key);
}

/** Re-exported so callers can recognise the rejection a cancelled wait throws. */
export { abortError };
