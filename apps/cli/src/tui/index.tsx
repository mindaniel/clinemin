import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { Root } from "./root";
import { installTuiStdioCapture } from "./stdio-capture";
import type { TuiProps } from "./types";

export type { TuiProps } from "./types";

/**
 * Ask the terminal to bracket pastes, and take a way to write that is immune to
 * the stdio capture installed a moment later.
 *
 * OpenTUI parses `ESC [ 200~` ... `ESC [ 201~` and turns it into a PasteEvent,
 * but it never turns the mode on, and most terminals only send those markers
 * when the application asks. Without the request a paste arrives as ordinary
 * keystrokes, which breaks two things: the input bar's large-paste handling
 * (`onPaste` never fires) and every dialog built on `useDialogKeyboard`, which
 * is a global key listener — the first newline in the pasted text reads as
 * Enter and submits the dialog with only the first line in it.
 *
 * The writer is bound before `installTuiStdioCapture` replaces
 * `process.stdout.write` with a sink, so the disable on teardown still reaches
 * the terminal after the capture is torn down.
 */
function enableBracketedPaste(): () => void {
	const write = process.stdout.write.bind(process.stdout);
	write("\x1b[?2004h");
	let disabled = false;
	return () => {
		if (disabled) return;
		disabled = true;
		write("\x1b[?2004l");
	};
}

export async function renderOpenTui(
	props: TuiProps,
): Promise<{ destroy: () => void; waitUntilExit: () => Promise<void> }> {
	const renderer = await createCliRenderer({
		exitOnCtrlC: false,
		autoFocus: false,
		enableMouseMovement: true,
	});
	const disableBracketedPaste = enableBracketedPaste();
	const restoreStdio = installTuiStdioCapture();

	const detectedPalette = await renderer
		.getPalette({ timeout: 150 })
		.catch(() => null);
	const terminalBackground = detectedPalette?.defaultBackground ?? null;
	const terminalForeground = detectedPalette?.defaultForeground ?? null;

	let root: ReturnType<typeof createRoot>;
	try {
		root = createRoot(renderer);
		root.render(
			<Root
				{...props}
				terminalBackground={terminalBackground}
				terminalForeground={terminalForeground}
			/>,
		);
	} catch (error) {
		restoreStdio();
		disableBracketedPaste();
		renderer.destroy();
		throw error;
	}

	let resolveExit: (() => void) | undefined;
	const exitPromise = new Promise<void>((resolve) => {
		resolveExit = resolve;
	});

	let unmounted = false;
	const unmountRoot = () => {
		if (unmounted) {
			return;
		}
		unmounted = true;
		root.unmount();
	};

	renderer.on("destroy", () => {
		unmountRoot();
		restoreStdio();
		disableBracketedPaste();
		resolveExit?.();
	});

	let destroyStarted = false;
	const destroy = () => {
		if (destroyStarted) {
			return;
		}
		destroyStarted = true;
		unmountRoot();
		// Let OpenTUI finish parsing the current stdin batch before teardown.
		queueMicrotask(() => {
			// Reset the title while the native renderer is still alive; the
			// unmount cleanup in root.tsx skips it once the renderer is destroyed.
			// Re-check here: OpenTUI's own signal handlers can destroy the
			// renderer between destroy() queuing this microtask and it running
			// (e.g. an idle SIGTERM dispatches to both our handler and OpenTUI's).
			if (!renderer.isDestroyed) {
				renderer.setTerminalTitle("");
			}
			renderer.destroy();
		});
	};

	return {
		destroy,
		waitUntilExit: () => exitPromise,
	};
}
