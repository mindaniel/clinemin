import {
	type DeepSeekWebV2ChatEntry,
	listDeepSeekWebV2Chats,
	openDeepSeekWebV2Chat,
} from "@cline/llms";
import { useTerminalDimensions } from "@opentui/react";
import type { ChoiceContext } from "@opentui-ui/dialog";
import { useDialog } from "@opentui-ui/dialog/react";
import { useCallback } from "react";
import type { SlashCommandRegistry } from "../commands/slash-command-registry";
import { resolveSlashCommand } from "../commands/slash-command-registry";
import { FindChatDialogContent } from "../components/dialogs/find-chat-dialog";
import { ForkConfirmContent } from "../components/dialogs/fork-confirm";
import { HelpDialogContent } from "../components/dialogs/help-dialog";
import { withLoadingDialog } from "../components/dialogs/loading-dialog";
import { useSession } from "../contexts/session-context";
import type { AppView, TuiProps } from "../types";
import { formatTokenCount } from "../utils/compaction-status";
import { hydrateSessionMessages } from "../utils/hydrate-messages";
import type { LocalSlashCommandInvocation } from "../utils/skill-command-input";
import { HistoryDialogContent } from "../views/history-view";
import { runLocalSlashCommandAction } from "./local-command-actions";
import type { OpenConfigOptions } from "./use-config-panel";

