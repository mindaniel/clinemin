import { describe, expect, it } from "vitest";
import { describeClineProcess } from "./stop-all";

describe("describeClineProcess", () => {
	it("names the hub daemon on either path style", () => {
		expect(
			describeClineProcess(
				"bun --conditions=development C:\\repo\\sdk\\packages\\core\\src\\hub\\daemon\\entry.ts --port 25466",
			),
		).toBe("hub daemon");
		expect(
			describeClineProcess(
				"bun /repo/sdk/packages/core/src/hub/daemon/entry.ts",
			),
		).toBe("hub daemon");
	});

	it("separates the example bridge from a connector", () => {
		expect(
			describeClineProcess(
				"node /repo/apps/examples/telegram-bridge/src/index.ts",
			),
		).toBe("telegram-bridge (example)");
		expect(
			describeClineProcess(
				"bun /repo/apps/cli/src/index.ts connect telegram -k x",
			),
		).toBe("connector");
	});

	it("falls back to a plain session", () => {
		expect(describeClineProcess("bun /repo/apps/cli/src/index.ts -i")).toBe(
			"cline session",
		);
	});
});
