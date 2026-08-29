import { describe, expect, it } from "vitest";
import {
	abortableSleep,
	abortRace,
	isAbortError,
	throwIfAborted,
} from "./abort";

describe("abort helpers", () => {
	it("recognises an abort rejection", () => {
		expect(isAbortError(new DOMException("Aborted", "AbortError"))).toBe(true);
		expect(isAbortError(new Error("boom"))).toBe(false);
	});

	it("throws immediately for an already-cancelled turn", () => {
		const controller = new AbortController();
		controller.abort();
		expect(() => throwIfAborted(controller.signal)).toThrow(/aborted/i);
	});

	it("stops a pacing sleep when the turn is cancelled", async () => {
		const controller = new AbortController();
		const started = Date.now();
		const sleeping = abortableSleep(60_000, controller.signal);
		controller.abort();
		await expect(sleeping).rejects.toThrow(/aborted/i);
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it("resolves normally when nothing cancels it", async () => {
		await expect(abortableSleep(1)).resolves.toBeUndefined();
	});

	it("loses the race to a reply that arrives first, and drops its listener", async () => {
		const controller = new AbortController();
		const cancelled = abortRace(controller.signal);
		await expect(
			Promise.race([Promise.resolve("reply"), cancelled.promise]),
		).resolves.toBe("reply");
		// Without the dispose, every turn would leave a listener behind on a
		// signal that outlives it.
		cancelled.dispose();
		controller.abort();
	});

	it("wins the race when the turn is cancelled mid-wait", async () => {
		const controller = new AbortController();
		const cancelled = abortRace(controller.signal);
		const never = new Promise<string>(() => {});
		controller.abort();
		await expect(Promise.race([never, cancelled.promise])).rejects.toThrow(
			/aborted/i,
		);
		cancelled.dispose();
	});
});
