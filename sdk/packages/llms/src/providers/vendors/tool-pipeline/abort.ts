/**
 * Abort plumbing shared by the browser-driven web providers.
 *
 * A web turn is not an HTTP request that dies with its socket: it is a long
 * wait on a CDP event while the browser streams a reply. Nothing about that
 * wait notices `options.abortSignal` unless we wire it in, so a cancelled turn
 * used to keep running until the response timeout (minutes), leaving the CLI's
 * "running" flag set — the user pressed Escape, the spinner stopped, and the
 * next message could not be sent until a restart.
 */

/** The rejection every abort-aware wait below produces. */
export function abortError(): DOMException {
	return new DOMException("Aborted", "AbortError");
}

/** Whether `err` is an abort rather than a real failure. */
export function isAbortError(err: unknown): boolean {
	if (err instanceof DOMException && err.name === "AbortError") return true;
	return err instanceof Error && err.name === "AbortError";
}

/** Throw straight away when the turn was already cancelled. */
export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

/** `sleep`, but a cancelled turn stops waiting instead of pacing it out. */
export function abortableSleep(
	ms: number,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortError());
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * A promise that only ever rejects, for racing against a wait that has no
 * cancellation of its own. Returns a `dispose` so the listener is dropped once
 * the race is decided — without it every turn leaks a listener on the
 * long-lived signal.
 */
export function abortRace(signal?: AbortSignal): {
	promise: Promise<never>;
	dispose: () => void;
} {
	if (!signal) {
		return { promise: new Promise<never>(() => {}), dispose: () => {} };
	}
	let onAbort: () => void = () => {};
	const promise = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(abortError());
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
	return {
		promise,
		dispose: () => signal.removeEventListener("abort", onAbort),
	};
}
