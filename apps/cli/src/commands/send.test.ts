import { describe, expect, it } from "vitest";
import { looksUnattended } from "./send";

/**
 * `send` refuses a session that approves tool calls through an attached client,
 * because it does not attach: the turn would stop at the first approval and
 * wait for an answer that never arrives. The only signal available from
 * `session.list` is the metadata `startRuntimeSession` recorded.
 */
describe("looksUnattended", () => {
	it("accepts a zen session", () => {
		expect(
			looksUnattended({ source: "cline-cli-zen", interactive: false }),
		).toBe(true);
	});

	it("accepts anything explicitly non-interactive", () => {
		expect(looksUnattended({ source: "cline-cli", interactive: false })).toBe(
			true,
		);
	});

	it("rejects an ordinary interactive session", () => {
		expect(looksUnattended({ source: "cline-cli", interactive: true })).toBe(
			false,
		);
	});

	it("rejects a session with no metadata rather than guessing", () => {
		// Refusing is recoverable (`--force`); guessing wrong hangs the caller.
		expect(looksUnattended(undefined)).toBe(false);
		expect(looksUnattended({})).toBe(false);
	});
});
