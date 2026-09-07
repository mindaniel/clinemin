import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseManagerBlocks, scanManagerBlocks } from "./manager-block";

/** The sign-off, read from the prompt that actually teaches it. */
const MANAGER_DONE_TOKEN = "TEAM DONE";

const REAL_REPLY = `We are starting the process to remove all references to "kanban" from your repository. First, we need to locate every instance of it across the codebase.

<manager>
TO: extractor
Goal: Find every file and line in the repository that contains the word "kanban" (case-insensitive).
Output: A complete list of file paths and the specific lines (with line numbers).
</manager>`;

describe("scanManagerBlocks", () => {
	it("reads the addressee and message out of a real manager reply", () => {
		const blocks = scanManagerBlocks(REAL_REPLY);

		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.agentId).toBe("extractor");
		expect(blocks[0]?.task).toContain("Goal: Find every file");
		expect(blocks[0]?.task).not.toContain("TO: extractor");
		expect(blocks[0]?.unterminated).toBe(false);
	});

	it("ends the block at a closing line, not at an inline mention of the tag", () => {
		// A manager explaining its own format writes the closing tag inside a
		// message. Stopping at the first occurrence anywhere would truncate the
		// block and leak the rest of the reply as prose.
		const text = [
			"<manager>",
			"TO: extractor",
			"Always finish the block by writing </manager> on its own line.",
			"That is the rule.",
			"</manager>",
		].join("\n");

		const blocks = scanManagerBlocks(text);

		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.task).toContain("</manager> on its own line");
		expect(blocks[0]?.task).toContain("That is the rule.");
		expect(blocks[0]?.unterminated).toBe(false);
	});

	it("keeps adjacent blocks separate", () => {
		const text = [
			"<manager>",
			"TO: extractor",
			"First job.",
			"</manager>",
			"",
			"<manager>",
			"TO: checker",
			"Second job.",
			"</manager>",
		].join("\n");

		const blocks = scanManagerBlocks(text);

		expect(blocks.map((block) => block.agentId)).toEqual([
			"extractor",
			"checker",
		]);
		expect(blocks[1]?.task).toBe("Second job.");
	});

	it("does not open a second block from a <manager> inside a body", () => {
		const text = [
			"<manager>",
			"TO: extractor",
			"Write <manager> when you want to reach me.",
			"</manager>",
		].join("\n");

		expect(scanManagerBlocks(text)).toHaveLength(1);
	});

	it("marks a block with no closing line as unterminated", () => {
		const text = ["<manager>", "TO: extractor", "Do the thing."].join("\n");

		const blocks = scanManagerBlocks(text);

		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.unterminated).toBe(true);
	});
});

describe("parseManagerBlocks", () => {
	it("turns a block into a sync team_run_task delegation", () => {
		const { delegations, cleanedContent, problems } =
			parseManagerBlocks(REAL_REPLY);

		expect(problems).toEqual([]);
		expect(delegations).toHaveLength(1);
		expect(delegations[0]?.name).toBe("team_run_task");
		expect(delegations[0]?.arguments.agentId).toBe("extractor");
		expect(delegations[0]?.arguments.runMode).toBe("sync");
		// The manager's commentary to the operator survives; the block does not,
		// so the transcript does not show the same instruction twice.
		expect(cleanedContent).toContain("We are starting the process");
		expect(cleanedContent).not.toContain("TO: extractor");
	});

	it("dispatches one delegation per worker", () => {
		const text = [
			"Kicking both off.",
			"<manager>",
			"TO: extractor",
			"Find them.",
			"</manager>",
			"<manager>",
			"TO: checker",
			"Verify them.",
			"</manager>",
		].join("\n");

		const { delegations } = parseManagerBlocks(text);

		expect(delegations.map((d) => d.arguments.agentId)).toEqual([
			"extractor",
			"checker",
		]);
	});

	it("reports a block with no TO line instead of guessing a worker", () => {
		const text = ["<manager>", "Do something.", "</manager>"].join("\n");

		const { delegations, problems } = parseManagerBlocks(text);

		expect(delegations).toEqual([]);
		expect(problems[0]).toContain("TO:");
	});

	it("reports an unterminated block rather than dispatching a truncated one", () => {
		const text = ["<manager>", "TO: extractor", "Half a thought"].join("\n");

		const { delegations, problems } = parseManagerBlocks(text);

		expect(delegations).toEqual([]);
		expect(problems[0]).toContain("never closed");
	});

	it("leaves a reply with no blocks untouched", () => {
		const { cleanedContent, delegations } = parseManagerBlocks("Just prose.");

		expect(cleanedContent).toBe("Just prose.");
		expect(delegations).toEqual([]);
	});
});

