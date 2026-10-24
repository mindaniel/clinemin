import type { TeamRosterWorker } from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	ACTION_DELETE,
	ACTION_MODEL,
	applyModel,
	applyProvider,
	buildActionRows,
	buildModelRows,
	buildProviderRows,
	buildToolRows,
	buildWorker,
	buildWorkerRows,
	DEFAULT_WORKER_ROLE_PROMPT,
	DEFAULT_WORKER_TOOLS,
	describeTools,
	isValidAgentId,
	ROW_ADD,
	ROW_DONE,
	ROW_INHERIT,
	ROW_SAVE,
	renameWorker,
	toggleWorkerTool,
	uniqueAgentId,
} from "./workers-dialog-helpers";

function worker(overrides: Partial<TeamRosterWorker> = {}): TeamRosterWorker {
	return {
		agentId: "deepseek",
		rolePrompt: DEFAULT_WORKER_ROLE_PROMPT,
		providerId: "deepseek-web-v2",
		tools: [...DEFAULT_WORKER_TOOLS],
		...overrides,
	};
}

describe("row keys", () => {
	it("cannot collide with a worker name", () => {
		// The old dialog let a typed name trigger a command. Command keys now use a
		// character the roster schema forbids in an agentId.
		for (const key of [ROW_ADD, ROW_SAVE, ROW_INHERIT, ACTION_DELETE]) {
			expect(isValidAgentId(key)).toBe(false);
		}
	});

	it("lists every worker plus add and save", () => {
		const rows = buildWorkerRows([worker(), worker({ agentId: "qwen" })], true);
		expect(rows.map((row) => row.key)).toEqual([
			"deepseek",
			"qwen",
			ROW_ADD,
			ROW_SAVE,
		]);
	});

	it("says when there is nothing to save", () => {
		const clean = buildWorkerRows([], false).find(
			(row) => row.key === ROW_SAVE,
		);
		expect(clean?.label).toContain("nothing changed");
	});

	it("shows the current provider, model and tools in the action rows", () => {
		const rows = buildActionRows(worker({ modelId: "deepseek-reasoner" })).map(
			(row) => row.label,
		);
		// The profile comes first: it is what decides the worker's account, and
		// the provider rows below are the pre-profile way of saying the same
		// thing.
		expect(rows[0]).toBe("Profile: (none)");
		expect(rows[1]).toBe("Provider: deepseek-web-v2");
		expect(rows[2]).toBe("Model: deepseek-reasoner");
		expect(rows[3]).toBe("Tools: PowerShell, apply_patch");
	});

	it("hides provider and model once the worker is on a profile", () => {
		// They would do nothing: the profile supersedes them at spawn time, and a
		// row that silently has no effect is worse than one not offered.
		const rows = buildActionRows(
			worker({ profile: "deepseek-work", modelId: undefined }),
			[
				{
					name: "deepseek-work",
					providerId: "deepseek-web-v2",
					browserProfile: "work",
				},
			],
		).map((row) => row.label);
		expect(rows[0]).toContain("Profile: deepseek-work");
		expect(rows[0]).toContain("chrome:work");
		expect(rows.some((label) => label.startsWith("Provider:"))).toBe(false);
		expect(rows.some((label) => label.startsWith("Model:"))).toBe(false);
	});

	it("calls out a profile that is no longer in the store", () => {
		// At spawn time a dangling name falls back to the lead's account, and two
		// workers doing that land in one chat — so it cannot look fine here.
		const rows = buildActionRows(worker({ profile: "deleted" }), []).map(
			(row) => row.label,
		);
		expect(rows[0]).toContain("missing from profiles.json");
	});

	it("offers inheriting the lead's model ahead of the real models", () => {
		const rows = buildModelRows(["a", "b"], "b");
		expect(rows[0]?.key).toBe(ROW_INHERIT);
		expect(rows.find((row) => row.key === "b")?.label).toContain("(current)");
	});

	it("marks the current provider", () => {
		expect(
			buildProviderRows(["x", "y"], "y").find((row) => row.key === "y")?.label,
		).toContain("(current)");
	});

	it("checks the tools a worker holds, with a Done row last", () => {
		const rows = buildToolRows(["run_commands", "editor"]);
		const label = (key: string) => rows.find((row) => row.key === key)?.label;
		expect(label("run_commands")).toBe(
			"[x] PowerShell (run_commands) (default)",
		);
		// editor and apply_patch are one grant, so editor checks apply_patch.
		expect(label("apply_patch")).toContain("[x]");
		expect(label("read_files")).toBe("[ ] read_files");
		expect(rows.at(-1)?.key).toBe(ROW_DONE);
	});
});

describe("uniqueAgentId", () => {
	it("returns the name when it is free", () => {
		expect(uniqueAgentId("qwen", ["deepseek"])).toBe("qwen");
	});

	it("suffixes until it is free", () => {
		expect(uniqueAgentId("qwen", ["qwen", "qwen-2"])).toBe("qwen-3");
	});

	it("falls back when the provider name is not a legal agentId", () => {
		expect(uniqueAgentId("open ai!", [])).toBe("worker");
	});
});

