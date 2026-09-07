import { createTeamName } from "@cline/core";
import { resolveSystemPrompt } from "../runtime/prompt";
import type { Config } from "./types";

export const MANAGER_COMMAND_USAGE =
	"Usage: /manager <task description>\n" +
	"Runs this session as a manager: it delegates every step to the workers in .cline/team.json and does no work itself.";

type ManagerPromptRewriteResult =
	| { kind: "none" }
	| { kind: "usage" }
	| { kind: "rewritten"; prompt: string };

/**
 * Recognise `/manager <task>` and hand back the task on its own.
 *
 * Unlike `/team`, the task is passed through unchanged rather than wrapped in
 * an instruction. The manager prompt has already told the session what it is;
 * repeating "act as a manager for the following" in the first user message
 * just gives it two sets of instructions to reconcile.
 */
export function rewriteManagerPrompt(
	input: string,
): ManagerPromptRewriteResult {
	const match = /^\/manager\b([\s\S]*)$/i.exec(input.trim());
	if (!match) {
		return { kind: "none" };
	}
	const taskBody = (match[1] ?? "").trim();
	if (!taskBody) {
		return { kind: "usage" };
	}
	return { kind: "rewritten", prompt: taskBody };
}

/**
 * Switch a session into manager mode.
 *
 * The manager prompt replaces the system prompt, and a system prompt is fixed
 * for the life of a session — so this rebuilds it and the caller restarts the
 * session. That restart is why `/manager` belongs at the start of a chat: it
 * cannot convert a conversation that is already under way without discarding
 * it.
 */
export async function enableManagerForPrompt(config: Config): Promise<void> {
	if (config.managerMode) {
		return;
	}
	config.managerMode = true;
	// A manager with no delegation tool has nothing to manage with.
	config.enableAgentTeams = true;
	config.teamName = config.teamName?.trim() || createTeamName();
	config.systemPrompt = await resolveSystemPrompt({
		cwd: config.cwd,
		providerId: config.providerId,
		mode: config.mode,
		managerMode: true,
	});
}
