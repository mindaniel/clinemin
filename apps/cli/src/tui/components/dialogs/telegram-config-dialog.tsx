import type { ChoiceContext } from "@opentui-ui/dialog";
import { useDialogKeyboard } from "@opentui-ui/dialog/react";
import { useState } from "react";
import { palette } from "../../palette";
import type { TelegramConnectorConfig } from "../../telegram-connector-config";

export interface TelegramConfigDialogResult {
	botToken: string;
	chatId: string;
	/** Desired live state: true = start/keep running, false = stop. */
	running: boolean;
}

type Field = "token" | "chat" | "toggle";

/**
 * Dialog content for `/telegram`: enter or update the Bot Token and Chat ID,
 * and turn the connector on or off. Nothing is written until Enter is pressed
 * on the Save row, so a mistake can be corrected without touching the store.
 */
export function TelegramConfigDialogContent(
	props: ChoiceContext<TelegramConfigDialogResult | null> & {
		initial: TelegramConnectorConfig | undefined;
	},
) {
	const { resolve, dismiss, dialogId, initial } = props;
	const [botToken, setBotToken] = useState(initial?.botToken ?? "");
	const [chatId, setChatId] = useState(initial?.chatId ?? "");
	const [running, setRunning] = useState(initial?.running ?? false);
	const [field, setField] = useState<Field>("token");
	const [error, setError] = useState<string | null>(null);

	useDialogKeyboard((key) => {
		if (key.name === "escape") {
			dismiss();
			return;
		}
		// Tab / Shift+Tab cycle between the two text fields and the toggle.
		if (key.name === "tab") {
			setError(null);
			setField((prev) =>
				key.shift
					? prev === "toggle"
						? "chat"
						: prev === "chat"
							? "token"
							: "toggle"
					: prev === "token"
						? "chat"
						: prev === "chat"
							? "toggle"
							: "token",
			);
			return;
		}
		if (field === "toggle") {
			if (key.name === "space" || key.name === "return") {
				setRunning((prev) => !prev);
				return;
			}
			// Enter on the toggle both flips it and saves; space only flips.
			if (key.name === "s") {
				save();
			}
			return;
		}
		if (key.name === "return") {
			if (field === "token") {
				setField("chat");
				return;
			}
			save();
		}
	}, dialogId);

	function save() {
		if (!botToken.trim()) {
			setError("Bot token is required.");
			setField("token");
			return;
		}
		if (running && !/^\d+$/.test(chatId.trim())) {
			setError(
				"Chat ID must be numeric to restrict access (or turn the connector off).",
			);
			setField("chat");
			return;
		}
		resolve({
			botToken: botToken.trim(),
			chatId: chatId.trim(),
			running,
		});
	}

	return (
		<box flexDirection="column" paddingX={1} gap={1}>
			<text>Telegram connector</text>

			<box flexDirection="column" gap={0}>
				<text fg={palette.muted}>Bot token</text>
				<box
					border
					borderStyle="rounded"
					borderColor={field === "token" ? palette.selection : palette.muted}
					paddingX={1}
				>
					<input
						value={botToken}
						onInput={setBotToken}
						placeholder="7123456789:AAH..."
						flexGrow={1}
						focused={field === "token"}
					/>
				</box>
			</box>

			<box flexDirection="column" gap={0}>
				<text fg={palette.muted}>Chat ID (your numeric Telegram user ID)</text>
				<box
					border
					borderStyle="rounded"
					borderColor={field === "chat" ? palette.selection : palette.muted}
					paddingX={1}
				>
					<input
						value={chatId}
						onInput={setChatId}
						placeholder="123456789"
						flexGrow={1}
						focused={field === "chat"}
					/>
				</box>
			</box>

			<box
				paddingX={1}
				backgroundColor={field === "toggle" ? palette.selection : undefined}
				onMouseDown={() => setRunning((prev) => !prev)}
			>
				<text fg={field === "toggle" ? palette.textOnSelection : undefined}>
					{running ? "[x]" : "[ ]"} Telegram connector{" "}
					{running ? "ON (running)" : "OFF (stopped)"}
				</text>
			</box>

			{error ? <text fg={palette.error}>{error}</text> : null}

			<text fg={palette.muted}>
				<em>
					Tab to move, Space to toggle the switch, Enter to save, Esc to cancel
				</em>
			</text>
		</box>
	);
}
