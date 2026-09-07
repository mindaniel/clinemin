import { describe, expect, it, vi } from "vitest";
import {
	isMissingExecutionContextError,
	retryOnMissingExecutionContext,
} from "./cdp-execution-context";

const noSleep = async () => {};

describe("isMissingExecutionContextError", () => {
	it("recognises the errors that mean the expression never ran", () => {
		expect(
			isMissingExecutionContextError(
				new Error("Cannot find default execution context"),
			),
		).toBe(true);
		expect(
			isMissingExecutionContextError(
				new Error("Execution context was destroyed"),
			),
		).toBe(true);
		expect(isMissingExecutionContextError(new Error("Target closed"))).toBe(
			false,
		);
	});
});

describe("retryOnMissingExecutionContext", () => {
	it("waits out a page that is mid-navigation", async () => {
		let calls = 0;
		const result = await retryOnMissingExecutionContext(
			"Runtime.evaluate",
			async () => {
				calls++;
				if (calls < 3) {
					throw new Error("Cannot find default execution context");
				}
				return "ok";
			},
			noSleep,
		);

		expect(result).toBe("ok");
		expect(calls).toBe(3);
	});

	it("gives up with the original error rather than looping forever", async () => {
		const call = vi.fn(async () => {
			throw new Error("Cannot find default execution context");
		});

		await expect(
			retryOnMissingExecutionContext("Runtime.evaluate", call, noSleep),
		).rejects.toThrow("Cannot find default execution context");
		expect(call).toHaveBeenCalledTimes(4);
	});

	it("never retries a call that may have half-happened", async () => {
		// Typing and navigating are not idempotent: only the "there was no
		// context, so nothing ran" failure is safe to repeat.
		const typing = vi.fn(async () => {
			throw new Error("Cannot find default execution context");
		});

		await expect(
			retryOnMissingExecutionContext("Input.dispatchKeyEvent", typing, noSleep),
		).rejects.toThrow();
		expect(typing).toHaveBeenCalledTimes(1);
	});

	it("passes other errors straight through", async () => {
		const call = vi.fn(async () => {
			throw new Error("Session with given id not found.");
		});

		await expect(
			retryOnMissingExecutionContext("Runtime.evaluate", call, noSleep),
		).rejects.toThrow("Session with given id not found.");
		expect(call).toHaveBeenCalledTimes(1);
	});
});
