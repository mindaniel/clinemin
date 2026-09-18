import type { AgentMode } from "@cline/core";
import { useTerminalDimensions } from "@opentui/react";
import {
	shouldShowCliUsageCost,
	shouldShowCliUsageCoveredBySubscription,
} from "../../utils/usage-cost-display";
import {
	useTerminalBackground,
	useTerminalTheme,
} from "../hooks/use-terminal-background";
import {
	getDefaultForeground,
	getModeAccent,
	getSuccessColor,
} from "../palette";
import { HOME_VIEW_MAX_WIDTH, type WebSessionStatus } from "../types";
import { formatTokenCount } from "../utils/compaction-status";

export function createContextBar(
	used: number,
	total?: number,
	width = 6,
): { filled: string; empty: string } {
	const normalizedWidth = Math.max(0, Math.floor(width));
	const ratio = total && total > 0 ? Math.min(used / total, 1) : 0;
	const filledCount =
		total && total > 0 && used > 0
			? used >= total
				? normalizedWidth
				: Math.min(
						Math.max(1, Math.ceil(ratio * normalizedWidth)),
						Math.max(0, normalizedWidth - 1),
					)
			: 0;
	const emptyCount = Math.max(0, normalizedWidth - filledCount);
	return {
		filled: "\u2588".repeat(filledCount),
		empty: "\u2588".repeat(emptyCount),
	};
}

export function resolveContextBarFilledForeground(
	defaultForeground: string | undefined,
): string {
	return defaultForeground ?? "#ffffff";
}

function formatCost(cost: number): string {
	return `$${cost.toFixed(2)}`;
}

export function formatSpeedStatsText(input: {
	ttftMs: number | null | undefined;
	tokensPerSecond: number | null | undefined;
}): string {
	const parts: string[] = [];
	if (typeof input.ttftMs === "number" && Number.isFinite(input.ttftMs)) {
		parts.push(`TTFT ${(input.ttftMs / 1000).toFixed(1)}s`);
	}
	if (
		typeof input.tokensPerSecond === "number" &&
		Number.isFinite(input.tokensPerSecond)
	) {
		parts.push(`${input.tokensPerSecond.toFixed(1)} tok/s`);
	}
	return parts.join(" · ");
}

function formatCostText(providerId: string, totalCost: number): string {
	// Subscription providers (ClinePass) have no per-use cost worth surfacing.
	if (shouldShowCliUsageCoveredBySubscription(providerId)) {
		return "";
	}

	if (!shouldShowCliUsageCost(providerId)) {
		return "";
	}

	return formatCost(totalCost);
}

/**
 * When a web limit refills: the clock time when that is within a day, the date
 * and time when it is further out — a bare "00:29" for a reset a week away
 * reads as tonight.
 */
export function formatResetTime(resetsAt: string, now = new Date()): string {
	const at = new Date(resetsAt);
	if (Number.isNaN(at.getTime())) return "";
	const time = at.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	});
	if (at.getTime() - now.getTime() < 24 * 60 * 60 * 1000) return time;
	const date = at.toLocaleDateString([], { month: "short", day: "numeric" });
	return `${date} ${time}`;
}

function chatgptMessagesRemaining(
	providerId: string,
	status: WebSessionStatus | null | undefined,
): number | undefined {
	return providerId === "chatgpt-web" &&
		typeof status?.messagesRemaining === "number" &&
		Number.isFinite(status.messagesRemaining)
		? Math.max(0, status.messagesRemaining)
		: undefined;
}

export function formatStatusBarUsageText(input: {
	totalTokens: number;
	totalCost: number;
	providerId: string;
	maxInputTokens?: number;
	webSessionStatus?: WebSessionStatus | null;
	now?: Date;
}): string {
	const status = input.webSessionStatus;
	const resetText = status?.resetsAt
		? formatResetTime(status.resetsAt, input.now)
		: "";
	const resetSuffix = resetText ? ` · resets ${resetText}` : "";

	if (
		input.providerId === "claude-web" &&
		typeof status?.percent === "number" &&
		Number.isFinite(status.percent)
	) {
		const percent = Math.max(0, Math.min(status.percent, 100));
		return `(${Number.isInteger(percent) ? percent : percent.toFixed(1)}/100%${resetSuffix})`;
	}

	// ChatGPT Web: a token estimate against a nominal window says nothing about
	// when the session stops. Its message cap does, so show that — the count
	// ChatGPT reports after each reply, and when it refills.
	if (input.providerId === "chatgpt-web") {
		const remaining = chatgptMessagesRemaining(input.providerId, status);
		if (remaining === undefined) {
			return "(messages left: —)";
		}
		// At zero the account is not stopped, it is demoted: ChatGPT keeps
		// answering on the fallback model, which has no allowance to count. So
		// say the limit was reached rather than "0 messages left", which reads
		// like the session is over.
		if (remaining === 0) {
			return `(limit reached${resetSuffix || " · reset time unknown"})`;
		}
		return `(${remaining} message${remaining === 1 ? "" : "s"} left${resetSuffix})`;
	}

	// When the effective context limit is known, show usage as "used/total"
	// (e.g. "60k/1M") so the remaining budget is visible at a glance. Otherwise
	// fall back to the bare token count.
	const hasMaxInputTokens =
		typeof input.maxInputTokens === "number" &&
		Number.isFinite(input.maxInputTokens) &&
		input.maxInputTokens > 0;
	const maxInputTokens = hasMaxInputTokens ? input.maxInputTokens : undefined;
	const tokens = maxInputTokens
		? `(${formatTokenCount(input.totalTokens)}/${formatTokenCount(maxInputTokens)})`
		: `(${input.totalTokens.toLocaleString()})`;
	const costText = formatCostText(input.providerId, input.totalCost);

	if (!costText) {
		return tokens;
	}

	return `${tokens} ${costText}`;
}

