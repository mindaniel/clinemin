import { useTerminalDimensions } from "@opentui/react";
import { useSyncExternalStore } from "react";
import "opentui-spinner/react";
import { palette } from "../palette";

/**
 * A small corner notice for work that runs in the background, such as
 * llama-server loading a model. Unlike a loading dialog it takes no focus, so
 * the rest of the TUI stays usable while it shows. Set from anywhere with
 * `setBackgroundNotice`; `null` hides it.
 */
let notice: string | null = null;
const listeners = new Set<() => void>();

export function setBackgroundNotice(message: string | null): void {
	if (message === notice) return;
	notice = message;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function BackgroundNotice() {
	const message = useSyncExternalStore(subscribe, () => notice);
	const { width } = useTerminalDimensions();

	if (!message) {
		return null;
	}

	return (
		<box
			position="absolute"
			zIndex={90}
			top={1}
			right={width < 32 ? 0 : 2}
			maxWidth={Math.min(48, Math.max(1, width - 4))}
			flexDirection="row"
			gap={1}
			border
			borderStyle="rounded"
			borderColor={palette.selection}
			paddingX={1}
		>
			<spinner name="dots" color={palette.selection} />
			<text fg="gray" wrapMode="word">
				{message}
			</text>
		</box>
	);
}
