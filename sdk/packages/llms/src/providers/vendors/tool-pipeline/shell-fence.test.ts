import { describe, expect, it } from "vitest";
import {
	extractShellFenceCommands,
	isShellFenceLanguage,
	parseShellFenceFlags,
} from "./shell-fence";

const TOOLS = ["read_files", "run_commands", "editor"];

describe("isShellFenceLanguage", () => {
	it("accepts the shell tags a chat model actually writes", () => {
		for (const lang of ["powershell", "PowerShell", " pwsh ", "bash", "cmd"]) {
			expect(isShellFenceLanguage(lang)).toBe(true);
		}
	});

	it("rejects code languages and the bare fence", () => {
		// An unlabelled fence is how a model quotes output or shows an example.
		for (const lang of ["", undefined, "ts", "python", "json", "diff"]) {
			expect(isShellFenceLanguage(lang)).toBe(false);
		}
	});
});

describe("extractShellFenceCommands", () => {
	it("turns a powershell fence into a run_commands call and removes it", () => {
		const text = [
			"Run this to check:",
			"```powershell",
			"Get-ChildItem -Recurse",
			"```",
		].join("\n");
		const { remainingText, toolUses } = extractShellFenceCommands(text, TOOLS);
		expect(toolUses).toEqual([
			{
				name: "run_commands",
				arguments: { commands: ["Get-ChildItem -Recurse"] },
			},
		]);
		// Removed, so the fence-to-file pass downstream never sees it.
		expect(remainingText).not.toContain("Get-ChildItem");
	});

	it("keeps a multi-line command intact as one command", () => {
		const text = ["```bash", "cd repo", "bun test", "```"].join("\n");
		const { toolUses } = extractShellFenceCommands(text, TOOLS);
		expect(toolUses[0]?.arguments).toEqual({
			commands: ["cd repo\nbun test"],
		});
	});

	it("extracts every shell fence in a reply", () => {
		const text = [
			"```powershell",
			"one",
			"```",
			"then",
			"```pwsh",
			"two",
			"```",
		].join("\n");
		expect(extractShellFenceCommands(text, TOOLS).toolUses).toHaveLength(2);
	});

	it("leaves a code fence alone", () => {
		const text = ["```ts", "export const a = 1;", "```"].join("\n");
		const { remainingText, toolUses } = extractShellFenceCommands(text, TOOLS);
		expect(toolUses).toEqual([]);
		expect(remainingText).toBe(text);
	});

	it("leaves an empty shell fence visible rather than running nothing", () => {
		const text = ["```powershell", "", "```"].join("\n");
		const { remainingText, toolUses } = extractShellFenceCommands(text, TOOLS);
		expect(toolUses).toEqual([]);
		expect(remainingText).toBe(text);
	});

	it("does nothing when the session has no shell tool", () => {
		// Deleting a command we cannot run would leave the model believing it
		// asked for something.
		const text = ["```powershell", "ls", "```"].join("\n");
		const { remainingText, toolUses } = extractShellFenceCommands(text, [
			"read_files",
		]);
		expect(toolUses).toEqual([]);
		expect(remainingText).toBe(text);
	});
});

describe("shell fence flags", () => {
	it("reads -timeout and -echo off the fence line", () => {
		const { toolUses } = extractShellFenceCommands(
			"```powershell -timeout 10m -echo\nbun run build\n```",
			["run_commands"],
		);
		expect(toolUses[0]?.arguments).toEqual({
			commands: ["bun run build"],
			timeout_seconds: 600,
			echo: true,
		});
	});

	it("adds nothing when no flags are written", () => {
		const { toolUses } = extractShellFenceCommands(
			"```powershell\nGet-ChildItem\n```",
			["run_commands"],
		);
		expect(toolUses[0]?.arguments).toEqual({ commands: ["Get-ChildItem"] });
	});

	it("parses flag forms", () => {
		expect(parseShellFenceFlags(" -timeout 90")).toEqual({
			timeout_seconds: 90,
		});
		expect(parseShellFenceFlags(" --timeout=2h")).toEqual({
			timeout_seconds: 7200,
		});
		expect(parseShellFenceFlags(" -echo")).toEqual({ echo: true });
		expect(parseShellFenceFlags(" -echoes")).toEqual({});
	});
});
