/**
 * Process-wide state for the web-provider tool pipeline.
 *
 * `@cline/llms` is loaded TWICE in a running CLI, and a plain module-level
 * `let` is therefore not shared between the two halves:
 *
 *   - `apps/cli/src/**` resolves `@cline/llms` through the `paths` mapping in
 *     `apps/tsconfig.apps.json`, which points at `sdk/packages/llms/src`.
 *   - `@cline/core` and `@cline/agents` resolve it through their workspace
 *     `node_modules` symlink, which points at `sdk/packages/llms/dist`.
 *
 * Two module graphs, two copies of every module-level binding. So a slash
 * command that sets state from the CLI side writes to the `src` copy while the
 * agent runtime and the providers read the `dist` copy, and the setting appears
 * to do nothing at all — silently, with no import error to hint at it, because
 * both copies export the same names.
 *
 * Hanging the state off `globalThis` sidesteps the split: there is one process,
 * so there is one slot, whichever copy reaches it.
 *
 * Use this for state that is genuinely process-wide and set from outside the
 * providers (a pending paste, the active continuation note). Ordinary
 * module-private values that are only ever read and written within one module
 * graph do not need it.
 */

const NAMESPACE = "__clineToolPipeline__";

type GlobalRegistry = Record<string, unknown>;

function registry(): GlobalRegistry {
	const host = globalThis as unknown as Record<string, GlobalRegistry>;
	host[NAMESPACE] ??= {};
	return host[NAMESPACE];
}

/**
 * Get the process-wide state box for `key`, creating it with `create()` the
 * first time any copy of this module asks for it.
 */
export function processGlobal<T extends object>(
	key: string,
	create: () => T,
): T {
	const slots = registry();
	slots[key] ??= create();
	return slots[key] as T;
}
