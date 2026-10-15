import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_TOOL_OUTPUT_LIMITS,
	WEB_ATTACH_TOOL_OUTPUT_LIMITS,
} from "../../extensions/tools/executors/output-limits";
import { resolveToolOutputLimits } from "./tool-output-limits";

const ENV = "DEEPSEEK_WEB_V2_PASTE_AS_FILE_CHARS";

describe("resolveToolOutputLimits", () => {
	const saved = process.env[ENV];
	afterEach(() => {
		if (saved === undefined) delete process.env[ENV];
		else process.env[ENV] = saved;
	});

	it("widens the caps for a web chat that attaches long text", () => {
		process.env[ENV] = "4000";
		expect(resolveToolOutputLimits("deepseek-web-v2")).toBe(
			WEB_ATTACH_TOOL_OUTPUT_LIMITS,
		);
	});

	it("keeps the defaults when paste-as-file is off", () => {
		process.env[ENV] = "0";
		expect(resolveToolOutputLimits("deepseek-web-v2")).toBe(
			DEFAULT_TOOL_OUTPUT_LIMITS,
		);
	});

	it("keeps the defaults for API providers", () => {
		process.env[ENV] = "4000";
		expect(resolveToolOutputLimits("anthropic")).toBe(
			DEFAULT_TOOL_OUTPUT_LIMITS,
		);
	});
});