describe("manager blocks", () => {
	it("does not spawn when PROVIDER or ROLE are ignored", () => {
		const parsed = parseManagerBlocks(
			[
				"<manager>",
				"TO: reader",
				"PROVIDER: deepseek-web-v2",
				"ROLE: Reads long documents and pulls out numbers.",
				"Open report-2024.pdf and list every revenue figure.",
				"</manager>",
			].join("\n"),
		);

		expect(parsed.problems).toEqual([]);
		expect(parsed.delegations).toEqual([
			{
				name: "team_run_task",
				arguments: {
					agentId: "reader",
					task: "PROVIDER: deepseek-web-v2\nROLE: Reads long documents and pulls out numbers.\nOpen report-2024.pdf and list every revenue figure.",
					runMode: "sync",
					continueConversation: true,
				},
			},
		]);
	});

	it("does not spawn when only TO is given", () => {
		const parsed = parseManagerBlocks(
			["<manager>", "TO: reader", "Next page please.", "</manager>"].join("\n"),
		);

		expect(parsed.delegations.map((d) => d.name)).toEqual(["team_run_task"]);
		expect(
			parsed.delegations[0]?.name === "team_run_task"
				? parsed.delegations[0].arguments.continueConversation
				: null,
		).toBe(true);
	});

	it("keeps a body line that merely looks like a header", () => {
		const parsed = parseManagerBlocks(
			[
				"<manager>",
				"TO: reader",
				"Note: skip the appendix.",
				"</manager>",
			].join("\n"),
		);

		const run = parsed.delegations[0];
		expect(run?.name === "team_run_task" ? run.arguments.task : "").toBe(
			"Note: skip the appendix.",
		);
	});

	it("takes only the first word of a TO line as the worker id", () => {
		const parsed = parseManagerBlocks(
			["<manager>", "TO: reader please", "Go.", "</manager>"].join("\n"),
		);

		const run = parsed.delegations[0];
		expect(run?.arguments.agentId).toBe("reader");
	});
});

describe("worker conversation continuity", () => {
	it("continues the conversation on a follow-up", () => {
		const parsed = parseManagerBlocks(
			[
				"<manager>",
				"TO: extractor",
				"That was not a line count.",
				"</manager>",
			].join("\n"),
		);

		const run = parsed.delegations[0];
		expect(run?.name).toBe("team_run_task");
		expect(
			run?.name === "team_run_task" ? run.arguments.continueConversation : null,
		).toBe(true);
	});
});

describe("a manager reply with no block", () => {
	it("is left alone", () => {
		// This layer cannot tell a manager from an ordinary agent — every
		// team-enabled session has `team_run_task` — so nudging a block-less
		// reply told normal agents to send <manager> blocks.
		const parsed = parseManagerBlocks(
			"manager.ts has 131 lines, confirmed by the command extractor ran.",
		);

		expect(parsed.problems).toEqual([]);
		expect(parsed.delegations).toEqual([]);
		expect(parsed.cleanedContent).toContain("131 lines");
	});
});

describe("TOOLS: capability grants", () => {
	it("carries a grant onto the dispatch", () => {
		const parsed = parseManagerBlocks(
			[
				"<manager>",
				"TO: extractor",
				"TOOLS: read_files, search_codebase",
				"Find every line containing kanban.",
				"</manager>",
			].join("\n"),
		);

		const run = parsed.delegations[0];
		expect(
			run?.name === "team_run_task" ? run.arguments.tools : undefined,
		).toEqual(["read_files", "search_codebase"]);
	});

	it("accepts a bracketed or space-separated list", () => {
		const parsed = parseManagerBlocks(
			[
				"<manager>",
				"TO: e",
				"TOOLS: [read_files editor]",
				"Go.",
				"</manager>",
			].join("\n"),
		);

		const run = parsed.delegations[0];
		expect(
			run?.name === "team_run_task" ? run.arguments.tools : undefined,
		).toEqual(["read_files", "editor"]);
	});

	it("treats TOOLS: none as a real grant of nothing", () => {
		const parsed = parseManagerBlocks(
			["<manager>", "TO: e", "TOOLS: none", "Just tell me.", "</manager>"].join(
				"\n",
			),
		);

		const run = parsed.delegations[0];
		expect(
			run?.name === "team_run_task" ? run.arguments.tools : undefined,
		).toEqual([]);
	});

	it("leaves the scope alone when no TOOLS: line is given", () => {
		const parsed = parseManagerBlocks(
			["<manager>", "TO: e", "Carry on.", "</manager>"].join("\n"),
		);

		const run = parsed.delegations[0];
		expect(
			run?.name === "team_run_task" ? run.arguments.tools : "absent",
		).toBeUndefined();
	});

	it("includes tools on the task when TOOLS is provided", () => {
		const parsed = parseManagerBlocks(
			[
				"<manager>",
				"TO: reader",
				"TOOLS: read_files",
				"Read it.",
				"</manager>",
			].join("\n"),
		);

		const run = parsed.delegations[0];
		expect(
			run?.name === "team_run_task" ? run.arguments.tools : undefined,
		).toEqual(["read_files"]);
	});
});