// knownModels keys are bare IDs ("claude-sonnet-4-6") but config.modelId
// may include a provider prefix ("anthropic/claude-sonnet-4-6"), so we
// try the full ID first, then strip the prefix and retry.
function lookupModelInfo(
	modelId: string,
	knownModels?: Record<string, unknown>,
): { name?: string } | undefined {
	if (!knownModels) return undefined;
	const candidates = [modelId, modelId.split("/").pop()];
	for (const key of candidates) {
		if (!key) continue;
		const hit = knownModels[key] as { name?: string } | undefined;
		if (hit) return hit;
	}
	return undefined;
}

export function resolveModelDisplayName(config: {
	providerId?: string;
	modelId: string;
	knownModels?: Record<string, unknown>;
	thinking?: boolean;
	reasoningEffort?: string;
}): string {
	const info = lookupModelInfo(config.modelId, config.knownModels);
	const modelIdTail = config.modelId.split("/").pop() ?? config.modelId;
	let displayName = info?.name ?? modelIdTail;
	if (config.thinking && config.reasoningEffort) {
		displayName = `${displayName} (${config.reasoningEffort})`;
	}
	if (config.providerId === "cline-pass") {
		displayName = `ClinePass: ${displayName}`;
	}
	return displayName;
}

export function resolveModelMaxInputTokens(config: {
	modelId: string;
	knownModels?: Record<string, unknown>;
}): number | undefined {
	const info = (lookupModelInfo(config.modelId, config.knownModels) ?? {}) as {
		maxInputTokens?: number;
		contextWindow?: number;
	};
	if (typeof info.maxInputTokens === "number" && info.maxInputTokens > 0) {
		return info.maxInputTokens;
	}
	if (typeof info.contextWindow === "number" && info.contextWindow > 0) {
		return info.contextWindow;
	}
	return undefined;
}

export interface StatusBarProps {
	providerId: string;
	modelId: string;
	totalTokens: number;
	totalCost: number;
	maxInputTokens?: number;
	webSessionStatus?: WebSessionStatus | null;
	ttftMs?: number | null;
	tokensPerSecond?: number | null;
	uiMode: AgentMode;
	autoApproveAll: boolean;
	workspaceName: string;
	gitBranch: string | null;
	gitDiffStats: {
		files: number;
		additions: number;
		deletions: number;
	} | null;
	onToggleMode?: () => void;
	variant?: "home" | "chat";
}

