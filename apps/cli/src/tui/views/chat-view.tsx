import { isWebChatProvider } from "@cline/shared";
import { useTerminalDimensions } from "@opentui/react";
import {
	AutocompleteDropdown,
	type AutocompleteDropdownProps,
} from "../components/autocomplete-dropdown";
import {
	BACKGROUND_RUNS_PANEL_WIDTH,
	BackgroundRuns,
} from "../components/background-runs";
import {
	ChatMessageList,
	type TranscriptScrollHandle,
} from "../components/chat-message-list";
import { InlineToolResponse } from "../components/inline-tool-response";
import { InputBar, type TextareaHandle } from "../components/input-bar";
import { QueuedPrompts } from "../components/queued-prompts";
import {
	resolveModelDisplayName,
	resolveModelMaxInputTokens,
	StatusBar,
} from "../components/status-bar";
import { useSession } from "../contexts/session-context";
import type { BackgroundRunItem } from "../hooks/use-background-runs";
import {
	useTerminalBackground,
	useTerminalTheme,
} from "../hooks/use-terminal-background";
import {
	getInputRuleColor,
	getModeAccent,
	getModeInputBackground,
	getModeInputForeground,
	getModeInputPlaceholder,
} from "../palette";
import type {
	QueuedPromptItem,
	RuntimeToolInteraction,
	ToolApprovalOutcome,
	TuiProps,
} from "../types";

export function ChatView(props: {
	config: TuiProps["config"];
	inputValue: string;
	inputKey: number;
	onSubmit: () => void;
	onContentChange: (text: string) => void;
	onImagePaste: (dataUrl: string) => string;
	onLargeTextPaste: (text: string) => string;
	onInputFocusRequest?: () => void;
	repoStatus: {
		branch: string | null;
		diffStats: {
			files: number;
			additions: number;
			deletions: number;
		} | null;
	};
	textareaRef?: React.MutableRefObject<TextareaHandle | null>;
	transcriptScrollRef?: React.Ref<TranscriptScrollHandle>;
	loadIndividualSubscriptionPlans?: TuiProps["loadIndividualSubscriptionPlans"];
	autocomplete?: AutocompleteDropdownProps;
	queuedPrompts?: QueuedPromptItem[];
	backgroundRuns?: BackgroundRunItem[];
	backgroundRunsNow?: number;
	selectedQueuedPromptId?: string | null;
	editingQueuedPrompt?: QueuedPromptItem;
	onQueuedPromptEditConfirm: (id: string, prompt: string) => void;
	onToggleMode: () => void;
	runtimeInteraction?: RuntimeToolInteraction | null;
	onResolveToolApproval: (id: number, outcome: ToolApprovalOutcome) => void;
	onResolveAskQuestion: (id: number, answer: string | null) => void;
}) {
	const {
		config,
		inputValue,
		inputKey,
		onSubmit,
		onContentChange,
		onImagePaste,
		onLargeTextPaste,
		repoStatus,
	} = props;
	const session = useSession();
	const terminalBg = useTerminalBackground();
	const terminalTheme = useTerminalTheme();
	const accent = getModeAccent(session.uiMode, terminalTheme);
	const inputBackground = getModeInputBackground(session.uiMode, terminalBg);
	const inputRuleColor = getInputRuleColor(terminalBg);
	const inputForeground = getModeInputForeground(session.uiMode, terminalBg);
	const inputPlaceholder = getModeInputPlaceholder(session.uiMode, terminalBg);
	const placeholder =
		session.uiMode === "plan" ? "Plan something..." : "Ask anything...";
	const modelDisplayName = resolveModelDisplayName(config);
	const maxInputTokens = resolveModelMaxInputTokens(config);
	const runtimeInteraction = props.runtimeInteraction ?? null;
	const { width: termWidth } = useTerminalDimensions();
	const backgroundRuns = props.backgroundRuns ?? [];
	// Beside the transcript when there is room for both, else above the input.
	const runsBeside =
		backgroundRuns.length > 0 && termWidth >= BACKGROUND_RUNS_PANEL_WIDTH + 64;

	return (
		<box flexDirection="column" width="100%" height="100%">
			<box flexDirection="row" flexGrow={1} minHeight={0}>
				<box flexDirection="column" flexGrow={1} minWidth={0}>
					<ChatMessageList
						ref={props.transcriptScrollRef}
						entries={session.entries}
						isStreaming={session.isStreaming}
						loadIndividualSubscriptionPlans={
							props.loadIndividualSubscriptionPlans
						}
						uiMode={session.uiMode}
					/>
				</box>
				{runsBeside && (
					<BackgroundRuns
						runs={backgroundRuns}
						now={props.backgroundRunsNow ?? Date.now()}
						width={BACKGROUND_RUNS_PANEL_WIDTH}
					/>
				)}
			</box>

			<box flexDirection="column" flexShrink={0}>
				{runtimeInteraction ? (
					<box marginBottom={1}>
						<InlineToolResponse
							key={runtimeInteraction.id}
							interaction={runtimeInteraction}
							accent={accent}
							inputBackground={inputBackground}
							inputForeground={inputForeground}
							inputPlaceholder={inputPlaceholder}
							onResolveToolApproval={props.onResolveToolApproval}
							onResolveAskQuestion={props.onResolveAskQuestion}
							allowSilentSkip={isWebChatProvider(config.providerId ?? "")}
						/>
					</box>
				) : (
					<>
						{props.autocomplete && (
							<AutocompleteDropdown {...props.autocomplete} accent={accent} />
						)}

						{!runsBeside && (
							<BackgroundRuns
								runs={backgroundRuns}
								now={props.backgroundRunsNow ?? Date.now()}
							/>
						)}

						{props.queuedPrompts && props.queuedPrompts.length > 0 && (
							<QueuedPrompts
								items={props.queuedPrompts}
								selectedId={props.selectedQueuedPromptId ?? null}
								editingId={props.editingQueuedPrompt?.id ?? null}
								onEditConfirm={props.onQueuedPromptEditConfirm}
							/>
						)}

						<box>
							<InputBar
								accent={accent}
								ruleColor={inputRuleColor}
								inputForeground={inputForeground}
								inputPlaceholder={inputPlaceholder}
								placeholder={placeholder}
								initialValue={inputValue}
								inputKey={inputKey}
								onSubmit={onSubmit}
								onContentChange={onContentChange}
								onImagePaste={onImagePaste}
								onLargeTextPaste={onLargeTextPaste}
								onFocusRequest={props.onInputFocusRequest}
								textareaRef={props.textareaRef}
							/>
						</box>
					</>
				)}

				<StatusBar
					providerId={config.providerId}
					modelId={modelDisplayName}
					totalTokens={session.lastTotalTokens}
					totalCost={session.lastTotalCost}
					maxInputTokens={maxInputTokens}
					webSessionStatus={session.webSessionStatus}
					ttftMs={session.lastTtftMs}
					tokensPerSecond={session.lastTokensPerSecond}
					uiMode={session.uiMode}
					autoApproveAll={session.autoApproveAll}
					workspaceName={
						config.workspaceRoot
							? (config.workspaceRoot.split("/").pop() ?? "")
							: ""
					}
					gitBranch={repoStatus.branch}
					gitDiffStats={repoStatus.diffStats}
					onToggleMode={props.onToggleMode}
					variant="chat"
				/>
			</box>
		</box>
	);
}