describe("PowerShell fences", () => {
	it("turns one into a run_commands call", () => {
		const parsed = parseManagerBlocks(
			[
				"Let me check that claim.",
				"```powershell",
				"Get-ChildItem apps/cli/src/commands/kanban.ts",
				"```",
			].join("\n"),
			{ allowCommands: true },
		);

		expect(parsed.delegations).toEqual([
			{
				name: "run_commands",
				arguments: {
					commands: ["Get-ChildItem apps/cli/src/commands/kanban.ts"],
				},
			},
		]);
		expect(parsed.cleanedContent).toBe("Let me check that claim.");
	});

	it("accepts the same fence tags claude-web runs", () => {
		for (const tag of ["pwsh", "ps1", "bash", "shell", "sh", "cmd"]) {
			const parsed = parseManagerBlocks(
				["```" + tag, "Get-Location", "```"].join("\n"),
				{ allowCommands: true },
			);
			expect(parsed.delegations.map((d) => d.name)).toEqual(["run_commands"]);
		}
	});

	it("accepts attributes after the language tag", () => {
		// ChatGPT stamps its code blocks with an id: ```powershell id="r73a1".
		// Requiring the tag to end the line made every one of those fences look
		// untagged, so the command was dropped as prose with no feedback.
		const parsed = parseManagerBlocks(
			['```powershell id="r73a1"', "Get-Content $file", "```"].join("\n"),
			{ allowCommands: true },
		);
		expect(parsed.delegations.map((d) => d.name)).toEqual(["run_commands"]);
	});

	it("leaves an untagged fence alone, because that is how output is quoted", () => {
		const text = ["```", "Get-ChildItem .", "```"].join("\n");
		const parsed = parseManagerBlocks(text, { allowCommands: true });

		expect(parsed.delegations).toEqual([]);
		expect(parsed.cleanedContent).toContain("Get-ChildItem .");
	});

	it("is ignored when the session has no shell tool", () => {
		const text = ["```powershell", "Get-ChildItem .", "```"].join("\n");

		expect(parseManagerBlocks(text).delegations).toEqual([]);
		// Left in the reply rather than silently swallowed.
		expect(parseManagerBlocks(text).cleanedContent).toContain("```powershell");
	});

	it("runs a check and a delegation from the same reply", () => {
		const parsed = parseManagerBlocks(
			[
				"```powershell",
				"git status --short",
				"```",
				"<manager>",
				"TO: extractor",
				"Report what changed.",
				"</manager>",
			].join("\n"),
			{ allowCommands: true },
		);

		expect(parsed.delegations.map((d) => d.name)).toEqual([
			"run_commands",
			"team_run_task",
		]);
	});

	it("does not mistake a command mentioning manager for a delegation", () => {
		const parsed = parseManagerBlocks(
			[
				"```powershell",
				'Select-String -Pattern "<manager>" -Path notes.md',
				"```",
			].join("\n"),
			{ allowCommands: true },
		);

		expect(parsed.delegations.map((d) => d.name)).toEqual(["run_commands"]);
	});

	it("reports an unclosed fence instead of running it", () => {
		const parsed = parseManagerBlocks(
			["```powershell", "rm -rf /"].join("\n"),
			{
				allowCommands: true,
			},
		);

		expect(parsed.delegations).toEqual([]);
		expect(parsed.problems[0]).toContain("never closed");
	});
});

