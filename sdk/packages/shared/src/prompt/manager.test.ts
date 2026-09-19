import { describe, expect, it } from "vitest";
import { buildClineSystemPrompt } from "./cline";
import { buildManagerSystemPrompt, shortProviderName } from "./manager";

describe("buildManagerSystemPrompt", () => {
	it("lists workers by the name the runtime dispatches on", () => {
		const prompt = buildManagerSystemPrompt({
			workers: [
				{ agentId: "deepseek", providerId: "deepseek-web-v2" },
				{ agentId: "gemini", providerId: "gemini-web" },
			],
		});

		expect(prompt).toContain("- deepseek");
		expect(prompt).toContain("- gemini");
		// The transport suffix is noise the manager cannot act on, and inviting
		// `TO: deepseek-web` for a worker registered as `deepseek-web-v2` is a
		// dispatch failure it cannot diagnose.
		expect(prompt).not.toContain("-web");
	});

	it("prints the user's note beside the worker it belongs to", () => {
		const prompt = buildManagerSystemPrompt({
			workers: [
				{ agentId: "deepseek", notes: "fast, good at code" },
				{ agentId: "gemini", notes: "web search and reading,\n  not coding" },
				{ agentId: "qwen" },
			],
		});

		expect(prompt).toContain("- deepseek — fast, good at code");
		// Collapsed to one line, so a multi-line note cannot become the bulk of
		// the roster.
		expect(prompt).toContain("- gemini — web search and reading, not coding");
		// A worker with no note keeps the bare line it had before.
		expect(prompt).toContain("- qwen\n");
	});

	it("does not print a fixed tool scope, which is the manager's call", () => {
		const prompt = buildManagerSystemPrompt({
			workers: [
				{
					agentId: "qwen",
					providerId: "qwen-web",
					tools: ["read_files", "search_codebase"],
				},
			],
		});

		expect(prompt).toContain("- qwen");
		expect(prompt).not.toContain("can use:");
	});

	it("asks for PowerShell in a fence rather than a verify tag", () => {
		const prompt = buildManagerSystemPrompt({ workers: [{ agentId: "w" }] });

		expect(prompt).toContain("```powershell");
		expect(prompt).not.toContain("<verify>");
	});

	it("says an empty roster is workable rather than printing nothing", () => {
		expect(buildManagerSystemPrompt({})).toContain("none yet");
	});

	it("names the workers' folder and omits the section when there is none", () => {
		expect(
			buildManagerSystemPrompt({ workspaceRoot: "C:\repoclinemin" }),
		).toContain("C:\repoclinemin");
		expect(buildManagerSystemPrompt({})).not.toContain(
			"That's where their paths",
		);
	});

	it("addresses the example block to a real worker when there is one", () => {
		const prompt = buildManagerSystemPrompt({
			workers: [{ agentId: "qwen", providerId: "qwen-web" }],
		});

		expect(prompt).toContain("TO: qwen");
		expect(prompt).not.toContain("TO: worker-name");
	});

	it("never puts the manager itself in the tool-calling contract", () => {
		const prompt = buildManagerSystemPrompt({
			workers: [{ agentId: "w" }],
			workspaceRoot: "/repo",
		});

		// Tool NAMES appear, because granting capability is the manager's job.
		expect(prompt).toContain("TOOLS:");
		expect(prompt).toContain("read_files");
		// The calling contract does not: a manager that thinks it can emit a
		// <tool> block reaches for tools it has no executor for, and the turn
		// dies. It writes prose; the runtime turns that into delegations.
		expect(prompt).not.toContain("<tool>");
		expect(prompt).not.toContain("CRITICAL TOOL CALLING PROTOCOL");
		expect(prompt).not.toContain("arguments");
	});
});

describe("buildClineSystemPrompt in manager mode", () => {
	it("replaces the web-provider prompt, which advertises tools", () => {
		const prompt = buildClineSystemPrompt({
			providerId: "claude-web",
			workspaceRoot: "/repo",
			managerMode: true,
			managerWorkers: [{ agentId: "reader", providerId: "kimi-web" }],
		});

		expect(prompt).toContain("<manager>");
		// The web-provider prompt tells the model to emit <tool> blocks; the
		// manager prompt must replace that entirely.
		expect(prompt).not.toContain("<tool>");
		expect(prompt).not.toContain("CRITICAL TOOL CALLING PROTOCOL");
	});

	it("leaves project rules to the workers", () => {
		const prompt = buildClineSystemPrompt({
			providerId: "cline",
			workspaceRoot: "/repo",
			managerMode: true,
			rules: "# Rules\nAlways run bun run build:sdk.",
		});

		expect(prompt).not.toContain("build:sdk");
	});

	it("yields to an explicit system prompt", () => {
		const prompt = buildClineSystemPrompt({
			providerId: "claude-web",
			managerMode: true,
			overridePrompt: "Just help me.",
		});

		expect(prompt).toBe("Just help me.");
	});
});

describe("shortProviderName", () => {
	it("strips the transport suffix", () => {
		expect(shortProviderName("qwen-web")).toBe("qwen");
		expect(shortProviderName("gemini-web")).toBe("gemini");
		expect(shortProviderName("deepseek-web-v2")).toBe("deepseek");
	});

	it("leaves an API provider alone", () => {
		expect(shortProviderName("anthropic")).toBe("anthropic");
		expect(shortProviderName("openai-native")).toBe("openai-native");
	});
});
