import { describe, expect, it } from "vitest";
import { buildClineSystemPrompt, TOOL_CALL_PROTOCOL_RULES } from "./cline";
import {
	buildGuideAiReminder,
	detectGuideAiStyle,
	expandGuideAiPrompt,
	parseGuideAiCommand,
} from "./guide";
import { SIMPLE_WEB_SYSTEM_PROMPT } from "./simple-web";

describe("parseGuideAiCommand", () => {
	it("leaves anything that is not the command alone", () => {
		expect(parseGuideAiCommand("fix the build")).toBeUndefined();
		expect(parseGuideAiCommand("/guide-aid something")).toBeUndefined();
		expect(parseGuideAiCommand("see /guide-ai later")).toBeUndefined();
	});

	it("takes the whole tail as the message when no style is named", () => {
		expect(parseGuideAiCommand("/guide-ai fix the build")).toEqual({
			message: "fix the build",
		});
	});

	it("accepts a style word, by name or by option number", () => {
		expect(parseGuideAiCommand("/guide-ai patch fix it")).toEqual({
			style: "patch",
			message: "fix it",
		});
		expect(parseGuideAiCommand("/guide-ai 2 fix it")).toEqual({
			style: "tools",
			message: "fix it",
		});
	});

	it("keeps a bare style word as the message, not as a style", () => {
		// "/guide-ai tools" almost certainly means "remind them about the tools",
		// and both readings produce the same reminder anyway.
		expect(parseGuideAiCommand("/guide-ai tools")).toEqual({
			message: "tools",
		});
	});

	it("does not eat a first word that only looks like a style", () => {
		expect(parseGuideAiCommand("/guide-ai patching is broken")).toEqual({
			message: "patching is broken",
		});
	});
});

describe("detectGuideAiStyle", () => {
	it("reads the patch contract off a simple web prompt", () => {
		expect(detectGuideAiStyle(SIMPLE_WEB_SYSTEM_PROMPT)).toBe("patch");
	});

	it("reads the tool contract off the web-provider prompt", () => {
		const prompt = buildClineSystemPrompt({
			providerId: "claude-web",
			workspaceRoot: "/repo",
		});
		expect(detectGuideAiStyle(prompt)).toBe("tools");
	});

	it("prefers the tool contract when a session documents both", () => {
		// A session routed to `apply_patch` gets the patch grammar *inside* its
		// tool list. It is still a <tool>-calling session.
		const prompt = buildClineSystemPrompt({
			providerId: "claude-web",
			workspaceRoot: "/repo",
			tools: ["read_files", "apply_patch"],
		});
		expect(prompt).toContain("*** Begin Patch");
		expect(detectGuideAiStyle(prompt)).toBe("tools");
	});
});

describe("buildGuideAiReminder", () => {
	it("restates the PowerShell and patch rules verbatim", () => {
		const reminder = buildGuideAiReminder({ style: "patch" });
		expect(reminder).toContain(SIMPLE_WEB_SYSTEM_PROMPT);
		expect(reminder).not.toContain("<tool>");
	});

	it("restates the tool contract and the session's own tool list", () => {
		const reminder = buildGuideAiReminder({ style: "tools" });
		expect(reminder).toContain(TOOL_CALL_PROTOCOL_RULES);
		for (const name of [
			"read_files",
			"search_codebase",
			"run_commands",
			"editor",
		]) {
			expect(reminder).toContain(name);
		}
	});

	it("never advertises a tool the session does not have", () => {
		const reminder = buildGuideAiReminder({
			style: "tools",
			tools: ["read_files", "search_codebase"],
		});
		expect(reminder).toContain("read_files");
		expect(reminder).not.toContain("**editor**");
		expect(reminder).not.toContain("**run_commands**");
	});
});

describe("expandGuideAiPrompt", () => {
	it("passes an ordinary prompt straight through", () => {
		expect(
			expandGuideAiPrompt({ input: "fix the build", systemPrompt: "whatever" }),
		).toBe("fix the build");
	});

	it("puts the reminder first and the request last", () => {
		const expanded = expandGuideAiPrompt({
			input: "/guide-ai fix the build",
			systemPrompt: SIMPLE_WEB_SYSTEM_PROMPT,
		});
		expect(expanded.startsWith("Reminder —")).toBe(true);
		expect(expanded.endsWith("fix the build")).toBe(true);
		expect(expanded).toContain("*** Begin Patch");
	});

	it("honours an explicit style over what the session is running", () => {
		const expanded = expandGuideAiPrompt({
			input: "/guide-ai tools fix the build",
			systemPrompt: SIMPLE_WEB_SYSTEM_PROMPT,
		});
		expect(expanded).toContain("<tool>");
		expect(expanded).toContain("fix the build");
	});

	it("sends the reminder alone when there is no message", () => {
		const expanded = expandGuideAiPrompt({
			input: "/guide-ai",
			systemPrompt: SIMPLE_WEB_SYSTEM_PROMPT,
		});
		expect(expanded).toBe(buildGuideAiReminder({ style: "patch" }));
	});
});