describe("untagged shell fences", () => {
	const untagged = [
		"Run this and paste the output:",
		"",
		"```",
		"Get-ChildItem -Path .sdk -Recurse -File",
		"```",
	].join("\n");

	it("asks for the language tag instead of running it", () => {
		const parsed = parseManagerBlocks(untagged, { allowCommands: true });

		// The command must NOT run: an untagged fence is quoted text by design.
		expect(parsed.delegations).toEqual([]);
		expect(parsed.problems).toHaveLength(1);
		expect(parsed.problems[0]).toContain("no language tag");
	});

	it("looks past a leading empty fence to the command below it", () => {
		// ChatGPT's habitual reply shape: an empty ``` pair, then the real
		// command in a second untagged fence. Checking only the first fence made
		// the empty body win and dropped the command with no feedback.
		const twoFences = [
			"Run this one command:",
			"",
			"```",
			"```",
			"",
			"```",
			"Select-String -Path .\\deepseek-web.ts -Pattern 'messagesToPrompt'",
			"```",
		].join("\n");
		const parsed = parseManagerBlocks(twoFences, { allowCommands: true });

		expect(parsed.delegations).toEqual([]);
		expect(parsed.problems).toHaveLength(1);
		expect(parsed.problems[0]).toContain("no language tag");
	});

	it("stays quiet when the session cannot run commands anyway", () => {
		const parsed = parseManagerBlocks(untagged, {});

		expect(parsed.problems).toEqual([]);
	});

	it("leaves quoted output alone", () => {
		// A model pasting a worker's reply back is the case the untagged fence
		// exists for; nudging there would fire on almost every manager turn.
		const quoted = [
			"deepseek reported:",
			"",
			"```",
			"The file has 240 lines and no kanban references.",
			"```",
		].join("\n");

		expect(
			parseManagerBlocks(quoted, { allowCommands: true }).problems,
		).toEqual([]);
	});

	it("says nothing when a tagged fence already ran", () => {
		const mixed = [
			"```powershell",
			"Get-Content foo.ts -TotalCount 5",
			"```",
			"",
			"```",
			"Get-ChildItem",
			"```",
		].join("\n");
		const parsed = parseManagerBlocks(mixed, { allowCommands: true });

		expect(parsed.delegations).toHaveLength(1);
		expect(parsed.problems).toEqual([]);
	});

	it("does not nudge a manager that is signing off", () => {
		const done = [
			"Here is what they found:",
			"",
			"```",
			"Get-ChildItem returned 12 files",
			"```",
			"",
			MANAGER_DONE_TOKEN,
		].join("\n");

		expect(parseManagerBlocks(done, { allowCommands: true }).problems).toEqual(
			[],
		);
	});
});

describe("DONE_TOKEN", () => {
	it("matches the sign-off the manager prompt asks for", () => {
		// manager-block.ts keeps its own copy so it does not import @cline/shared
		// for one string. Read the real declaration back so they cannot drift.
		const source = fs.readFileSync(
			path.join(
				path.dirname(fileURLToPath(import.meta.url)),
				"..",
				"..",
				"..",
				"..",
				"..",
				"shared",
				"src",
				"prompt",
				"manager.ts",
			),
			"utf-8",
		);
		const match = /export const MANAGER_DONE_TOKEN = "([^"]+)";/.exec(source);

		expect(match?.[1]).toBe(MANAGER_DONE_TOKEN);
	});
});

describe("untagged fences alongside a patch", () => {
	it("stays quiet so the patch parser gets the reply", () => {
		// The patch parser runs AFTER this one. Returning a problem here ends the
		// turn with a retry prompt and the edit is never applied — and a model
		// that sends a patch plus a verification command in a bare fence is doing
		// the normal thing.
		const reply = [
			"Apply this patch:",
			"",
			"*** Begin Patch",
			"*** Update File: apps/cli/src/foo.ts",
			"@@ export function foo",
			" const a = 1;",
			"-const b = 2;",
			"+const b = 3;",
			"*** End Patch",
			"",
			"Then verify:",
			"",
			"```",
			"Get-Content .appsclisrc\foo.ts",
			"```",
		].join("\n");

		const parsed = parseManagerBlocks(reply, { allowCommands: true });

		expect(parsed.problems).toEqual([]);
		expect(parsed.cleanedContent).toContain("*** Begin Patch");
	});
});