export function StatusBar(props: StatusBarProps) {
	const {
		modelId,
		totalTokens,
		totalCost,
		maxInputTokens,
		webSessionStatus,
		ttftMs,
		tokensPerSecond,
		uiMode,
		autoApproveAll,
		workspaceName,
		gitBranch,
		gitDiffStats,
		onToggleMode,
	} = props;

	const { width } = useTerminalDimensions();
	const terminalBg = useTerminalBackground();
	const terminalTheme = useTerminalTheme();
	const defaultFg = getDefaultForeground(terminalBg);
	const contextBarFilledFg = resolveContextBarFilledForeground(defaultFg);
	const actAccent = getModeAccent("act", terminalTheme);
	const planAccent = getModeAccent("plan", terminalTheme);
	const successColor = getSuccessColor(terminalTheme);
	const hasMaxInputTokens =
		typeof maxInputTokens === "number" &&
		Number.isFinite(maxInputTokens) &&
		maxInputTokens > 0;
	// Claude Web has no token budget to fill a bar against, so when its session
	// percentage is known the bar tracks that instead. Otherwise the bar would
	// read ~0% off a nominal 1M window while the text beside it said 42%.
	const claudePercent =
		props.providerId === "claude-web" &&
		typeof webSessionStatus?.percent === "number" &&
		Number.isFinite(webSessionStatus.percent)
			? Math.max(0, Math.min(webSessionStatus.percent, 100))
			: undefined;
	// ChatGPT Web reports a count with no total to fill a bar against, so it
	// gets no bar at all rather than one tracking the meaningless token estimate.
	const bar =
		claudePercent !== undefined
			? createContextBar(claudePercent, 100)
			: props.providerId === "chatgpt-web"
				? undefined
				: hasMaxInputTokens
					? createContextBar(totalTokens, maxInputTokens)
					: undefined;

	// Available content width after accounting for padding.
	// Home view: parent box is capped at 60 wide, status bar adds paddingX=1 (-2).
	// Chat view: status bar adds paddingX=1 (-2).
	const avail =
		props.variant === "home"
			? Math.min(width, HOME_VIEW_MAX_WIDTH) - 2
			: width - 2;

	// Row 1 layout: [model + context info] .... [Plan/Act toggle]
	// When the full row doesn't fit, context info drops to its own row 2.
	// Model ID truncates with "..." before wrapping; toggle stays right-aligned.
	const toggleWidth = 20;
	const usageText = formatStatusBarUsageText({
		totalTokens,
		totalCost,
		providerId: props.providerId,
		maxInputTokens,
		webSessionStatus,
	});
	const contextText = bar
		? ` ${bar.filled}${bar.empty} ${usageText}`
		: ` ${usageText}`;
	const firstRowFits =
		modelId.length + contextText.length + toggleWidth + 1 <= avail;
	const renderContextText = (withLeadingSpace: boolean) => (
		<>
			{withLeadingSpace && " "}
			{bar && (
				<>
					<span fg={contextBarFilledFg}>{bar.filled}</span>
					<span fg="gray">{bar.empty}</span>{" "}
				</>
			)}
			{usageText}
		</>
	);

	const modelMaxLen = Math.max(
		10,
		avail - toggleWidth - (firstRowFits ? contextText.length : 0) - 1,
	);
	const truncatedModel =
		modelId.length > modelMaxLen
			? `${modelId.slice(0, modelMaxLen - 3)}...`
			: modelId;

	// Repo row: [workspace (branch) | N files +X -Y]
	// Git stats stay visible; path/branch truncates with "..." when narrow.
	const hasGitDiff = gitDiffStats && gitDiffStats.files > 0;
	const gitSuffix = hasGitDiff
		? ` | ${gitDiffStats.files} file${gitDiffStats.files !== 1 ? "s" : ""} +${gitDiffStats.additions} -${gitDiffStats.deletions}`
		: "";
	const pathPart = workspaceName + (gitBranch ? ` (${gitBranch})` : "");
	const pathMax = Math.max(5, avail - gitSuffix.length);
	const truncatedPath =
		pathPart.length > pathMax
			? `${pathPart.slice(0, pathMax - 3)}...`
			: pathPart;
	const speedText = formatSpeedStatsText({ ttftMs, tokensPerSecond });
	return (
		<box flexDirection="column" paddingX={1}>
			<box flexDirection="row" justifyContent="space-between">
				<text fg="gray">
					{truncatedModel}
					{firstRowFits && renderContextText(true)}
				</text>
				<box
					flexDirection="row"
					gap={1}
					flexShrink={0}
					onMouseDown={onToggleMode}
				>
					<text fg={uiMode === "plan" ? planAccent : "gray"}>
						{uiMode === "plan" ? "●" : "○"} Plan
					</text>
					<text fg={uiMode === "act" ? actAccent : "gray"}>
						{uiMode === "act" ? "●" : "○"} Act
					</text>
					<text fg="gray">(Tab)</text>
				</box>
			</box>

			{speedText && (
				<box flexDirection="row" justifyContent="flex-end">
					<text fg="gray">{speedText}</text>
				</box>
			)}

			{!firstRowFits && <text fg="gray">{renderContextText(false)}</text>}

			<text fg={defaultFg}>
				{truncatedPath}
				{hasGitDiff && (
					<span fg="gray">
						{" | "}
						{gitDiffStats.files} file
						{gitDiffStats.files !== 1 ? "s" : ""}{" "}
						<span fg={successColor}>+{gitDiffStats.additions}</span>{" "}
						<span fg="red">-{gitDiffStats.deletions}</span>
					</span>
				)}
			</text>

			{autoApproveAll ? (
				<text fg={defaultFg}>
					<span fg={successColor}>
						{"\u23f5\u23f5"} Auto-approve all enabled
					</span>
					<span fg="gray"> (Shift+Tab)</span>
				</text>
			) : (
				<text fg="gray">Auto-approve all disabled (Shift+Tab)</text>
			)}
		</box>
	);
}
