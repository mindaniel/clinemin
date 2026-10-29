import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHandoverTool } from "./handover-tool";

const dirs: string[] = [];

function workspaceWith(roster: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "handover-"));
	dirs.push(dir);
	mkdirSync(join(dir, ".cline"));
	writeFileSync(join(dir, ".cline", "team.json"), JSON.stringify(roster));
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const roster = {
	version: 1,
	workers: [{ agentId: "qwen", rolePrompt: "edits" }],
	managers: [
		{ agentId: "claude-2", providerId: "claude-web" },
		{ agentId: "claude-3", providerId: "claude-web" },
	],
};

describe("createHandoverTool", () => {
	it("is not offered when the roster names no other manager", () => {
		const workspaceRoot = workspaceWith({ version: 1, workers: [] });
		expect(
			createHandoverTool({ workspaceRoot, startSuccessor: vi.fn() }),
		).toBeUndefined();
	});

	it("does not offer a manager itself as its successor", () => {
		const workspaceRoot = workspaceWith({
			...roster,
			managers: [roster.managers[0]],
		});
		expect(
			createHandoverTool({
				workspaceRoot,
				self: "claude-2",
				startSuccessor: vi.fn(),
			}),
		).toBeUndefined();
	});

	it("starts the named manager and ends the turn", async () => {
		const workspaceRoot = workspaceWith(roster);
		const startSuccessor = vi.fn(async () => "sess_2");
		const tool = createHandoverTool({ workspaceRoot, startSuccessor });
		const result = await tool?.execute(
			{ to: "claude-3", summary: "Left: tests." },
			{} as never,
		);
		expect(startSuccessor).toHaveBeenCalledWith(
			{ agentId: "claude-3", providerId: "claude-web" },
			"Left: tests.",
		);
		expect(result).toMatchObject({ endsTurn: true });
	});

	it("refuses a name that is not a manager", async () => {
		const workspaceRoot = workspaceWith(roster);
		const tool = createHandoverTool({ workspaceRoot, startSuccessor: vi.fn() });
		await expect(
			tool?.execute({ to: "qwen", summary: "x" }, {} as never),
		).rejects.toThrow(/no manager called "qwen"/);
	});
});
