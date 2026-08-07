import "opentui-spinner/react";
import type { AgentMode, ClineSubscriptionPlan } from "@cline/core";
import type { ScrollBoxRenderable } from "@opentui/core";
import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import type { TranscriptCommand } from "../hooks/transcript-keybinds";
import { useTerminalTheme } from "../hooks/use-terminal-background";
import { getModeAccent } from "../palette";
import type { ChatEntry } from "../types";
import { ChatEntryView } from "./chat-entry";

export interface TranscriptScrollHandle {
	runTranscriptCommand: (command: TranscriptCommand) => void;
}

interface ChatMessageListProps {
	entries: ChatEntry[];
	isStreaming?: boolean;
	loadIndividualSubscriptionPlans?: () => Promise<ClineSubscriptionPlan[]>;
	uiMode?: AgentMode;
}

// Ticks up while `active` is true so the "Thinking..." line visibly counts,
// proving the run is alive rather than stuck.
function useElapsedSeconds(active: boolean): number {
	const startedAtRef = useRef<number | null>(null);
	const [elapsedSec, setElapsedSec] = useState(0);

	useEffect(() => {
		if (!active) {
			startedAtRef.current = null;
			setElapsedSec(0);
			return;
		}
		startedAtRef.current = Date.now();
		setElapsedSec(0);
		const id = setInterval(() => {
			const startedAt = startedAtRef.current;
			if (startedAt !== null) {
				setElapsedSec((Date.now() - startedAt) / 1000);
			}
		}, 200);
		return () => clearInterval(id);
	}, [active]);

	return elapsedSec;
}

export const ChatMessageList = forwardRef<
	TranscriptScrollHandle,
	ChatMessageListProps
>(function ChatMessageList(props, ref) {
	const scrollboxRef = useRef<ScrollBoxRenderable | null>(null);
	const lastEntry = props.entries.at(-1);
	const terminalTheme = useTerminalTheme();
	const accent = getModeAccent(props.uiMode ?? "act", terminalTheme);
	const userSubmissionScrollKey =
		lastEntry?.kind === "user_submitted" ? props.entries.length : 0;
	const thinkingElapsedSec = useElapsedSeconds(!!props.isStreaming);

	const runTranscriptCommand = useCallback((command: TranscriptCommand) => {
		const scrollbox = scrollboxRef.current;
		if (!scrollbox) return;

		switch (command) {
			case "messages_page_up":
				scrollbox.scrollBy(-scrollbox.height / 2);
				return;
			case "messages_page_down":
				scrollbox.scrollBy(scrollbox.height / 2);
				return;
			case "messages_half_page_up":
				scrollbox.scrollBy(-scrollbox.height / 4);
				return;
			case "messages_half_page_down":
				scrollbox.scrollBy(scrollbox.height / 4);
				return;
			case "messages_first":
				scrollbox.scrollTo(0);
				return;
			case "messages_last":
				scrollbox.scrollTo(scrollbox.scrollHeight);
				return;
		}
	}, []);

	useImperativeHandle(
		ref,
		() => ({
			runTranscriptCommand,
		}),
		[runTranscriptCommand],
	);

	useEffect(() => {
		if (!userSubmissionScrollKey) return;

		const scrollToBottom = () => {
			const scrollbox = scrollboxRef.current;
			if (!scrollbox) return;

			scrollbox.scrollTo(scrollbox.scrollHeight);
		};

		scrollToBottom();
		queueMicrotask(scrollToBottom);
		const timeout = setTimeout(scrollToBottom, 0);
		return () => clearTimeout(timeout);
	}, [userSubmissionScrollKey]);

	return (
		<scrollbox
			ref={scrollboxRef}
			flexGrow={1}
			stickyScroll
			stickyStart="bottom"
		>
			<box flexDirection="column" paddingX={1} paddingY={1} gap={1}>
				{props.entries.map((entry, i) => {
					const key = `${i}:${entry.kind}`;
					// Single source of truth for the entry's mode: the glyph accent
					// and the markdown accent must never diverge.
					const entryMode = entry.mode ?? props.uiMode ?? "act";
					return (
						<ChatEntryView
							key={key}
							entry={entry}
							accent={getModeAccent(entryMode, terminalTheme)}
							mode={entryMode === "plan" ? "plan" : "act"}
							loadIndividualSubscriptionPlans={
								props.loadIndividualSubscriptionPlans
							}
							terminalTheme={terminalTheme}
						/>
					);
				})}
				{props.isStreaming && (
					<box flexDirection="row" gap={1}>
						<spinner name="dots" color={accent} />
						<text fg="gray">
							Thinking... {thinkingElapsedSec.toFixed(1)}s (esc to cancel)
						</text>
					</box>
				)}
			</box>
		</scrollbox>
	);
});
