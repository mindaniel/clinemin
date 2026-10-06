import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	LanguageModelV2CallOptions,
	LanguageModelV2StreamPart,
} from "@ai-sdk/provider";
import { afterAll, describe, expect, it } from "vitest";

// The paste slot is a file under CLINE_DIR, captured at import time.
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cline-ds-v2-paste-"));
process.env.CLINE_DIR = TEST_DIR;

afterAll(() => {
	fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("deepseek-web-v2 doStream with a /paste reply", () => {
	it("streams the pasted reply instead of an empty response", async () => {
		const { setPendingInjectedReply } = await import(
			"../tool-pipeline/injected-reply"
		);
		const { createDeepSeekWebV2ProviderModule } = await import("./model");

		setPendingInjectedReply(
			[
				"Creating it now.",
				"*** Begin Patch",
				"*** Add File: C:\\tmp\\a.py",
				"+print(1)",
				"*** End Patch",
			].join("\n"),
			"deepseek-web-v2",
		);

		const model = createDeepSeekWebV2ProviderModule(
			{} as never,
			{} as never,
		).model("default");
		const options = {
			prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
			tools: [
				{
					type: "function",
					name: "apply_patch",
					inputSchema: { type: "object" },
				},
			],
		} as unknown as LanguageModelV2CallOptions;

		const { stream } = await model.doStream(options);
		const parts: LanguageModelV2StreamPart[] = [];
		const reader = stream.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			parts.push(value);
		}

		const calls = parts.filter((p) => p.type === "tool-call");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ toolName: "apply_patch" });
		const text = parts
			.filter((p) => p.type === "text-delta")
			.map((p) => (p as { delta: string }).delta)
			.join("");
		expect(text).toBe("Creating it now.");
	});
});
