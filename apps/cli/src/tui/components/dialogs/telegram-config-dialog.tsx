import type { ChoiceContext } from "@opentui-ui/dialog";
import { useDialogKeyboard } from "@opentui-ui/dialog/react";
import { useState } from "react";
import { palette } from "../../palette";
import {
	looksLikeBotToken,
	maskBotToken,
	type TelegramConnectorConfig,
} from "../../telegram-connector-config";

export interface TelegramConfigDialogResult {
	botToken: string;
	chatId: string;
	/** Desired live state: true = start/keep running, false = stop. */
	running: boolean;
	/** Bring the connector back by itself when Cline (or the hub) restarts. */
	autostart: boolean;
}

type Field = "token" | "chat" | "toggle" | "autostart";

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
	const savedToken = initial?.botToken ?? "";
	// The token field starts EMPTY even when one is saved. Pre-filling it meant
	// a paste landed inside the old value instead of replacing it, producing a
	// hybrid string that is the right length and completely wrong — which
	// Telegram then rejects with a 401 long after the dialog said "saved".
	// Empty means "keep the saved one".
	const [botToken, setBotToken] = useState("");
	const [chatId, setChatId] = useState(initial?.chatId ?? "");
	const [running, setRunning] = useState(initial?.running ?? false);
	const [autostart, setAutostart] = useState(initial?.autostart ?? false);
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
			// One ordered ring, so adding a row does not mean rewriting the
			// nested conditionals this used to be.
			const order: Field[] = ["token", "chat", "toggle", "autostart"];
			setField((prev) => {
				const index = order.indexOf(prev);
				const next = key.shift
					? (index - 1 + order.length) % order.length
					: (index + 1) % order.length;
				return order[next];
			});
			return;
		}
		if (field === "autostart") {
			if (key.name === "space") {
				setAutostart((prev) => !prev);
				return;
			}
			if (key.name === "return") {
				save();
			}
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
		const enteredToken = botToken.trim();
		const effectiveToken = enteredToken || savedToken;
		if (!effectiveToken) {
			setError("Bot token is required.");
			setField("token");
			return;
		}
		// Validate what will actually be stored, including a token kept from a
		// previous save — that is exactly the case that went bad silently.
		if (!looksLikeBotToken(effectiveToken)) {
			setError(
				`That does not look like a bot token (got ${effectiveToken.replace(/\s+/g, "").length} characters; expected <bot id>:<secret>). Re-paste it.`,
			);
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
			botToken: effectiveToken,
			chatId: chatId.trim(),
			running,
			autostart,
		});
	}

	return (
		<box flexDirection="column" paddingX={1} gap={1}>
			<text>Telegram connector</text>

			<box flexDirection="column" gap={0}>
				<text fg={palette.muted}>
					Bot token
					{savedToken
						? ` — saved: ${maskBotToken(savedToken)}, leave empty to keep`
						: ""}
				</text>
				<box
					border
					borderStyle="rounded"
					borderColor={field === "token" ? palette.selection : palette.muted}
					paddingX={1}
				>
					<input
						value={botToken}
						onInput={setBotToken}
						placeholder={
							savedToken
								? "empty = keep saved token; paste to replace"
								: "7123456789:AAH..."
						}
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

			<box
				paddingX={1}
				backgroundColor={field === "autostart" ? palette.selection : undefined}
				onMouseDown={() => setAutostart((prev) => !prev)}
			>
				<text fg={field === "autostart" ? palette.textOnSelection : undefined}>
					{autostart ? "[x]" : "[ ]"} Start automatically when Cline starts
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
