/**
 * Retry for the one CDP failure that means "nothing happened yet".
 *
 * Every web provider drives its chat page with `Runtime.evaluate` over a raw
 * CDP socket. A page has no execution context for a short window — while a
 * navigation is committing, while a freshly created tab is still about:blank,
 * and again for a moment after Chrome discards and restores a background tab.
 * Evaluating inside that window fails with:
 *
 *     Cannot find default execution context
 *
 * which surfaced to the user as a bare `Error: Cannot find default execution
 * context` and killed the turn, with nothing typed into the chat box.
 *
 * The window is milliseconds wide, so waiting it out is the whole fix. What
 * makes retrying safe here — and unsafe in general — is that this particular
 * error is raised BEFORE the expression runs: the context the script needed did
 * not exist, so no keystroke was dispatched and no message was sent. Retrying
 * cannot double-send. Any other CDP error may well mean the call half-happened,
 * so only this one is retried, and only for evaluation methods.
 */

const RETRYABLE_METHODS = new Set([
	"Runtime.evaluate",
	"Runtime.callFunctionOn",
]);

const MISSING_CONTEXT_PATTERNS = [
	"cannot find default execution context",
	"cannot find context with specified id",
	"execution context was destroyed",
];

/** Does this error mean the expression never ran for want of a context? */
export function isMissingExecutionContextError(error: unknown): boolean {
	const message = (
		error instanceof Error ? error.message : String(error ?? "")
	).toLowerCase();
	return MISSING_CONTEXT_PATTERNS.some((pattern) => message.includes(pattern));
}

/**
 * Run a CDP call, waiting out a missing execution context.
 *
 * Four tries over ~1.5s. A page that still has no context by then is not in a
 * race we can win — it is a tab that never loaded — and the original error is
 * the honest thing to report.
 */
export async function retryOnMissingExecutionContext<T>(
	method: string,
	call: () => Promise<T>,
	sleep: (ms: number) => Promise<unknown>,
	providerId?: string,
): Promise<T> {
	if (!RETRYABLE_METHODS.has(method)) {
		return call();
	}
	let lastError: unknown;
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			return await call();
		} catch (error) {
			if (!isMissingExecutionContextError(error)) {
				throw error;
			}
			lastError = error;
			await sleep(500);
		}
	}
	// Say which provider's page never came back. The raw CDP message names
	// nothing, so a session driving several chat tabs reported a bare
	// "Error: Cannot find default execution context" with no way to tell whose
	// browser had died.
	const message =
		lastError instanceof Error ? lastError.message : String(lastError);
	throw new Error(
		providerId
			? `[${providerId}] ${message} — the chat tab never finished loading, so nothing was sent. Check its Chrome window.`
			: message,
	);
}