export function useLocalCommandActions(input: {
	slashCommandRegistry: SlashCommandRegistry;
	canForkSession: boolean;
	openAccount: () => void;
	openConfig: (options?: OpenConfigOptions) => void;
	openMcpManager: () => Promise<boolean>;
	openModelSelector: () => void;
	openSkills: (invocation?: LocalSlashCommandInvocation) => void;
	refocusTextarea: () => void;
	setAppView: (view: AppView) => void;
	onClearConversation: () => Promise<void>;
	onResumeSession: TuiProps["onResumeSession"];
	onExportHistorySession: TuiProps["onExportHistorySession"];
	onDeleteHistorySession: TuiProps["onDeleteHistorySession"];
	onCompact: TuiProps["onCompact"];
	onAutocompact: (tokens: number) => Promise<void>;
	onFork: TuiProps["onFork"];
	onUndo: () => Promise<void>;
	onExit: TuiProps["onExit"];
}) {
	const dialog = useDialog();
	const session = useSession();
	const { height: termHeight } = useTerminalDimensions();
	const {
		slashCommandRegistry,
		canForkSession,
		openAccount,
		openConfig,
		openMcpManager,
		openModelSelector,
		openSkills,
		refocusTextarea,
		setAppView,
		onClearConversation,
		onResumeSession,
		onExportHistorySession,
		onDeleteHistorySession,
		onCompact,
		onAutocompact,
		onFork,
		onUndo,
		onExit,
	} = input;

	const openHistory = useCallback(async () => {
		const sessionId = await dialog.choice<string>({
			size: "large",
			style: { maxHeight: termHeight - 2 },
			content: (ctx: ChoiceContext<string>) => (
				<HistoryDialogContent
					{...ctx}
					onExport={onExportHistorySession}
					onDelete={onDeleteHistorySession}
				/>
			),
		});
		if (sessionId) {
			try {
				await withLoadingDialog(dialog, "Loading session...", async () => {
					const result = await onResumeSession(sessionId);
					const { messages } = result;
					const entries = hydrateSessionMessages(messages);
					if (entries.length === 0) {
						session.appendEntry({
							kind: "error",
							text: `Session ${sessionId} has no messages to resume.`,
						});
					} else {
						session.clearEntries();
						// replaceEntries rather than appendEntry: appendEntry
						// stamps unstamped entries with the CURRENT mode, which
						// would lock hydrated history to the resume-time accent.
						session.replaceEntries(entries);
						if (typeof result.currentContextSize === "number") {
							session.setLastTotalTokens(result.currentContextSize);
						}
						if (typeof result.totalCost === "number") {
							session.setLastTotalCost(result.totalCost);
						}
						session.setHasSubmitted(true);
						setAppView("chat");
					}
				});
			} catch (error) {
				session.appendEntry({
					kind: "error",
					text: `Failed to resume session: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}
		refocusTextarea();
	}, [
		dialog,
		onDeleteHistorySession,
		onExportHistorySession,
		onResumeSession,
		refocusTextarea,
		session,
		setAppView,
		termHeight,
	]);

	const openHelp = useCallback(async () => {
		await dialog.choice<void>({
			size: "large",
			style: { maxHeight: termHeight - 2 },
			content: (ctx: ChoiceContext<void>) => <HelpDialogContent {...ctx} />,
		});
		refocusTextarea();
	}, [dialog, refocusTextarea, termHeight]);

	const runCompact = useCallback(async () => {
		session.setIsRunning(true);
		session.appendEntry({
			kind: "compaction",
			compactionMode: "manual",
			status: "started",
		});
		try {
			const result = await onCompact();
			session.updateLastEntry((entry) =>
				entry.kind === "compaction" && entry.status === "started"
					? {
							...entry,
							status: result.compacted ? "completed" : "skipped",
							messagesBefore: result.messagesBefore,
							messagesAfter:
								result.workingContextMessagesAfter ?? result.messagesAfter,
							...(result.summary ? { summary: result.summary } : {}),
						}
					: entry,
			);
		} catch (error) {
			const cancelled =
				error instanceof Error &&
				(error.name === "AbortError" || /abort/i.test(error.message));
			session.updateLastEntry((entry) =>
				entry.kind === "compaction" && entry.status === "started"
					? { ...entry, status: cancelled ? "cancelled" : "failed" }
					: entry,
			);
			if (!cancelled) {
				session.appendEntry({
					kind: "error",
					text: `Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		} finally {
			session.setIsRunning(false);
		}
	}, [onCompact, session]);

	const runAutocompact = useCallback(
		async (tokens: number | undefined): Promise<boolean> => {
			if (tokens === undefined) {
				session.appendEntry({
					kind: "status",
					text: "Usage: /autocompact <tokens> — e.g. /autocompact 1M sets the auto-compaction context limit to 1M tokens.",
				});
				return false;
			}
			if (session.isRunning) {
				session.appendEntry({
					kind: "status",
					text: "The auto-compaction context limit cannot change while a turn is running. Wait for it to finish and try again.",
				});
				return false;
			}
			const label = formatTokenCount(tokens);
			session.appendEntry({
				kind: "status",
				text: `Setting auto-compaction context limit to ${label} tokens...`,
			});
			try {
				await onAutocompact(tokens);
				session.updateLastEntry((entry) =>
					entry.kind === "status"
						? {
								...entry,
								text: `Auto-compaction context limit set to ${label} tokens. The session will restart to apply it.`,
							}
						: entry,
				);
				return true;
			} catch (error) {
				session.updateLastEntry((entry) =>
					entry.kind === "status"
						? {
								...entry,
								kind: "error",
								text: `Failed to set auto-compaction context limit: ${error instanceof Error ? error.message : String(error)}`,
							}
						: entry,
				);
				return false;
			}
		},
		[onAutocompact, session],
	);

	const runFork = useCallback(async () => {
		if (!canForkSession) {
			session.appendEntry({
				kind: "status",
				text: "Fork is available after this session has messages.",
			});
			return;
		}
		const confirmed = await dialog.choice<boolean>({
			closeOnEscape: true,
			content: (ctx: ChoiceContext<boolean>) => <ForkConfirmContent {...ctx} />,
		});
		refocusTextarea();
		if (!confirmed) return;
		session.appendEntry({
			kind: "status",
			text: "Creating forked session...",
		});
		try {
			const result = await onFork();
			if (result) {
				session.updateLastEntry(() => ({
					kind: "status",
					text: `Forked into new session ${result.newSessionId}. This is now the active session. Use /history to switch sessions.`,
				}));
				if (result.carriedWorkingContext) {
					session.appendEntry({
						kind: "compaction",
						compactionMode: "inherited",
						status: "completed",
						messagesBefore: result.carriedWorkingContext.canonicalMessages,
						messagesAfter: result.carriedWorkingContext.workingContextMessages,
					});
				}
			} else {
				session.updateLastEntry(() => ({
					kind: "error",
					text: "Fork failed: could not read messages from the current session.",
				}));
			}
		} catch (error) {
			session.updateLastEntry(() => ({
				kind: "error",
				text: `Fork failed: ${error instanceof Error ? error.message : String(error)}`,
			}));
		}
	}, [canForkSession, dialog, onFork, refocusTextarea, session]);

	// `/findchat` — recall a DeepSeek Web v2 chat in the SAME Chrome the
	// provider drives. Lists the provider's persisted chats; when you pick one,
	// it navigates the live page to that chat so you can continue the history.
	const findChat = useCallback(async (): Promise<boolean> => {
		let chats: DeepSeekWebV2ChatEntry[];
		try {
			chats = listDeepSeekWebV2Chats();
		} catch (error) {
			session.appendEntry({
				kind: "error",
				text: `/findchat: could not read DeepSeek Web v2 chat history: ${error instanceof Error ? error.message : String(error)}`,
			});
			return true;
		}
		if (chats.length === 0) {
			session.appendEntry({
				kind: "status",
				text: "/findchat: no persisted DeepSeek Web v2 chats yet (run a turn with the deepseek-web-v2 provider first).",
			});
			return true;
		}

		const dialogChoice = await dialog.choice<string>({
			size: "large",
			style: { maxHeight: termHeight - 2 },
			content: (ctx: ChoiceContext<string>) => (
				<FindChatDialogContent {...ctx} chats={chats} />
			),
		});
		refocusTextarea();
		if (!dialogChoice) return true;

		session.appendEntry({
			kind: "status",
			text: `Opening DeepSeek Web v2 chat ${dialogChoice}...`,
		});
		try {
			await withLoadingDialog(dialog, "Opening chat...", () =>
				openDeepSeekWebV2Chat(dialogChoice),
			);
			session.updateLastEntry(() => ({
				kind: "status",
				text: `Opened DeepSeek Web v2 chat ${dialogChoice}.`,
			}));
		} catch (error) {
			session.updateLastEntry(() => ({
				kind: "error",
				text: `/findchat: failed to open chat ${dialogChoice}: ${error instanceof Error ? error.message : String(error)}`,
			}));
		}
		return true;
	}, [dialog, refocusTextarea, session, termHeight]);

	const handleSlashCommand = useCallback(
		(command: string, invocation?: LocalSlashCommandInvocation) => {
			const resolved = resolveSlashCommand(slashCommandRegistry, command);
			if (!resolved || resolved.execution !== "local") {
				return false;
			}
			return runLocalSlashCommandAction({
				name: resolved.name,
				isRunning: session.isRunning,
				invocation,
				openAccount,
				openConfig,
				openMcpManager,
				openModelSelector,
				openSkills,
				runCompact,
				runAutocompact,
				runFork,
				runUndo: onUndo,
				clearConversation: onClearConversation,
				openHelp,
				openHistory,
				exitCline: onExit,
				findChat,
			});
		},
		[
			onClearConversation,
			onExit,
			onUndo,
			openAccount,
			openConfig,
			openMcpManager,
			openHelp,
			openHistory,
			openModelSelector,
			openSkills,
			runCompact,
			runAutocompact,
			runFork,
			findChat,
			session.isRunning,
			slashCommandRegistry,
		],
	);

	return { handleSlashCommand, openHistory };
}
