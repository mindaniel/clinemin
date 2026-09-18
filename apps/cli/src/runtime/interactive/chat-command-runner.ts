import type { InteractiveTurnResult } from "../../tui/types";
import type { ChatCommandHost } from "../../utils/chat-commands";
import {
	type ChatCommandState,
	maybeHandleChatCommand,
} from "../../utils/chat-commands";
import {
	enableManagerForPrompt,
	isManagerOffRequest,
	MANAGER_COMMAND_USAGE,
	rewriteManagerPrompt,
} from "../../utils/manager-command";
import {
	enableTeamsForPrompt,
	rewriteTeamPrompt,
	TEAM_COMMAND_USAGE,
} from "../../utils/team-command";
import type { Config } from "../../utils/types";
import type { createInteractiveSessionRuntime } from "./session-runtime";

type AutoApproveRef = {
	current: boolean;
};

export type InteractiveChatCommandRuntime = Pick<
	ReturnType<typeof createInteractiveSessionRuntime>,
	| "forkCurrentSession"
	| "getActiveSessionId"
	| "resetForNewSession"
	| "restartEmpty"
>;

export type InteractiveChatCommandResult =
	| { handled: true; turnResult: InteractiveTurnResult }
	| { handled: false; input: string; commandOutput?: string };

function commandTurnResult(commandOutput?: string): InteractiveTurnResult {
	return {
		usage: { inputTokens: 0, outputTokens: 0 },
		iterations: 0,
		commandOutput,
	};
}

export async function runInteractiveChatCommand(input: {
	prompt: string;
	enabled: boolean;
	config: Config;
	host: ChatCommandHost;
	chatCommandState: ChatCommandState;
	autoApproveAllRef: AutoApproveRef;
	setInteractiveAutoApprove: (enabled: boolean) => void;
	sessionRuntime: InteractiveChatCommandRuntime;
	stop: () => void;
	onCommandOutput?: (text: string) => void;
}): Promise<InteractiveChatCommandResult> {
	let prompt = input.prompt;
	const rewrittenManagerPrompt = rewriteManagerPrompt(prompt);
	if (rewrittenManagerPrompt.kind !== "none") {
		if (rewrittenManagerPrompt.kind === "usage") {
			return {
				handled: true,
				turnResult: commandTurnResult(MANAGER_COMMAND_USAGE),
			};
		}
		if (isManagerOffRequest(rewrittenManagerPrompt.prompt)) {
			// `/manager off` is handled by the TUI, which can ask before throwing
			// the conversation away. Reaching here means a non-interactive caller
			// typed it, and enabling manager mode with "off" as the task would be
			// the exact opposite of what was asked.
			return {
				handled: true,
				turnResult: commandTurnResult(
					input.config.managerMode
						? "Manager mode stays on: /manager off needs the interactive TUI, which can confirm the session restart first."
						: "Manager mode is already off.",
				),
			};
		}
		if (!input.config.managerMode) {
			// The manager prompt replaces the system prompt, which is fixed once a
			// session starts — so switching into manager mode restarts it. Anything
			// already said in this chat is discarded, which is why this belongs on
			// the first message.
			await enableManagerForPrompt(input.config);
			await input.sessionRuntime.restartEmpty();
		}
		prompt = rewrittenManagerPrompt.prompt;
	}
	const rewrittenTeamPrompt = rewriteTeamPrompt(prompt);
	if (rewrittenTeamPrompt.kind !== "none") {
		if (rewrittenTeamPrompt.kind === "usage") {
			return {
				handled: true,
				turnResult: commandTurnResult(TEAM_COMMAND_USAGE),
			};
		}
		if (!input.config.enableAgentTeams) {
			await enableTeamsForPrompt(input.config);
			await input.sessionRuntime.restartEmpty();
		}
		prompt = rewrittenTeamPrompt.prompt;
	}

	let commandOutput: string | undefined;
	let submitPrompt: string | undefined;
	const handled = await maybeHandleChatCommand(prompt, {
		enabled: input.enabled,
		host: input.host,
		getState: () => ({
			...input.chatCommandState,
			autoApproveTools: input.autoApproveAllRef.current,
		}),
		setState: async (next) => {
			input.chatCommandState.enableTools = next.enableTools;
			input.chatCommandState.autoApproveTools = next.autoApproveTools;
			input.chatCommandState.cwd = next.cwd;
			input.chatCommandState.workspaceRoot = next.workspaceRoot;
			input.setInteractiveAutoApprove(next.autoApproveTools);
		},
		reply: async (text) => {
			commandOutput = text;
			input.onCommandOutput?.(text);
		},
		submitPrompt: async (text) => {
			const trimmed = text.trim();
			if (trimmed) {
				submitPrompt = trimmed;
			}
		},
		reset: async () => {
			await input.sessionRuntime.resetForNewSession();
		},
		stop: async () => {
			input.stop();
		},
		describe: () =>
			[
				`sessionId=${input.sessionRuntime.getActiveSessionId()}`,
				`tools=${input.chatCommandState.enableTools ? "on" : "off"}`,
				`yolo=${input.autoApproveAllRef.current ? "on" : "off"}`,
				`cwd=${input.chatCommandState.cwd}`,
				`workspaceRoot=${input.chatCommandState.workspaceRoot}`,
			].join("\n"),
		fork: input.sessionRuntime.forkCurrentSession,
	});
	if (handled) {
		if (submitPrompt) {
			return {
				handled: false,
				input: submitPrompt,
				...(commandOutput ? { commandOutput } : {}),
			};
		}
		return {
			handled: true,
			turnResult: commandTurnResult(commandOutput),
		};
	}
	return { handled: false, input: prompt };
}
