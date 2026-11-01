import { AsyncLocalStorage } from "node:async_hooks";
import { processGlobal } from "./process-global";

/**
 * The CLI session the current turn belongs to.
 *
 * A web provider only sees the prompt, so it cannot say which CLI session a
 * web chat came from. The history view needs exactly that to show the chat's
 * site title instead of a first prompt like ".". The agent runtime opens this
 * scope around every run, the same way it opens the browser-profile scope.
 *
 * On `globalThis` because `@cline/llms` can be loaded twice (see
 * `process-global.ts`): the runtime that opens the scope and the provider that
 * reads it must share one store.
 */
const cliSessionScope = () =>
	processGlobal("cliSessionScope", () => new AsyncLocalStorage<string>());

/** Run `fn` with `sessionId` as the current CLI session; `undefined` is a no-op. */
export function runWithCliSession<T>(
	sessionId: string | undefined,
	fn: () => T,
): T {
	if (!sessionId) return fn();
	return cliSessionScope().run(sessionId, fn);
}

export function getCurrentCliSessionId(): string | undefined {
	return cliSessionScope().getStore();
}
