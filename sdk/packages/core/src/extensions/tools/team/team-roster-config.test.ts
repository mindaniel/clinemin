import type { TeamRoster, TeamTeammateSpec } from "@cline/shared";
import { parseTeamRoster } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { mergeRosterIntoTeammateSpecs } from "./team-roster-config";

function roster(workers: TeamRoster["workers"]): TeamRoster {
	return { version: 1, workers };
}

describe("parseTeamRoster", () => {
	it("accepts a roster that pins a provider per worker", () => {
		const result = parseTeamRoster(
			JSON.stringify({
				version: 1,
				teamName: "annual-reports",
				workers: [
					{
						agentId: "extractor",
						rolePrompt: "Pull figures out of annual reports.",
						providerId: "deepseek-web-v2",
					},
					{ agentId: "checker", rolePrompt: "Verify figures." },
				],
			}),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.roster.workers[0]?.providerId).toBe("deepseek-web-v2");
		// An omitted provider stays omitted rather than being defaulted here; the
		// spawn path is what falls back to the lead's connection.
		expect(result.roster.workers[1]?.providerId).toBeUndefined();
	});

	it("rejects an unknown key instead of ignoring it", () => {
		// A typo like `provider` for `providerId` would otherwise be dropped in
		// silence and the worker would quietly run on the lead's provider.
		const result = parseTeamRoster(
			JSON.stringify({
				version: 1,
				workers: [
					{ agentId: "a", rolePrompt: "x", provider: "deepseek-web-v2" },
				],
			}),
		);

		expect(result.ok).toBe(false);
	});

	it("rejects duplicate agentIds", () => {
		const result = parseTeamRoster(
			JSON.stringify({
				version: 1,
				workers: [
					{ agentId: "a", rolePrompt: "x" },
					{ agentId: "a", rolePrompt: "y" },
				],
			}),
		);

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error).toContain("Duplicate agentId");
	});

	it("reports malformed JSON as a file problem", () => {
		const result = parseTeamRoster("{ not json");

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error).toContain("team.json");
	});
});

describe("mergeRosterIntoTeammateSpecs", () => {
	it("adds roster workers that persistence does not know about", () => {
		const merged = mergeRosterIntoTeammateSpecs(
			[],
			roster([
				{
					agentId: "extractor",
					rolePrompt: "Pull figures.",
					providerId: "deepseek-web-v2",
					modelId: "deepseek-chat",
				},
			]),
		);

		expect(merged).toEqual([
			{
				agentId: "extractor",
				rolePrompt: "Pull figures.",
				providerId: "deepseek-web-v2",
				modelId: "deepseek-chat",
				maxIterations: undefined,
			},
		]);
	});

	it("keeps the persisted spec when both define the same worker", () => {
		// The persisted worker carries live conversation state. Letting the file
		// re-point its provider mid-job would strand that history.
		const persisted: TeamTeammateSpec = {
			agentId: "extractor",
			rolePrompt: "Persisted prompt.",
			providerId: "qwen-web",
		};

		const merged = mergeRosterIntoTeammateSpecs(
			[persisted],
			roster([
				{
					agentId: "extractor",
					rolePrompt: "Roster prompt.",
					providerId: "deepseek-web-v2",
				},
			]),
		);

		expect(merged).toEqual([persisted]);
	});

	it("returns the restored specs unchanged when there is no roster", () => {
		const persisted: TeamTeammateSpec = { agentId: "a", rolePrompt: "x" };

		expect(mergeRosterIntoTeammateSpecs([persisted], undefined)).toEqual([
			persisted,
		]);
	});
});