describe("applyProvider", () => {
	it("renames a worker that is named after its provider", () => {
		const next = applyProvider(worker(), "qwen-web", ["deepseek"]);
		expect(next.providerId).toBe("qwen-web");
		expect(next.agentId).toBe("qwen");
	});

	it("does not collide when the new short name is taken", () => {
		const next = applyProvider(worker(), "qwen-web", ["deepseek", "qwen"]);
		expect(next.agentId).toBe("qwen-2");
	});

	it("leaves a hand-picked name alone", () => {
		const next = applyProvider(worker({ agentId: "auditor" }), "qwen-web", [
			"auditor",
		]);
		expect(next.agentId).toBe("auditor");
	});

	it("drops a model that belonged to the old provider", () => {
		const next = applyProvider(
			worker({ modelId: "deepseek-reasoner" }),
			"qwen-web",
			["deepseek"],
		);
		expect(next.modelId).toBeUndefined();
		expect("modelId" in next).toBe(false);
	});

	it("keeps the model when the provider is unchanged", () => {
		const original = worker({ modelId: "deepseek-reasoner" });
		expect(applyProvider(original, "deepseek-web-v2", ["deepseek"])).toBe(
			original,
		);
	});
});

describe("applyModel", () => {
	it("sets a model", () => {
		expect(applyModel(worker(), "qwen3-max").modelId).toBe("qwen3-max");
	});

	it("removes the key entirely when inheriting", () => {
		const next = applyModel(worker({ modelId: "x" }), undefined);
		// `TeamRosterWorkerSchema` is strict and `modelId` is `.min(1)`, so an
		// explicit undefined has to become an absent key, not a present one.
		expect("modelId" in next).toBe(false);
	});
});

describe("toggleWorkerTool", () => {
	it("adds an optional tool and removes it again", () => {
		const on = toggleWorkerTool(worker(), "read_files");
		expect(on.tools).toEqual(["run_commands", "apply_patch", "read_files"]);
		expect(toggleWorkerTool(on, "read_files").tools).toEqual([
			...DEFAULT_WORKER_TOOLS,
		]);
	});

	it("turning apply_patch off drops editor too", () => {
		const next = toggleWorkerTool(
			worker({ tools: ["run_commands", "editor"] }),
			"apply_patch",
		);
		expect(next.tools).toEqual(["run_commands"]);
	});

	it("starts an unscoped worker from every tool", () => {
		const next = toggleWorkerTool(worker({ tools: undefined }), "skills");
		expect(next.tools).toContain("run_commands");
		expect(next.tools).not.toContain("skills");
	});
});

describe("buildWorker", () => {
	it("names the worker after the provider and gives it the default tools", () => {
		const created = buildWorker({
			providerId: "gemini-web",
			modelId: "gemini-3-pro",
			taken: ["deepseek"],
		});
		expect(created).toEqual({
			agentId: "gemini",
			providerId: "gemini-web",
			modelId: "gemini-3-pro",
			rolePrompt: DEFAULT_WORKER_ROLE_PROMPT,
			tools: ["run_commands", "apply_patch"],
		});
	});

	it("omits modelId when the lead's model is inherited", () => {
		const created = buildWorker({
			providerId: "gemini-web",
			taken: [],
		});
		expect("modelId" in created).toBe(false);
	});

	it("avoids a name already in the roster", () => {
		expect(
			buildWorker({
				providerId: "qwen-web",
				taken: ["qwen"],
			}).agentId,
		).toBe("qwen-2");
	});
});

describe("renameWorker", () => {
	const roster = [
		worker(),
		worker({ agentId: "qwen", providerId: "qwen-web" }),
	];

	it("renames", () => {
		const result = renameWorker(roster, "deepseek", "auditor");
		expect(result.ok && result.workers[0]?.agentId).toBe("auditor");
	});

	it("rejects an empty name", () => {
		expect(renameWorker(roster, "deepseek", "  ").ok).toBe(false);
	});

	it("rejects characters the roster schema forbids", () => {
		const result = renameWorker(roster, "deepseek", "dev ops");
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toContain("Only letters");
	});

	it("rejects a duplicate", () => {
		expect(renameWorker(roster, "deepseek", "qwen").ok).toBe(false);
	});

	it("allows renaming a worker to its own name", () => {
		expect(renameWorker(roster, "deepseek", "deepseek").ok).toBe(true);
	});
});

describe("describeTools", () => {
	it("names run_commands PowerShell and folds editor into apply_patch", () => {
		expect(describeTools(["run_commands", "editor", "apply_patch"])).toBe(
			"PowerShell, apply_patch",
		);
	});

	it("says so for an unscoped worker", () => {
		expect(describeTools(undefined)).toBe("every tool (unscoped)");
	});
});

describe("action row ids", () => {
	it("keeps the model action distinct from the delete action", () => {
		expect(ACTION_MODEL).not.toBe(ACTION_DELETE);
	});
});
