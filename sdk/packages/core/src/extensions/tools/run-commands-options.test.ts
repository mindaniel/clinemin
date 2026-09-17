import { describe, expect, it } from "vitest";
import { MAX_COMMAND_TIMEOUT_MS, readRunCommandsOptions } from "./definitions";

describe("readRunCommandsOptions", () => {
	it("reads timeout_seconds and echo", () => {
		expect(
			readRunCommandsOptions({
				commands: ["x"],
				timeout_seconds: 600,
				echo: true,
			}),
		).toEqual({ timeoutMs: 600_000, echo: true });
	});

	it("caps the timeout", () => {
		expect(
			readRunCommandsOptions({ commands: ["x"], timeout_seconds: 999_999 })
				.timeoutMs,
		).toBe(MAX_COMMAND_TIMEOUT_MS);
	});

	it("ignores bad values and non-object input", () => {
		expect(readRunCommandsOptions({ timeout_seconds: -5 })).toEqual({
			timeoutMs: undefined,
			echo: false,
		});
		expect(readRunCommandsOptions(["ls"])).toEqual({ echo: false });
	});
});
