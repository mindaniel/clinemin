import { createTeamName } from "@cline/core";
import { resolveSystemPrompt } from "../runtime/prompt";
import type { Config } from "./types";

export const MANAGER_COMMAND_USAGE =
	"Usage: /manager <task description>\n" +
	"Runs this session as a manager: it delegates every step to the workers in .cline/team.json and does no work itself.\n" +
	"/manager on its own picks the manager's model; /manager off turns manager mode back off.";

/** Words that mean "turn manager mode off" when they follow `/manager`. */
const MANAGER_OFF_WORDS = new Set(["off", "stop", "exit", "end", "quit"]);

/**
 * Whether `taskBody` (everything after `/manager`) asks to leave manager mode.
 *
 * Only a bare off-word counts. `/manager stop the release script` is a task for
 * the workers, not a request to stop being a manager.
 */
export function isManagerOffRequest(taskBody: string): boolean {
	return MANAGER_OFF_WORDS.has(taskBody.trim().toLowerCase());
}

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

/**
 * Switch a session out of manager mode.
 *
 * Symmetric with `enableManagerForPrompt`: the system prompt is fixed for the
 * life of a session, so this rebuilds it as a plain session's and the caller
 * restarts. The restart discards the conversation, which is why the UI asks
 * before doing it.
 *
 * `enableAgentTeams` is deliberately left on. Turning it off would take the
 * delegation tools away from a session that may have been given them by
 * `/team` before the manager ever started, and a plain session with team tools
 * it does not use costs nothing.
 */
export async function disableManagerForPrompt(config: Config): Promise<void> {
	if (!config.managerMode) {
		return;
	}
	config.managerMode = false;
	config.systemPrompt = await resolveSystemPrompt({
		cwd: config.cwd,
		providerId: config.providerId,
		mode: config.mode,
	});
}
