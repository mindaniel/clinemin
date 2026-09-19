import { buildClineSystemPrompt } from "@cline/shared";
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

		// A scraped chat has no function-calling API, so whatever contract it
		// works to exists nowhere but this text. For the web providers that is
		// now the human-in-the-loop prompt -- PowerShell to read with, a patch
		// block to edit with -- because handing a chat model the JSON tool
		// contract makes it spend the turn formatting JSON instead of thinking.
		// See the `worker` slot in each provider's `prompts.ts`.
		expect(prompt).toContain("```powershell");
		expect(prompt).toContain("*** Begin Patch");
		expect(prompt).toContain("Read the report and list the revenue figures.");
		expect(prompt).toContain("# Finishing a delegated task");
	});

	it("advertises only the tools a worker was granted, where that applies", () => {
		// Asserted against the prompt builder rather than through
		// `buildTeammateSystemPrompt`, because every web provider currently
		// overrides its `worker` slot with a fixed text and so never reaches this
		// rendering. The property still matters: the moment a provider drops that
		// override, this is the path its workers take, and a worker shown a tool
		// it does not hold calls it every time.
		const scoped = buildClineSystemPrompt({
			providerId: "claude-web",
			workspaceRoot: "/repo",
			role: "worker",
			tools: ["read_files", "search_codebase"],
		});

		expect(scoped).toContain("**read_files**");
		expect(scoped).toContain("**search_codebase**");
		expect(scoped).not.toContain("**editor**");
		expect(scoped).not.toContain("**run_commands**");
	});

	it("gives a scoped web worker the fixed prompt, scope enforced elsewhere", () => {
		// A known gap, recorded rather than asserted away: the web providers'
		// `worker` slot is one fixed text, so a read-only worker is still told
		// how to send patch blocks. It cannot act on that -- `buildTeammateTools`
		// hands it only the tools it was granted and the runtime rejects the rest
		// -- but the prompt does not say so, which is the same class of problem
		// the tool-scope rendering above was written to fix.
		const scoped = buildTeammateSystemPrompt(
			"Read the report.",
			config({
				providerId: "deepseek-web-v2",
				tools: ["read_files", "search_codebase"],
			}),
		);
		const unscoped = buildTeammateSystemPrompt(
			"Read the report.",
			config({ providerId: "deepseek-web-v2" }),
		);

		expect(scoped).toBe(unscoped);
		expect(scoped).toContain("*** Begin Patch");
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

	it("stays idempotent across repeated restores on every provider family", () => {
		// The guard used to test only for the tool-calling contract heading. When
		// the web providers moved their `worker` slot to the human-in-the-loop
		// prompt, which has no such heading, a restored worker was re-wrapped on
		// every restart -- 3.2k to 5.1k characters on the first one, and it
		// compounds because each restart persists the larger prompt.
		for (const providerId of ["deepseek-web-v2", "claude-web", "cline"]) {
			const once = buildTeammateSystemPrompt(
				"Do the job.",
				config({ providerId }),
			);
			const twice = buildTeammateSystemPrompt(once, config({ providerId }));
			const thrice = buildTeammateSystemPrompt(twice, config({ providerId }));

			expect(thrice).toBe(once);
			expect(thrice.split("# Team Teammate Role").length - 1).toBe(1);
		}
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
