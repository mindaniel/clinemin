import { useTerminalDimensions } from "@opentui/react";
import { useState } from "react";
import {
	AutocompleteDropdown,
	type AutocompleteDropdownProps,
	DROPDOWN_MAX_HEIGHT,
} from "../components/autocomplete-dropdown";
import { InputBar, type TextareaHandle } from "../components/input-bar";
import {
	fitTreeSize,
	LiveTree,
	liveTreeAvailable,
	useLiveTree,
} from "../components/live-tree";
import {
	resolveModelDisplayName,
	resolveModelMaxInputTokens,
	StatusBar,
} from "../components/status-bar";
import { TrackedRobot, useMouseTracker } from "../components/tracked-robot";
import { useSession } from "../contexts/session-context";
import {
	useTerminalBackground,
	useTerminalTheme,
} from "../hooks/use-terminal-background";
import {
	getDefaultForeground,
	getInputRuleColor,
	getModeAccent,
	getModeInputForeground,
	getModeInputPlaceholder,
} from "../palette";
import { HOME_VIEW_MAX_WIDTH, type TuiProps } from "../types";

export function HomeView(props: {
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
	autocomplete?: AutocompleteDropdownProps;
	onToggleMode: () => void;
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
	const { width, height } = useTerminalDimensions();
	const mouse = useMouseTracker();
	const [inputCursor, setInputCursor] = useState<{
		visualCol: number;
		visualRow: number;
	} | null>(null);

	const terminalBg = useTerminalBackground();
	const terminalTheme = useTerminalTheme();
	const defaultFg = getDefaultForeground(terminalBg);
	const accent = getModeAccent(session.uiMode, terminalTheme);
	const inputRuleColor = getInputRuleColor(terminalBg);
	const inputForeground = getModeInputForeground(session.uiMode, terminalBg);
	const inputPlaceholder = getModeInputPlaceholder(session.uiMode, terminalBg);
	const placeholder =
		session.uiMode === "plan" ? "Plan something..." : "What can I do for you?";
	const modelDisplayName = resolveModelDisplayName(config);
	const maxInputTokens = resolveModelMaxInputTokens(config);
	const hasAutocomplete =
		props.autocomplete?.mode && props.autocomplete.options.length > 0;
	// Wide terminal: chat on the left, live Christmas tree on the right.
	const tree = fitTreeSize(width - HOME_VIEW_MAX_WIDTH - 8, height - 2);
	const treeFits = tree.cols >= 30 && tree.rows >= 18 && liveTreeAvailable();
	const liveTree = useLiveTree(tree.cols, tree.rows, treeFits);
	const showTree = treeFits && !liveTree.failed;
	const leftWidth = showTree ? width - tree.cols - 4 : width;
	const contentWidth = Math.min(leftWidth, HOME_VIEW_MAX_WIDTH);
	const hasTypedInput = inputValue.trim().length > 0;
	const inputStartX = Math.floor((leftWidth - contentWidth) / 2) + 2;
	const clamp = (value: number, min: number, max: number) =>
		Math.max(min, Math.min(max, value));
	const trackedCursorX = hasTypedInput
		? clamp(inputStartX + (inputCursor?.visualCol ?? 0), 0, width)
		: mouse.cursor.x;
	const trackedCursorY = hasTypedInput
		? clamp(height - 2 + (inputCursor?.visualRow ?? 0), 0, height)
		: mouse.cursor.y;

	return (
		<box
			flexDirection="row"
			width="100%"
			height="100%"
			onMouseMove={mouse.onMouseMove}
		>
			<box
				flexDirection="column"
				width={leftWidth}
				height="100%"
				alignItems="center"
				justifyContent="center"
			>
				{showTree ? null : (
					<TrackedRobot cursorX={trackedCursorX} cursorY={trackedCursorY} />
				)}
				<box marginTop={1} marginBottom={1} flexShrink={0}>
					<text fg={defaultFg}>
						<strong>What can I do for you?</strong>
					</text>
				</box>
				<box marginBottom={1} flexShrink={0}>
					<text fg="gray">
						<em>
							Use / for slash commands, @ for file mentions, Ctrl+P for menu
						</em>
					</text>
				</box>

				<box flexDirection="column" width={contentWidth} flexShrink={0}>
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
						onVisualCursorChange={setInputCursor}
						onImagePaste={onImagePaste}
						onLargeTextPaste={onLargeTextPaste}
						onFocusRequest={props.onInputFocusRequest}
						textareaRef={props.textareaRef}
					/>

					<box flexDirection="column" height={DROPDOWN_MAX_HEIGHT + 1}>
						{hasAutocomplete && props.autocomplete ? (
							<AutocompleteDropdown
								{...props.autocomplete}
								accent={accent}
								containerWidth={contentWidth}
							/>
						) : (
							<box marginTop={1}>
								<StatusBar
									providerId={config.providerId}
									modelId={modelDisplayName}
									totalTokens={session.lastTotalTokens}
									totalCost={session.lastTotalCost}
									maxInputTokens={maxInputTokens}
									webSessionStatus={session.webSessionStatus}
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
									variant="home"
								/>
							</box>
						)}
					</box>
				</box>
			</box>
			{showTree ? (
				<box
					width={tree.cols + 4}
					height="100%"
					alignItems="center"
					justifyContent="center"
					flexShrink={0}
				>
					<LiveTree lines={liveTree.lines} cols={tree.cols} />
				</box>
			) : null}
		</box>
	);
}
