import type { TeamRosterWorker } from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	ACTION_DELETE,
	ACTION_MODEL,
	applyModel,
	applyProvider,
	applyToolPreset,
	buildActionRows,
	buildModelRows,
	buildProviderRows,
	buildToolRows,
	buildWorker,
	buildWorkerRows,
	isValidAgentId,
	presetForTools,
	ROW_ADD,
	ROW_INHERIT,
	ROW_SAVE,
	renameWorker,
	uniqueAgentId,
	WORKER_TOOL_PRESETS,
} from "./workers-dialog-helpers";

function worker(overrides: Partial<TeamRosterWorker> = {}): TeamRosterWorker {
	return {
		agentId: "deepseek",
		rolePrompt: WORKER_TOOL_PRESETS[0].rolePrompt,
		providerId: "deepseek-web-v2",
		tools: [...WORKER_TOOL_PRESETS[0].tools],
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
		expect(rows[0]).toBe("Provider: deepseek-web-v2");
		expect(rows[1]).toBe("Model: deepseek-reasoner");
		expect(rows[2]).toBe("Tools: read-only");
	});

	it("offers inheriting the lead's model ahead of the real models", () => {
		const rows = buildModelRows(["a", "b"], "b");
		expect(rows[0]?.key).toBe(ROW_INHERIT);
		expect(rows.find((row) => row.key === "b")?.label).toContain("(current)");
	});

	it("marks the current provider and preset", () => {
		expect(
			buildProviderRows(["x", "y"], "y").find((row) => row.key === "y")?.label,
		).toContain("(current)");
		expect(
			buildToolRows([...WORKER_TOOL_PRESETS[2].tools]).find(
				(row) => row.key === "full",
			)?.label,
		).toContain("(current)");
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

describe("applyToolPreset", () => {
	it("swaps tools and the matching role prompt", () => {
		const next = applyToolPreset(worker(), "full");
		expect(next.tools).toEqual([...WORKER_TOOL_PRESETS[2].tools]);
		expect(next.rolePrompt).toBe(WORKER_TOOL_PRESETS[2].rolePrompt);
	});

	it("keeps a hand-written role prompt", () => {
		const next = applyToolPreset(worker({ rolePrompt: "Mine." }), "full");
		expect(next.rolePrompt).toBe("Mine.");
		expect(next.tools).toEqual([...WORKER_TOOL_PRESETS[2].tools]);
	});

	it("falls back to the first preset on an unknown id", () => {
		expect(applyToolPreset(worker(), "nope").tools).toEqual([
			...WORKER_TOOL_PRESETS[0].tools,
		]);
	});
});

describe("buildWorker", () => {
	it("names the worker after the provider and applies the preset", () => {
		const created = buildWorker({
			providerId: "gemini-web",
			modelId: "gemini-3-pro",
			presetId: "edit",
			taken: ["deepseek"],
		});
		expect(created).toEqual({
			agentId: "gemini",
			providerId: "gemini-web",
			modelId: "gemini-3-pro",
			rolePrompt: WORKER_TOOL_PRESETS[1].rolePrompt,
			tools: [...WORKER_TOOL_PRESETS[1].tools],
		});
	});

	it("omits modelId when the lead's model is inherited", () => {
		const created = buildWorker({
			providerId: "gemini-web",
			presetId: "read",
			taken: [],
		});
		expect("modelId" in created).toBe(false);
	});

	it("avoids a name already in the roster", () => {
		expect(
			buildWorker({
				providerId: "qwen-web",
				presetId: "read",
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

describe("presetForTools", () => {
	it("ignores order", () => {
		expect(presetForTools(["search_codebase", "read_files"])?.id).toBe("read");
	});

	it("returns nothing for an unscoped worker", () => {
		expect(presetForTools(undefined)).toBeUndefined();
	});
});

describe("action row ids", () => {
	it("keeps the model action distinct from the delete action", () => {
		expect(ACTION_MODEL).not.toBe(ACTION_DELETE);
	});
});
