/**
 * Hidden/visible Chrome for the web providers, toggled with Tab.
 *
 * The preference lives in a state file because the providers run in the hub
 * process; each provider restarts its browser in the new mode on its next
 * turn (see `tool-pipeline/browser-visibility.ts` in @cline/llms). It is kept
 * per browser profile, so Tab here does not move another terminal's profile.
 */

import { readHeadlessPreference, writeHeadlessPreference } from "@cline/llms";
import { useSyncExternalStore } from "react";

let headless = readHeadlessPreference() ?? false;
const listeners = new Set<() => void>();

export function isBrowserHeadless(): boolean {
	return headless;
}

/** Re-read the preference after `/profile` moves this terminal to another profile. */
export function refreshBrowserHeadless(): void {
	const next = readHeadlessPreference() ?? false;
	if (next === headless) return;
	headless = next;
	for (const listener of listeners) listener();
}

export function toggleBrowserHeadless(): boolean {
	headless = !headless;
	writeHeadlessPreference(headless);
	for (const listener of listeners) listener();
	return headless;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useBrowserHeadless(): boolean {
	return useSyncExternalStore(subscribe, isBrowserHeadless);
}
