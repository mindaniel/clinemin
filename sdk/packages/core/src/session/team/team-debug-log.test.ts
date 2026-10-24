import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamEvent } from "../../extensions/tools/team";
import {
	formatAgentEvent,
	formatTeamEvent,
	logLeadEvent,
	logTeamEvent,
	teamDebugLogPath,
} from "./team-debug-log";

describe("team debug log", () => {
	let dataDir: string;

	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), "team-log-"));
		vi.stubEnv("CLINE_DATA_DIR", dataDir);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(dataDir, { recursive: true, force: true });
	});

	it("formats a worker's spawn, task, tool call, result and reply", () => {
		expect(
			formatTeamEvent({
				type: "teammate_spawned",
				agentId: "qwen",
				teammate: {
					rolePrompt: "x",
					providerId: "llamacpp",
					modelId: "C:/m/qwen.gguf",
					tools: ["run_commands", "apply_patch"],
				},
			} as TeamEvent),
		).toBe(
			"SPAWN qwen provider=llamacpp model=C:/m/qwen.gguf tools=[run_commands, apply_patch]",
		);
		expect(
			formatAgentEvent("qwen", {
				type: "content_start",
				contentType: "tool",
				toolName: "run_commands",
				input: { commands: ["Get-ChildItem"] },
			}),
		).toBe('qwen TOOL run_commands {"commands":["Get-ChildItem"]}');
		expect(
			formatAgentEvent("qwen", {
				type: "content_end",
				contentType: "tool",
				toolName: "run_commands",
				output: "a.ts",
				durationMs: 12,
			}),
		).toBe("qwen RESULT run_commands (12ms):\na.ts");
		expect(
			formatAgentEvent("qwen", {
				type: "content_end",
				contentType: "tool",
				toolName: "apply_patch",
				error: "hunk failed",
			}),
		).toBe("qwen TOOL FAILED apply_patch: hunk failed");
		expect(
			formatAgentEvent("qwen", {
				type: "error",
				error: new Error("connect ECONNREFUSED"),
				recoverable: false,
				iteration: 2,
			}),
		).toBe("qwen ERROR at iteration 2: connect ECONNREFUSED");
	});

	it("skips streaming noise", () => {
		expect(
			formatAgentEvent("qwen", { type: "iteration_start", iteration: 1 }),
		).toBeUndefined();
	});

	it("writes worker and manager lines to one file per session", () => {
		logTeamEvent("s1", {
			type: "task_start",
			agentId: "qwen",
			message: "list files\nin src",
		} as TeamEvent);
		logLeadEvent("s1", {
			type: "content_end",
			contentType: "text",
			text: "TO: qwen",
		});
		const log = readFileSync(teamDebugLogPath("s1"), "utf8");
		expect(log).toMatch(/Z TASK -> qwen:\n {4}list files\n {4}in src\n/);
		expect(log).toMatch(/Z manager SAYS:\n {4}TO: qwen\n/);
	});

	it("writes nothing with CLINE_TEAM_LOG=off", () => {
		vi.stubEnv("CLINE_TEAM_LOG", "off");
		logLeadEvent("s2", { type: "notice", noticeType: "status", message: "x" });
		expect(existsSync(teamDebugLogPath("s2"))).toBe(false);
	});
});
