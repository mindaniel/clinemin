import { describe, expect, it } from "vitest";
import {
	DEFAULT_MODEL_TOOL_ROUTING_RULES,
	resolveToolRoutingConfig,
} from "./model-tool-routing";

describe("model tool routing", () => {
	it("applies default codex/gpt routing in act mode", () => {
		const config = resolveToolRoutingConfig(
			"openai",
			"openai/gpt-5.4",
			"act",
			DEFAULT_MODEL_TOOL_ROUTING_RULES,
		);

		expect(config.enableApplyPatch).toBe(true);
		expect(config.enableEditor).toBe(false);
	});

	it("does not apply default codex/gpt routing in plan mode", () => {
		const config = resolveToolRoutingConfig(
			"openai",
			"openai/gpt-5.4",
			"plan",
			DEFAULT_MODEL_TOOL_ROUTING_RULES,
		);

		expect(config).toEqual({});
	});

	it("applies matching custom rules in order", () => {
		const config = resolveToolRoutingConfig(
			"anthropic",
			"claude-sonnet-4-6",
			"act",
			[
				{
					name: "claude-editor-off",
					mode: "act",
					modelIdIncludes: ["claude"],
					disableTools: ["editor"],
				},
				{
					name: "claude-apply-patch-on",
					mode: "act",
					modelIdIncludes: ["claude"],
					enableTools: ["apply_patch"],
				},
			],
		);

		expect(config.enableEditor).toBe(false);
		expect(config.enableApplyPatch).toBe(true);
	});

	it("returns empty config when no rules match", () => {
		const config = resolveToolRoutingConfig(
			"anthropic",
			"claude-sonnet-4-6",
			"act",
			[
				{
					mode: "act",
					modelIdIncludes: ["gpt"],
					enableTools: ["apply_patch"],
				},
			],
		);

		expect(config).toEqual({});
	});

	it("can match provider-only rules", () => {
		const config = resolveToolRoutingConfig("openai", "o4-mini", "act", [
			{
				mode: "act",
				providerIdIncludes: ["openai"],
				enableTools: ["apply_patch"],
				disableTools: ["editor"],
			},
		]);

		expect(config.enableApplyPatch).toBe(true);
		expect(config.enableEditor).toBe(false);
	});
	// Every web provider, and the same list as the prompt registry in
	// `llms/.../tool-pipeline/prompt-registry.ts`. They all get
	// `SIMPLE_WEB_SYSTEM_PROMPT`, which teaches the `*** Begin Patch` grammar,
	// and `parsePatchBlocks` only reads a bare patch block when the session
	// actually holds `apply_patch`. A provider on one list and not the other
	// writes patches nothing parses.
	it.each([
		"claude-web",
		"chatgpt-web",
		"deepseek-web",
		"deepseek-web-v2",
		"gemini-web",
		"grok-web",
		"kimi-web",
		"qwen-web",
	])("routes %s to apply_patch instead of editor", (providerId) => {
		const config = resolveToolRoutingConfig(
			providerId,
			"any-model",
			"act",
			DEFAULT_MODEL_TOOL_ROUTING_RULES,
		);

		expect(config.enableApplyPatch).toBe(true);
		expect(config.enableEditor).toBe(false);
	});

	it.each([
		"cline",
		"anthropic",
		"ollama",
	])("leaves %s on the editor tool", (providerId) => {
		const config = resolveToolRoutingConfig(
			providerId,
			"any-model",
			"act",
			DEFAULT_MODEL_TOOL_ROUTING_RULES,
		);

		expect(config.enableApplyPatch).toBeUndefined();
		expect(config.enableEditor).toBeUndefined();
	});
});
