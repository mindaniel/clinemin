import { describe, expect, it } from "vitest";
import type { TeamProgressUpdate } from "../../runtime/session-events";
import {
	applyTeamProgress,
	type BackgroundRunItem,
	describeRunActivity,
} from "./use-background-runs";

function update(
	eventType: string,
	extra: Partial<TeamProgressUpdate["lifecycle"]> = {},
): TeamProgressUpdate {
	return {
		sessionId: "s1",
		lifecycle: {
			teamName: "team",
			sessionId: "s1",
			eventType,
			ts: "2026-10-26T00:00:00.000Z",
			runId: "run_00001",
			agentId: "qwen",
			...extra,
		},
	};
}

describe("applyTeamProgress", () => {
	it("follows a background run from queued to done", () => {
		let runs: BackgroundRunItem[] = [];
		runs = applyTeamProgress(runs, update("run_queued"), 1_000);
		expect(runs).toEqual([
			{
				runId: "run_00001",
				agentId: "qwen",
				status: "queued",
				startedAt: 1_000,
			},
		]);

		runs = applyTeamProgress(runs, update("run_started"), 2_000);
		expect(runs[0]).toMatchObject({ status: "running", startedAt: 2_000 });

		runs = applyTeamProgress(
			runs,
			update("run_progress", { message: "running_tool_run_commands" }),
			3_000,
		);
		expect(runs[0]?.activity).toBe("running run_commands");

		// A heartbeat says nothing new, so the last real step stays shown.
		runs = applyTeamProgress(
			runs,
			update("run_progress", { message: "heartbeat" }),
			4_000,
		);
		expect(runs[0]?.activity).toBe("running run_commands");

		runs = applyTeamProgress(runs, update("run_completed"), 5_000);
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({
			status: "completed",
			endedAt: 5_000,
			activity: "reply sent to manager",
		});
	});

	it("ignores events that are not about a run", () => {
		const runs = applyTeamProgress(
			[],
			update("team_task_updated", { runId: undefined }),
			1_000,
		);
		expect(runs).toEqual([]);
	});
});

describe("describeRunActivity", () => {
	it("words run activity for a person", () => {
		expect(describeRunActivity("finished_tool_apply_patch")).toBe(
			"finished apply_patch",
		);
		expect(describeRunActivity("iteration_4_started")).toBe("step 4");
		expect(describeRunActivity("finalizing_response")).toBe(
			"writing its reply",
		);
		expect(describeRunActivity("heartbeat")).toBeUndefined();
	});
});
