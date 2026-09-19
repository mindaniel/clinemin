import {
	loadProfiles,
	loadTeamRoster,
	resolveTeamRosterSearchPaths,
	writeProfiles,
	writeTeamRoster,
} from "@cline/core";
import * as Llms from "@cline/llms";
import {
	type BrowserProfile,
	bindChatKey,
	type ChatGPTWebChatEntry,
	type ClaudeWebChatEntry,
	createBrowserProfile,
	DEFAULT_CONTINUATION_NOTE,
	DEFAULT_PROFILE_NAME,
	type DeepSeekWebV2ChatEntry,
	deleteBrowserProfile,
	deleteChatGPTChatSession,
	deleteChatSession,
	deleteClaudeChatSession,
	deleteGeminiChatSession,
	deleteKimiChatSession,
	deleteQwenChatSession,
	type GeminiWebChatEntry,
	getActiveBrowserProfile,
	getContinuationNote,
	type KimiWebChatEntry,
	listBrowserProfiles,
	listChatGPTWebChats,
	listClaudeWebChats,
	listDeepSeekWebV2Chats,
	listGeminiWebChats,
	listKimiWebChats,
	listQwenWebChats,
	openChatGPTWebChat,
	openClaudeWebChat,
	openDeepSeekWebV2Chat,
	openGeminiWebChat,
	openKimiWebChat,
	openQwenWebChat,
	PASTE_CARRIER_PROMPT,
	type ProfileResetResult,
	type QwenWebChatEntry,
	resetBrowserProfileData,
	resolveChatGPTWebV2Config,
	resolveClaudeWebV2Config,
	resolveDeepSeekWebV2Config,
	resolveGeminiWebV2Config,
	resolveKimiWebV2Config,
	resolveQwenWebV2Config,
	setActiveBrowserProfile,
	setContinuationNote,
	setPendingInjectedReply,
} from "@cline/llms";
import { writeChatBinding } from "../../utils/chat-binding";
import { readClipboardText } from "../../utils/clipboard";
import { writeProjectContinuationNote } from "../../utils/continuation-note";
import { isManagerOffRequest } from "../../utils/manager-command";

