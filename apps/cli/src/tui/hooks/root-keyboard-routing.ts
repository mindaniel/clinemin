export function shouldHandleInputHistory(input: {
	isRunning: boolean;
	hasQueuedPrompts: boolean;
}): boolean {
	return !input.isRunning || !input.hasQueuedPrompts;
}

export type EscapeAction =
	| "cancel-queued-edit"
	| "halt-run"
	| "clear-queued-selection"
	| "restore-checkpoint";

// Escape is overloaded by context. Resolve the single action it maps to so the
// "discard a queued edit" path can never be confused with "halt the active
// run". The active run is only halted when no queued edit is open.
export function resolveEscapeAction(input: {
	editingQueuedPrompt: boolean;
	hasSelectedQueuedPrompt: boolean;
	isRunning: boolean;
}): EscapeAction {
	if (input.editingQueuedPrompt) return "cancel-queued-edit";
	if (input.isRunning) return "halt-run";
	if (input.hasSelectedQueuedPrompt) return "clear-queued-selection";
	return "restore-checkpoint";
}
