import { describe, expect, it } from "vitest";
import { isRateLimitText } from "./config";

/**
 * chatgpt-web arms a one-shot page reload whenever a reply is flagged as
 * throttled, so a false positive reloads the page on the next turn. With these
 * providers now running coding sessions, an assistant explaining retry code
 * writes "rate limit" and "try again later" as ordinary prose — which used to
 * reload the page on essentially every turn of any conversation about
 * throttling.
 */
describe("isRateLimitText", () => {
	it("flags a real throttle notice", () => {
		expect(
			isRateLimitText("Messages too frequent, please try again later"),
		).toBe(true);
		expect(isRateLimitText("You have sent too many requests. Slow down.")).toBe(
			true,
		);
	});

	it("ignores a long reply that merely discusses rate limiting", () => {
		const reply = `Here is how the backoff works. ${"The client retries with jitter. ".repeat(
			20,
		)} When you hit the rate limit, try again later.`;
		expect(reply.length).toBeGreaterThan(400);
		expect(isRateLimitText(reply)).toBe(false);
	});

	it("does not treat an identifier as a throttle phrase", () => {
		// `rate.limit` was written with a bare `.`, which matches any character,
		// so every one of these used to flag as a throttled reply.
		for (const identifier of ["rateLimiter", "RATELIMIT", "rate_limit"]) {
			expect(isRateLimitText(`const ${identifier} = 5;`)).toBe(false);
		}
	});

	it("still matches the English phrase", () => {
		// A separator is required. `ratelimit` and `rate_limit` are how code
		// spells it, not how a throttle notice does.
		expect(isRateLimitText("rate limit")).toBe(true);
		expect(isRateLimitText("rate-limit")).toBe(true);
	});
});
