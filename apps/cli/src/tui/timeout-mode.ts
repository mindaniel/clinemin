/**
 * Finite or infinite shell-command timeout, toggled with Tab.
 *
 * The preference lives in a state file because commands run in the hub
 * process; run_commands reads it on every call (see
 * `tool-pipeline/command-timeout-mode.ts` in @cline/llms).
 */

import {
	readInfiniteCommandTimeout,
	writeInfiniteCommandTimeout,
} from "@cline/llms";
import { useSyncExternalStore } from "react";

let infinite = readInfiniteCommandTimeout();
const listeners = new Set<() => void>();

export function isCommandTimeoutInfinite(): boolean {
	return infinite;
}

export function toggleCommandTimeout(): boolean {
	infinite = !infinite;
	writeInfiniteCommandTimeout(infinite);
	for (const listener of listeners) listener();
	return infinite;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useCommandTimeoutInfinite(): boolean {
	return useSyncExternalStore(subscribe, isCommandTimeoutInfinite);
}
