import { describe, expect, it } from "vitest";
import {
	resolveEscapeAction,
	shouldHandleInputHistory,
} from "./root-keyboard-routing";

describe("resolveEscapeAction", () => {
	it("discards the queued edit (not the run) when editing while running", () => {
		expect(
			resolveEscapeAction({
				editingQueuedPrompt: true,
				hasSelectedQueuedPrompt: true,
				isRunning: true,
			}),
		).toBe("cancel-queued-edit");
	});

	it("halts the run only when no queued edit is open", () => {
		expect(
			resolveEscapeAction({
				editingQueuedPrompt: false,
				hasSelectedQueuedPrompt: false,
				isRunning: true,
			}),
		).toBe("halt-run");
	});

	it("clears the queued selection when idle with a selection", () => {
		expect(
			resolveEscapeAction({
				editingQueuedPrompt: false,
				hasSelectedQueuedPrompt: true,
				isRunning: false,
			}),
		).toBe("clear-queued-selection");
	});

	it("falls back to checkpoint restore when idle and nothing is selected", () => {
		expect(
			resolveEscapeAction({
				editingQueuedPrompt: false,
				hasSelectedQueuedPrompt: false,
				isRunning: false,
			}),
		).toBe("restore-checkpoint");
	});
});

describe("root keyboard input history routing", () => {
	it("handles history while idle", () => {
		expect(
			shouldHandleInputHistory({
				isRunning: false,
				hasQueuedPrompts: false,
			}),
		).toBe(true);
	});

	it("handles history during a running turn when the prompt queue is empty", () => {
		expect(
			shouldHandleInputHistory({
				isRunning: true,
				hasQueuedPrompts: false,
			}),
		).toBe(true);
	});

	it("keeps running-turn arrow keys reserved for queued prompts when the queue is populated", () => {
		expect(
			shouldHandleInputHistory({
				isRunning: true,
				hasQueuedPrompts: true,
			}),
		).toBe(false);
	});
});
