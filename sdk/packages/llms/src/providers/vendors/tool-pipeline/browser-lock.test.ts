import { describe, expect, it } from "vitest";
import { isBrowserBusy, withBrowserLock } from "./browser-lock";

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("withBrowserLock", () => {
	it("runs one turn at a time per key", async () => {
		const events: string[] = [];
		const first = deferred();
		const second = deferred();

		const a = withBrowserLock("p1", undefined, async () => {
			events.push("a:start");
			await first.promise;
			events.push("a:end");
		});
		const b = withBrowserLock("p1", undefined, async () => {
			events.push("b:start");
			await second.promise;
			events.push("b:end");
		});

		// `b` must not have touched the browser while `a` holds it — this is the
		// whole point: two sessions driving one Chrome profile is what left a new
		// chat open and empty.
		await Promise.resolve();
		expect(events).toEqual(["a:start"]);

		first.resolve();
		await Promise.resolve();
		await Promise.resolve();
		second.resolve();
		await Promise.all([a, b]);

		expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
	});

	it("keeps separate queues per key", async () => {
		const events: string[] = [];
		const blocker = deferred();

		const a = withBrowserLock("p1", undefined, async () => {
			events.push("p1:start");
			await blocker.promise;
		});
		const b = withBrowserLock("p2", undefined, async () => {
			events.push("p2:start");
		});

		await b;
		// A turn on a different provider drives a different browser profile, so it
		// must not wait behind this one.
		expect(events).toContain("p2:start");

		blocker.resolve();
		await a;
	});

	it("releases the lock when a turn throws", async () => {
		const failed = withBrowserLock("p1", undefined, async () => {
			throw new Error("boom");
		});
		await expect(failed).rejects.toThrow("boom");

		await expect(
			withBrowserLock("p1", undefined, async () => "next"),
		).resolves.toBe("next");
	});

	it("runs a queued turn even when the one ahead of it failed", async () => {
		const blocker = deferred();
		const first = withBrowserLock("p1", undefined, async () => {
			await blocker.promise;
			throw new Error("first failed");
		});
		const second = withBrowserLock("p1", undefined, async () => "second");

		blocker.resolve();
		await expect(first).rejects.toThrow("first failed");
		await expect(second).resolves.toBe("second");
	});

	it("does not run a turn cancelled while it waited", async () => {
		const blocker = deferred();
		const controller = new AbortController();
		let ran = false;

		const holder = withBrowserLock("p1", undefined, async () => {
			await blocker.promise;
		});
		const queued = withBrowserLock("p1", controller.signal, async () => {
			ran = true;
		});

		// Cancelled while queued: by the time the browser frees up the user has
		// moved on, and driving it now would steal the tab from a live turn.
		controller.abort();
		blocker.resolve();
		await holder;
		await expect(queued).rejects.toThrow();
		expect(ran).toBe(false);
	});

	it("reports the key as free again once every turn has finished", async () => {
		await withBrowserLock("p-idle", undefined, async () => undefined);
		expect(isBrowserBusy("p-idle")).toBe(false);
	});
});
