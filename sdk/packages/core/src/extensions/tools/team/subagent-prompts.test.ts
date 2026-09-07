import { describe, expect, it } from "vitest";
import type { DelegatedAgentRuntimeConfig } from "./delegated-agent";
import { buildTeammateSystemPrompt } from "./subagent-prompts";

function config(
	overrides: Partial<DelegatedAgentRuntimeConfig> = {},
): DelegatedAgentRuntimeConfig {
	return {
		providerId: "cline",
		modelId: "sonnet",
		cwd: "/repo",
		...overrides,
	};
}

describe("buildTeammateSystemPrompt", () => {
	it("gives a web-provider worker the tool protocol it can only get from the prompt", () => {
		const prompt = buildTeammateSystemPrompt(
			"Read the report and list the revenue figures.",
			config({ providerId: "deepseek-web-v2" }),
		);

		// A scraped chat has no function-calling API, so the tool definitions
		// exist nowhere but this text.
		expect(prompt).toContain("CRITICAL TOOL CALLING PROTOCOL");
		expect(prompt).toContain("read_files");
		expect(prompt).toContain("Read the report and list the revenue figures.");
		expect(prompt).toContain("# Finishing a delegated task");
	});

	it("advertises only the tools the worker was granted", () => {
		const prompt = buildTeammateSystemPrompt(
			"Read the report.",
			config({
				providerId: "deepseek-web-v2",
				tools: ["read_files", "search_codebase"],
			}),
		);

		expect(prompt).toContain("**read_files**");
		expect(prompt).toContain("**search_codebase**");
		// The tool list in a web provider's prompt IS its tool list. Showing a
		// scoped worker `editor` made it call `editor`, every time.
		expect(prompt).not.toContain("**editor**");
		expect(prompt).not.toContain("**run_commands**");
	});

	it("leaves an unscoped worker every tool", () => {
		const prompt = buildTeammateSystemPrompt(
			"Do the job.",
			config({ providerId: "deepseek-web-v2" }),
		);

		expect(prompt).toContain("**editor**");
		expect(prompt).toContain("**run_commands**");
	});

	it("does not append project rules, which the runtime already appends", () => {
		// A teammate inherits the session's extensions, and the user-instruction
		// extension appends the rules when the runtime composes the prompt.
		// Appending them here too put all of AGENTS.md in twice.
		const prompt = buildTeammateSystemPrompt(
			"Edit files.",
			config({
				providerId: "claude-web",
				rules: "Always run bun run build:sdk.",
			}),
		);

		expect(prompt).not.toContain("Always run bun run build:sdk.");
	});

	it("does not rebuild a prompt that was already built", () => {
		const once = buildTeammateSystemPrompt(
			"Do the job.",
			config({ providerId: "claude-web" }),
		);
		// Restoring a persisted teammate replays its built prompt through here.
		const twice = buildTeammateSystemPrompt(
			once,
			config({ providerId: "claude-web" }),
		);

		expect(twice).toBe(once);
	});

	it("gives a plain non-Cline provider only its role prompt", () => {
		const prompt = buildTeammateSystemPrompt(
			"Do the job.",
			config({ providerId: "openrouter", rules: "Use bun." }),
		);

		expect(prompt).toContain("Do the job.");
		expect(prompt).not.toContain("CRITICAL TOOL CALLING PROTOCOL");
	});
});
