import { describe, expect, it } from "vitest";
import {
	buildClineSystemPrompt,
	MODE_TAG_INSTRUCTIONS,
	PLAN_MODE_INSTRUCTIONS,
} from "./cline";
import { SIMPLE_WEB_SYSTEM_PROMPT } from "./simple-web";

const BASE_OPTIONS = {
	ide: "VS Code",
	workspaceRoot: "/workspace/project",
	workspaceName: "project",
	platform: "linux",
};

describe("buildClineSystemPrompt mode instructions", () => {
	it("explains the user_input mode attribute in act mode", () => {
		const prompt = buildClineSystemPrompt({ ...BASE_OPTIONS, mode: "act" });
		expect(prompt).toContain(MODE_TAG_INSTRUCTIONS);
		expect(prompt).toContain('<user_input mode="...">');
		expect(prompt).toContain("<mode_notice>");
		expect(prompt).not.toContain(PLAN_MODE_INSTRUCTIONS);
	});

	it("appends the plan-mode contract only in plan mode", () => {
		const prompt = buildClineSystemPrompt({ ...BASE_OPTIONS, mode: "plan" });
		expect(prompt).toContain(MODE_TAG_INSTRUCTIONS);
		expect(prompt).toContain(PLAN_MODE_INSTRUCTIONS);
		// The mode-tag explanation precedes the plan contract, matching the
		// order the CLI historically composed by hand.
		expect(prompt.indexOf(MODE_TAG_INSTRUCTIONS)).toBeLessThan(
			prompt.indexOf(PLAN_MODE_INSTRUCTIONS),
		);
	});

	it("keeps run_commands available-but-read-only in the plan contract", () => {
		// Explicit product decision: run_commands is NOT removed in plan mode
		// (it is essential for read-only investigation); the mitigation for
		// plan-mode mutations is prompting, so the contract must spell out the
		// inspection-only usage.
		expect(PLAN_MODE_INSTRUCTIONS).toContain("run_commands");
		expect(PLAN_MODE_INSTRUCTIONS).toContain("read-only");
		expect(PLAN_MODE_INSTRUCTIONS).toContain("switch_to_act_mode");
	});

	it("emits mode instructions for both mode: undefined and yolo", () => {
		// After a switch the transcript still contains messages tagged with the
		// other mode, so the explanation is unconditional.
		expect(buildClineSystemPrompt({ ...BASE_OPTIONS })).toContain(
			MODE_TAG_INSTRUCTIONS,
		);
		expect(buildClineSystemPrompt({ ...BASE_OPTIONS, mode: "yolo" })).toContain(
			MODE_TAG_INSTRUCTIONS,
		);
	});

	it("places caller rules before the mode instructions", () => {
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			mode: "plan",
			rules: "# Custom Rules\n\nAlways speak like a pirate.",
		});
		const rulesIndex = prompt.indexOf("Always speak like a pirate.");
		expect(rulesIndex).toBeGreaterThan(-1);
		expect(rulesIndex).toBeLessThan(prompt.indexOf(MODE_TAG_INSTRUCTIONS));
	});

	it("respects an explicit override prompt without injecting mode sections", () => {
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			mode: "plan",
			overridePrompt: "You are a custom agent.",
		});
		expect(prompt).toBe("You are a custom agent.");
	});
});

describe("web provider tool docs", () => {
	const WEB = { ...BASE_OPTIONS, providerId: "qwen-web", mode: "act" as const };

	it("does not include plan/act mode instructions for web providers", () => {
		const prompt = buildClineSystemPrompt(WEB);
		expect(prompt).not.toContain(MODE_TAG_INSTRUCTIONS);
		expect(prompt).not.toContain(PLAN_MODE_INSTRUCTIONS);
		expect(prompt).not.toContain('<user_input mode="...">');
		expect(prompt).not.toContain("<mode_notice>");
		expect(prompt).not.toContain("switch_to_act_mode");
	});

	it("does not include plan/act mode instructions for web providers in plan mode", () => {
		const prompt = buildClineSystemPrompt({ ...WEB, mode: "plan" });
		expect(prompt).not.toContain(MODE_TAG_INSTRUCTIONS);
		expect(prompt).not.toContain(PLAN_MODE_INSTRUCTIONS);
		expect(prompt).not.toContain("switch_to_act_mode");
	});

	it("tells a provider's own web prompt which folder it is working in", () => {
		const prompt = buildClineSystemPrompt({
			...WEB,
			workspaceRoot: "C:\\Users\\quang\\Downloads",
			prompts: { default: SIMPLE_WEB_SYSTEM_PROMPT },
		});
		expect(prompt).toContain("Folder: C:\\Users\\quang\\Downloads");
		expect(prompt).not.toContain("{{CWD}}");
	});

	it("drops the folder line when no folder is known", () => {
		const prompt = buildClineSystemPrompt({
			...WEB,
			workspaceRoot: "",
			prompts: { default: SIMPLE_WEB_SYSTEM_PROMPT },
		});
		expect(prompt).not.toContain("Folder:");
	});

	it("does not offer apply_patch to an unrestricted session", () => {
		const prompt = buildClineSystemPrompt(WEB);
		expect(prompt).toContain("**editor**");
		expect(prompt).not.toContain("**apply_patch**");
		expect(prompt).not.toContain("*** Begin Patch");
	});

	it("offers apply_patch only when the agent was granted it", () => {
		const prompt = buildClineSystemPrompt({
			...WEB,
			tools: ["read_files", "apply_patch"],
		});
		expect(prompt).toContain("**apply_patch**");
		expect(prompt).toContain("*** Begin Patch");
		expect(prompt).not.toContain("**editor**");
	});

	it("names apply_patch in the edit workflow step when that is the tool", () => {
		const prompt = buildClineSystemPrompt({
			...WEB,
			tools: ["read_files", "apply_patch"],
		});
		expect(prompt).toContain("**Precision Edits**: Use the `apply_patch` tool");
		expect(prompt).not.toContain("**Precision Edits**: Use the `editor` tool");
	});

	it("still names editor when that is the tool", () => {
		const prompt = buildClineSystemPrompt({
			...WEB,
			tools: ["read_files", "editor"],
		});
		expect(prompt).toContain("**Precision Edits**: Use the `editor` tool");
	});
});