export type WebChatEntry =
	| DeepSeekWebV2ChatEntry
	| QwenWebChatEntry
	| ChatGPTWebChatEntry
	| ClaudeWebChatEntry
	| GeminiWebChatEntry
	| KimiWebChatEntry;

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
	"kimi-web": {
		name: "Kimi Web",
		listChats: listKimiWebChats,
		openChat: openKimiWebChat,
		deleteChat: (chatKey: string) => {
			const config = resolveKimiWebV2Config();
			deleteKimiChatSession(config.chatsFile, chatKey);
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

import { disableConnectorAutostart } from "@cline/core";
import { useTerminalDimensions } from "@opentui/react";
import type { ChoiceContext } from "@opentui-ui/dialog";
import { useDialog } from "@opentui-ui/dialog/react";
import { useCallback } from "react";
import { runConnectAdapter, runStopConnector } from "../../commands/connect";
import type { SlashCommandRegistry } from "../commands/slash-command-registry";
import { resolveSlashCommand } from "../commands/slash-command-registry";
import { FindChatDialogContent } from "../components/dialogs/find-chat-dialog";
import { ForkConfirmContent } from "../components/dialogs/fork-confirm";
import { HelpDialogContent } from "../components/dialogs/help-dialog";
import { withLoadingDialog } from "../components/dialogs/loading-dialog";
import {
	ManagerDialogContent,
	type ManagerDialogResult,
} from "../components/dialogs/manager-dialog";
import { ManagerOffConfirmContent } from "../components/dialogs/manager-off-confirm";
import { PasteReplyDialogContent } from "../components/dialogs/paste-reply-dialog";
import { ProfilePickerContent } from "../components/dialogs/profile-picker";
import {
	ProfilesDialogContent,
	type ProfilesDialogResult,
} from "../components/dialogs/profiles-dialog";
import {
	TelegramConfigDialogContent,
	type TelegramConfigDialogResult,
} from "../components/dialogs/telegram-config-dialog";
import {
	WorkersDialogContent,
	type WorkersDialogResult,
} from "../components/dialogs/workers-dialog";
import { useSession } from "../contexts/session-context";
import {
	buildTelegramConnectArgs,
	isTelegramConnectorRunning,
	readTelegramConnectorConfig,
	writeTelegramCredentials,
} from "../telegram-connector-config";
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
	/**
	 * Switch this session to a manager on the given provider and restart it
	 * empty. The system prompt is fixed for a session's life, so starting a
	 * manager is a restart — which is why `/manager` belongs at the start of a
	 * chat.
	 */
	onStartManager: (providerId: string) => Promise<void>;
	/**
	 * Leave manager mode and restart the session as a plain one. Same restart
	 * cost as starting a manager, so the caller confirms first.
	 */
	onStopManager: () => Promise<void>;
	/** Whether this session is currently running as a manager. */
	isManagerMode: () => boolean;
	/** Submit text as if the user typed it (used by `/paste` to start a turn). */
	submitText: (
		text: string,
		delivery?: "queue" | "steer",
		options?: { silent?: boolean },
	) => void;
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
		onStartManager,
		onStopManager,
		isManagerMode,
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
		let chosen = chats.find((entry) => entry.sessionId === dialogChoice);

		// If not found in the registry, it might be a newly imported chat ID or URL.
		// We synthesize an entry so it can still be pinned to this CLI session.
		if (!chosen) {
			chosen = {
				chatKey: dialogChoice,
				sessionId: dialogChoice,
				lastActive: new Date().toISOString(),
			} as WebChatEntry;
		}

		if (!cliSessionId) {
			session.appendEntry({
				kind: "status",
				text: "/findchat: opened the chat, but this CLI session has no id yet, so it was not pinned. Send a message first, then run /findchat again.",
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
	/**
	 * Every provider and its models, for the dialogs that pick one.
	 *
	 * Resolved up front rather than per keystroke inside a dialog: the model
	 * registry is a local cache, so this is cheap, and it keeps the dialogs
	 * synchronous — no half-drawn model list to select the wrong row in.
	 */
	const loadProviderCatalog = useCallback(async (): Promise<{
		providerIds: string[];
		modelsByProvider: Record<string, string[]>;
	}> => {
		const providerIds = Llms.getProviderIds().sort((a, b) =>
			a.localeCompare(b),
		);
		const modelsByProvider: Record<string, string[]> = {};
		await Promise.all(
			providerIds.map(async (id) => {
				try {
					modelsByProvider[id] = Object.keys(
						await Llms.getModelsForProvider(id),
					).sort((a, b) => a.localeCompare(b));
				} catch {
					modelsByProvider[id] = [];
				}
			}),
		);
		return { providerIds, modelsByProvider };
	}, []);

	/**
	 * `/profiles` — the named connections workers run on.
	 *
	 * A profile is a provider plus the credential that authenticates it, which
	 * is what lets two workers share a provider without sharing an account. The
	 * Chrome logins a profile can name are created here too, on save rather than
	 * on selection: creating one eagerly would leave a user-data-dir behind for
	 * a profile the user then abandoned with Escape.
	 */
	const openProfiles = useCallback(async (): Promise<boolean> => {
		const loaded = loadProfiles();
		if (loaded.error) {
			// A store that exists but does not parse must not be silently replaced
			// with whatever the dialog builds — that would discard the user's file,
			// API keys included.
			session.appendEntry({
				kind: "error",
				text: `/profiles: ${loaded.error}. Fix the file before editing it here.`,
			});
			return true;
		}
		const { providerIds, modelsByProvider } = await loadProviderCatalog();
		const chosen = await dialog.choice<ProfilesDialogResult>({
			size: "large",
			content: (ctx: ChoiceContext<ProfilesDialogResult>) => (
				<ProfilesDialogContent
					{...ctx}
					initialProfiles={loaded.profiles}
					providerIds={providerIds}
					modelsByProvider={modelsByProvider}
					browserProfiles={listBrowserProfiles().map((profile) => profile.name)}
					storePath={loaded.path}
				/>
			),
		});
		refocusTextarea();
		if (!chosen) {
			return true;
		}
		try {
			const existing = new Set(
				listBrowserProfiles().map((profile) => profile.name),
			);
			for (const name of chosen.newBrowserProfiles) {
				if (existing.has(name)) continue;
				createBrowserProfile(name);
			}
			writeProfiles({ path: loaded.path, profiles: chosen.profiles });
			session.appendEntry({
				kind: "status",
				text: `Saved ${chosen.profiles.length} profile${chosen.profiles.length === 1 ? "" : "s"} to ${loaded.path}.`,
			});
		} catch (error) {
			session.appendEntry({
				kind: "error",
				text: `/profiles: could not save: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
		return true;
	}, [dialog, loadProviderCatalog, refocusTextarea, session]);

	// `/workers` — edit the roster a manager delegates to.
	const openWorkers = useCallback(async (): Promise<boolean> => {
		const rosterPath = resolveTeamRosterSearchPaths(cwd)[0];
		if (!rosterPath) {
			session.appendEntry({
				kind: "error",
				text: "/workers: could not work out where to keep the roster.",
			});
			return true;
		}
		const loaded = loadTeamRoster({ workspaceRoot: cwd });
		if (loaded.error) {
			// A roster that exists but does not parse must not be silently replaced
			// with whatever the dialog builds — that would discard the user's file.
			session.appendEntry({
				kind: "error",
				text: `/workers: ${loaded.error}. Fix the file before editing it here.`,
			});
			return true;
		}

		const { providerIds, modelsByProvider } = await loadProviderCatalog();
		// A store that does not parse is reported by `/profiles`, not here: this
		// dialog only needs the list to show what each worker is pointed at, and
		// refusing to edit the roster over an unrelated broken file would be worse
		// than showing "(missing from profiles.json)" next to the names.
		const profiles = loadProfiles().profiles;
		const chosen = await dialog.choice<WorkersDialogResult>({
			size: "large",
			content: (ctx: ChoiceContext<WorkersDialogResult>) => (
				<WorkersDialogContent
					{...ctx}
					initialWorkers={loaded.roster?.workers ?? []}
					providerIds={providerIds}
					modelsByProvider={modelsByProvider}
					profiles={profiles}
					rosterPath={loaded.path ?? rosterPath}
				/>
			),
		});
		refocusTextarea();
		if (!chosen) {
			return true;
		}
		try {
			writeTeamRoster({
				path: loaded.path ?? rosterPath,
				workers: chosen.workers,
			});
			session.appendEntry({
				kind: "status",
				text: `Saved ${chosen.workers.length} worker${chosen.workers.length === 1 ? "" : "s"} to ${loaded.path ?? rosterPath}.`,
			});
		} catch (error) {
			session.appendEntry({
				kind: "error",
				text: `/workers: could not save the roster: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
		return true;
	}, [cwd, dialog, loadProviderCatalog, refocusTextarea, session]);

	/**
	 * Bare `/manager` — choose which model manages, then start.
	 *
	 * Only browser-driven providers and the session's own are offered. A manager
	 * is a reasoning-only seat, so in practice it is a web chat model; and every
	 * other provider would need its key and endpoint set up first, which is
	 * `/model`'s job and a bad thing to discover halfway through a restart.
	 */
	const openManager = useCallback(
		async (taskBody: string): Promise<boolean> => {
			const offRequested = isManagerOffRequest(taskBody);
			// Bare `/manager` (and its Opt+J shortcut) is a toggle once the session
			// is already a manager: re-picking the manager's model would only
			// restart into the same mode, so the useful thing to offer is the way
			// out. The confirm is what keeps a stray keypress from clearing the
			// conversation.
			if (offRequested || (!taskBody && isManagerMode())) {
				if (!isManagerMode()) {
					session.appendEntry({
						kind: "status",
						text: "Manager mode is already off.",
					});
					return true;
				}
				const confirmed = await dialog.choice<boolean>({
					closeOnEscape: true,
					content: (ctx: ChoiceContext<boolean>) => (
						<ManagerOffConfirmContent {...ctx} />
					),
				});
				refocusTextarea();
				if (!confirmed) return true;
				try {
					await onStopManager();
					session.appendEntry({
						kind: "status",
						text: "Manager mode off. This session does the work itself again.",
					});
				} catch (error) {
					session.appendEntry({
						kind: "error",
						text: `/manager off: could not leave manager mode: ${error instanceof Error ? error.message : String(error)}`,
					});
				}
				return true;
			}
			if (taskBody) {
				// `/manager <task>` keeps its old path through the chat runner.
				return false;
			}
			const loaded = loadTeamRoster({ workspaceRoot: cwd });
			if (loaded.error) {
				session.appendEntry({
					kind: "error",
					text: `/manager: ${loaded.error}. Fix the roster before starting a manager.`,
				});
				return true;
			}
			const workerNames = (loaded.roster?.workers ?? []).map(
				(worker) => worker.agentId,
			);
			const providerIds = Llms.getProviderIds()
				.filter((id) => /-web(-v\d+)?$/i.test(id) || id === providerId)
				.sort((a, b) => a.localeCompare(b));

			const chosen = await dialog.choice<ManagerDialogResult>({
				size: "large",
				content: (ctx: ChoiceContext<ManagerDialogResult>) => (
					<ManagerDialogContent
						{...ctx}
						providerIds={providerIds}
						currentProviderId={providerId}
						workerNames={workerNames}
					/>
				),
			});
			refocusTextarea();
			if (!chosen) {
				return true;
			}
			try {
				await onStartManager(chosen.providerId);
				session.appendEntry({
					kind: "status",
					text:
						`Manager mode on ${chosen.providerId}. ` +
						(workerNames.length
							? `Delegating to ${workerNames.join(", ")}. Describe the task.`
							: "No workers yet — add some with /workers."),
				});
			} catch (error) {
				session.appendEntry({
					kind: "error",
					text: `/manager: could not start manager mode: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
			return true;
		},
		[
			cwd,
			dialog,
			isManagerMode,
			onStartManager,
			onStopManager,
			providerId,
			refocusTextarea,
			session,
		],
	);

	const pasteReply = useCallback(async (): Promise<boolean> => {
		if (!webProviderConfigs[providerId]) {
			session.appendEntry({
				kind: "error",
				text: `/paste: provider "${providerId}" is not a web provider; nothing to recover.`,
			});
			return true;
		}

		// Confirm before queueing. The clipboard is easy to get wrong — an old
		// copy, a URL, half a reply — and a wrong one only fails seconds later
		// from inside a turn, where it reads as a model error rather than a bad
		// paste. The dialog can re-read the clipboard, so a bad copy is fixed by
		// copying again and pressing `r`, without restarting the command.
		const clipboard = await readClipboardText();
		const confirmed = await dialog.choice<string>({
			closeOnEscape: true,
			content: (ctx: ChoiceContext<string>) => (
				<PasteReplyDialogContent
					{...ctx}
					initialText={clipboard}
					readClipboard={readClipboardText}
					providerName={webProviderConfigs[providerId]?.name ?? providerId}
				/>
			),
		});
		refocusTextarea();
		if (!confirmed) {
			session.appendEntry({
				kind: "status",
				text: "/paste: cancelled, nothing was queued.",
			});
			return true;
		}

		setPendingInjectedReply(confirmed, providerId);
		session.appendEntry({
			kind: "status",
			text: `/paste: executing pasted reply (${confirmed.length} chars)...`,
		});
		// Run the turn NOW, not through the pending-prompt queue: the queue is
		// only drained when a turn finishes, so a queued paste sent while idle
		// would sit there forever. `silent` keeps the carrier text out of the
		// visible history and out of input history — the pasted reply is already
		// queued for the provider, so this turn consumes it instead of calling
		// the model, and the tools in it run straight away.
		submitText(PASTE_CARRIER_PROMPT, undefined, { silent: true });
		return true;
	}, [dialog, providerId, refocusTextarea, session, submitText]);

	/**
	 * `/profile` -> `r` — sign a profile out of every web provider.
	 *
	 * A Chrome `--user-data-dir` IS the login, so clearing cookies means
	 * deleting those directories; there is no lighter touch short of doing it by
	 * hand in each browser window. Deliberately distinct from `d`, which forgets
	 * the list entry and leaves the logins alone — one is "I am done with this
	 * profile", this is "sign me out".
	 *
	 * A browser the user launched themselves is not ours to kill, so its
	 * provider is reported rather than having a live profile deleted out from
	 * under it, which would leave Chrome rewriting a directory that no longer
	 * exists.
	 */
	const resetProfile = useCallback(
		async (name: string): Promise<boolean> => {
			let result: ProfileResetResult;
			try {
				result = await resetBrowserProfileData(name, { includeChats: true });
			} catch (error) {
				session.appendEntry({
					kind: "error",
					text: `/profile: could not reset "${name}": ${error instanceof Error ? error.message : String(error)}`,
				});
				return true;
			}

			if (result.removed.length === 0 && result.busy.length === 0) {
				session.appendEntry({
					kind: "status",
					text: `/profile: "${name}" had no browser data to clear.`,
				});
				return true;
			}

			const lines = [
				result.removed.length
					? `/profile: signed "${name}" out of every web provider (${result.removed.length} ${result.removed.length === 1 ? "directory" : "directories"} removed). The next turn opens a fresh browser to sign in.`
					: `/profile: nothing was removed for "${name}".`,
			];
			if (result.busy.length) {
				lines.push(
					`Left alone because a Chrome you started is still on their port: ${result.busy
						.map((entry) => `${entry.providerId} (${entry.debugPort})`)
						.join(", ")}. Close those windows and run /profile again.`,
				);
			}
			session.appendEntry({
				kind: result.busy.length ? "error" : "status",
				text: lines.join(" "),
			});
			return true;
		},
		[session],
	);

	/**
	 * `/profile` — choose which named Chrome profile the web providers use.
	 *
	 * A profile is a Chrome `--user-data-dir`, which IS the logged-in account,
	 * so switching profiles switches accounts. It also shifts the DevTools debug
	 * port: without that, the next launch would find the other profile's Chrome
	 * already listening and quietly drive it instead.
	 *
	 * The choice is global rather than per-provider, so one selection moves
	 * every web provider to its own copy of that profile.
	 */
	const switchProfile = useCallback(async (): Promise<boolean> => {
		let profiles: BrowserProfile[];
		let active: string;
		try {
			profiles = listBrowserProfiles();
			active = getActiveBrowserProfile();
		} catch (error) {
			session.appendEntry({
				kind: "error",
				text: `/profile: could not read the profile list: ${error instanceof Error ? error.message : String(error)}`,
			});
			return true;
		}

		const choice = await dialog.choice<string>({
			closeOnEscape: true,
			content: (ctx: ChoiceContext<string>) => (
				<ProfilePickerContent
					{...ctx}
					profiles={profiles}
					active={active}
					defaultProfileName={DEFAULT_PROFILE_NAME}
					onDelete={deleteBrowserProfile}
				/>
			),
		});
		refocusTextarea();
		if (!choice) return true;

		if (choice.startsWith("__reset__:")) {
			return resetProfile(choice.slice("__reset__:".length));
		}

		let name = choice;
		if (choice.startsWith("__create__:")) {
			try {
				name = createBrowserProfile(choice.slice("__create__:".length)).name;
			} catch (error) {
				session.appendEntry({
					kind: "error",
					text: `/profile: ${error instanceof Error ? error.message : String(error)}`,
				});
				return true;
			}
		}

		if (name === active) {
			session.appendEntry({
				kind: "status",
				text: `/profile: already on "${name}".`,
			});
			return true;
		}

		try {
			setActiveBrowserProfile(name);
		} catch (error) {
			session.appendEntry({
				kind: "error",
				text: `/profile: ${error instanceof Error ? error.message : String(error)}`,
			});
			return true;
		}

		// The provider re-reads the active profile at the start of every turn, so
		// this takes effect on the next message with no restart. A brand-new
		// profile starts signed out: the provider opens its own Chrome window and
		// waits for the login the same way a first run does. The switch is pinned
		// to THIS terminal — another CLI already running stays on its own profile,
		// so two profiles can be driven side by side.
		session.appendEntry({
			kind: "status",
			text:
				`/profile: this terminal now uses profile "${name}". ` +
				"The next turn opens its browser; sign in there if it is new.",
		});
		return true;
	}, [dialog, refocusTextarea, resetProfile, session]);

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
				text: `/note: this project's note is now:\n  ${arg}`,
			});
			return true;
		},
		[cwd, session],
	);

	/**
	 * `/telegram` - open the interactive connector box. The token and chat ID
	 * are persisted in the shared connector store; the toggle starts or stops
	 * the live connector process immediately, so it can be turned on and off
	 * whenever the user wants while using Cline. Autostart is always cleared so
	 * Telegram never connects on its own when Cline starts.
	 */
	const configureTelegram = useCallback(async (): Promise<boolean> => {
		const initial = readTelegramConnectorConfig();
		const result = await dialog.choice<TelegramConfigDialogResult | null>({
			size: "large",
			style: { maxHeight: termHeight - 2 },
			content: (ctx: ChoiceContext<TelegramConfigDialogResult | null>) => (
				<TelegramConfigDialogContent {...ctx} initial={initial} />
			),
		});
		refocusTextarea();
		if (!result) {
			return true;
		}
		// The hub daemon reconnects any connector marked enabled on startup.
		// Always clear that flag: Telegram should only run when explicitly
		// toggled on here.
		disableConnectorAutostart("telegram");
		const io = {
			writeln: (text?: string) => {
				if (text) session.appendEntry({ kind: "status", text });
			},
			writeErr: (text?: string) => {
				if (text) session.appendEntry({ kind: "error", text });
			},
		};
		try {
			writeTelegramCredentials({
				botToken: result.botToken,
				chatId: result.chatId,
			});
			const wasRunning = isTelegramConnectorRunning();
			if (result.running && !wasRunning) {
				await runConnectAdapter(
					"telegram",
					buildTelegramConnectArgs(result),
					io,
				);
				// Starting through the connect command records an autostart row.
				// Drop it: Telegram must never reconnect on its own at startup.
				disableConnectorAutostart("telegram");
				session.appendEntry({
					kind: "status",
					text: "/telegram: credentials saved, connector started.",
				});
			} else if (!result.running && wasRunning) {
				await runStopConnector("telegram", io);
				disableConnectorAutostart("telegram");
				session.appendEntry({
					kind: "status",
					text: "/telegram: credentials saved, connector stopped.",
				});
			} else {
				session.appendEntry({
					kind: "status",
					text: `/telegram: credentials saved. Connector is ${result.running ? "running" : "stopped"}.`,
				});
			}
		} catch (error) {
			session.appendEntry({
				kind: "error",
				text: `/telegram: ${error instanceof Error ? error.message : String(error)}`,
			});
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
				openProfiles,
				openWorkers,
				openManager,
				pasteReply,
				setNote,
				switchProfile,
				configureTelegram,
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
			openProfiles,
			openWorkers,
			openManager,
			runCompact,
			runAutocompact,
			runFork,
			findChat,
			pasteReply,
			setNote,
			switchProfile,
			configureTelegram,
			session.isRunning,
			slashCommandRegistry,
		],
	);

	return { handleSlashCommand, openHistory };
}
