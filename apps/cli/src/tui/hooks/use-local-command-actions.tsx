import {
	bindChatKey,
	type ChatGPTWebChatEntry,
	type ClaudeWebChatEntry,
	DEFAULT_CONTINUATION_NOTE,
	type DeepSeekWebV2ChatEntry,
	deleteChatGPTChatSession,
	deleteChatSession,
	deleteClaudeChatSession,
	deleteGeminiChatSession,
	deleteQwenChatSession,
	type GeminiWebChatEntry,
	getContinuationNote,
	listChatGPTWebChats,
	listClaudeWebChats,
	listDeepSeekWebV2Chats,
	listGeminiWebChats,
	listQwenWebChats,
	openChatGPTWebChat,
	openClaudeWebChat,
	openDeepSeekWebV2Chat,
	openGeminiWebChat,
	openQwenWebChat,
	type QwenWebChatEntry,
	resolveChatGPTWebV2Config,
	resolveClaudeWebV2Config,
	resolveDeepSeekWebV2Config,
	resolveGeminiWebV2Config,
	resolveQwenWebV2Config,
	setContinuationNote,
	setPendingInjectedReply,
} from "@cline/llms";
import { writeChatBinding } from "../../utils/chat-binding";
import { readClipboardText } from "../../utils/clipboard";
import { writeProjectContinuationNote } from "../../utils/continuation-note";

export type WebChatEntry =
	| DeepSeekWebV2ChatEntry
	| QwenWebChatEntry
	| ChatGPTWebChatEntry
	| ClaudeWebChatEntry
	| GeminiWebChatEntry;

interface WebProviderConfig {
	name: string;
	listChats: () => WebChatEntry[];
	openChat: (sessionId: string) => Promise<{ sessionId: string; url: string }>;
	deleteChat: (chatKey: string) => void;
}

const webProviderConfigs: Record<string, WebProviderConfig> = {
	"deepseek-web-v2": {
		name: "DeepSeek Web v2",
		listChats: listDeepSeekWebV2Chats,
		openChat: openDeepSeekWebV2Chat,
		deleteChat: (chatKey: string) => {
			const config = resolveDeepSeekWebV2Config();
			deleteChatSession(config.chatsFile, chatKey);
		},
	},
	"qwen-web": {
		name: "Qwen Web",
		listChats: listQwenWebChats,
		openChat: openQwenWebChat,
		deleteChat: (chatKey: string) => {
			const config = resolveQwenWebV2Config();
			deleteQwenChatSession(config.chatsFile, chatKey);
		},
	},
	"chatgpt-web": {
		name: "ChatGPT Web",
		listChats: listChatGPTWebChats,
		openChat: openChatGPTWebChat,
		deleteChat: (chatKey: string) => {
			const config = resolveChatGPTWebV2Config();
			deleteChatGPTChatSession(config.chatsFile, chatKey);
		},
	},
	"claude-web": {
		name: "Claude Web",
		listChats: listClaudeWebChats,
		openChat: openClaudeWebChat,
		deleteChat: (chatKey: string) => {
			const config = resolveClaudeWebV2Config();
			deleteClaudeChatSession(config.chatsFile, chatKey);
		},
	},
	"gemini-web": {
		name: "Gemini Web",
		listChats: listGeminiWebChats,
		openChat: openGeminiWebChat,
		deleteChat: (chatKey: string) => {
			const config = resolveGeminiWebV2Config();
			deleteGeminiChatSession(config.chatsFile, chatKey);
		},
	},
};

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
	providerId: string;
	/** Project directory the continuation note (`/note`) is stored against. */
	cwd: string;
	/** Id of the running CLI session; used by `/findchat` to pin it to a chat. */
	getSessionId: () => string | undefined;
	/** Submit text as if the user typed it (used by `/paste` to start a turn). */
	submitText: (text: string) => void;
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
		providerId,
		cwd,
		getSessionId,
		submitText,
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
								text: `Auto-compaction context limit set to ${label} tokens. The new limit will apply immediately.`,
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

	// `/findchat` — recall a Web chat in the SAME Chrome the provider drives.
	// Automatically detects the active provider and uses its specific configuration.
	const findChat = useCallback(async (): Promise<boolean> => {
		const providerConfig = webProviderConfigs[providerId];

		if (!providerConfig) {
			session.appendEntry({
				kind: "error",
				text: `/findchat: provider "${providerId}" is not a supported web provider for chat recall.`,
			});
			return true;
		}

		let chats: WebChatEntry[];
		try {
			chats = providerConfig.listChats();
		} catch (error) {
			session.appendEntry({
				kind: "error",
				text: `/findchat: could not read ${providerConfig.name} chat history: ${error instanceof Error ? error.message : String(error)}`,
			});
			return true;
		}

		if (chats.length === 0) {
			session.appendEntry({
				kind: "status",
				text: `/findchat: no persisted ${providerConfig.name} chats yet (run a turn with the provider first).`,
			});
			return true;
		}

		const dialogChoice = await dialog.choice<string>({
			size: "large",
			style: { maxHeight: termHeight - 2 },
			content: (ctx: ChoiceContext<string>) => (
				<FindChatDialogContent
					{...ctx}
					chats={chats}
					onDelete={providerConfig.deleteChat}
					providerName={providerConfig.name}
				/>
			),
		});
		refocusTextarea();
		if (!dialogChoice) return true;

		session.appendEntry({
			kind: "status",
			text: `Opening ${providerConfig.name} chat ${dialogChoice}...`,
		});
		try {
			await withLoadingDialog(dialog, "Opening chat...", () =>
				providerConfig.openChat(dialogChoice),
			);
			session.updateLastEntry(() => ({
				kind: "status",
				text: `Opened ${providerConfig.name} chat ${dialogChoice}.`,
			}));
		} catch (error) {
			session.updateLastEntry(() => ({
				kind: "error",
				text: `/findchat: failed to open chat ${dialogChoice}: ${error instanceof Error ? error.message : String(error)}`,
			}));
			return true;
		}

		// Pin this CLI session to the chat that was just opened, so every
		// following turn goes there instead of to whatever the prompt hash would
		// pick. Persisted, so resuming this session from `/history` restores the
		// pairing. See utils/chat-binding.ts.
		const cliSessionId = getSessionId();
		const chosen = chats.find((entry) => entry.sessionId === dialogChoice);
		if (!cliSessionId) {
			session.appendEntry({
				kind: "status",
				text: "/findchat: opened the chat, but this CLI session has no id yet, so it was not pinned. Send a message first, then run /findchat again.",
			});
			return true;
		}
		if (!chosen) {
			session.appendEntry({
				kind: "status",
				text: `/findchat: opened the chat, but it is missing from ${providerConfig.name}'s registry, so it was not pinned.`,
			});
			return true;
		}

		const stolenFrom = writeChatBinding(cliSessionId, {
			providerId,
			chatKey: chosen.chatKey,
		});
		bindChatKey(providerId, chosen.chatKey);
		session.appendEntry({
			kind: "status",
			text: stolenFrom
				? `/findchat: this session is now pinned to that chat (taken over from session ${stolenFrom}).`
				: "/findchat: this session is now pinned to that chat.",
		});
		return true;
	}, [dialog, getSessionId, providerId, refocusTextarea, session, termHeight]);

	/**
	 * `/paste`: recover a web-provider turn whose reply was lost to a network
	 * error. The reply is still readable in the browser, so the user copies it
	 * and we queue it as the answer for the next model request — which then
	 * parses `<tool>` calls, runs approvals, and feeds tool results back exactly
	 * as if we had captured the reply ourselves.
	 */
	const pasteReply = useCallback(async (): Promise<boolean> => {
		if (!webProviderConfigs[providerId]) {
			session.appendEntry({
				kind: "error",
				text: `/paste: provider "${providerId}" is not a web provider; nothing to recover.`,
			});
			return true;
		}

		const clipboard = await readClipboardText();
		if (!clipboard) {
			session.appendEntry({
				kind: "error",
				text: "/paste: clipboard is empty. Copy the model's reply from the browser first.",
			});
			return true;
		}

		setPendingInjectedReply(clipboard);
		session.appendEntry({
			kind: "status",
			text: `/paste: queued ${clipboard.length} chars from the clipboard as the model's reply.`,
		});
		submitText("(recovering a reply that was pasted in manually)");
		return true;
	}, [providerId, session, submitText]);

	/**
	 * `/note` — show or set the note the runtime appends after each round of
	 * tool execution. Stored per project, so a repo keeps its own marching
	 * orders across sessions.
	 */
	const setNote = useCallback(
		(arg: string): boolean => {
			if (!arg) {
				const active = getContinuationNote();
				const isDefault = active === DEFAULT_CONTINUATION_NOTE;
				session.appendEntry({
					kind: "status",
					text:
						`/note: ${isDefault ? "default" : "custom"} note for this project:
` +
						`  ${active}
` +
						"  Set with /note <text>, restore the default with /note reset.",
				});
				return true;
			}

			const lowered = arg.toLowerCase();
			if (lowered === "reset" || lowered === "default") {
				writeProjectContinuationNote(cwd, undefined);
				setContinuationNote(undefined);
				session.appendEntry({
					kind: "status",
					text: `/note: restored the default note:
  ${DEFAULT_CONTINUATION_NOTE}`,
				});
				return true;
			}

			writeProjectContinuationNote(cwd, arg);
			setContinuationNote(arg);
			session.appendEntry({
				kind: "status",
				text: `/note: this project's note is now:
  ${arg}`,
			});
			return true;
		},
		[cwd, session],
	);

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
				pasteReply,
				setNote,
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
			pasteReply,
			setNote,
			session.isRunning,
			slashCommandRegistry,
		],
	);

	return { handleSlashCommand, openHistory };
}
