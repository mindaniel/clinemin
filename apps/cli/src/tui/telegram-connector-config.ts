import { listActiveConnectors } from "@cline/core";
import { withConnectorStore } from "@cline/shared/db";

const TELEGRAM_CHANNEL = "telegram";

export interface TelegramConnectorConfig {
	botToken: string;
	chatId: string;
	/** Whether a Telegram connector process is running right now. */
	running: boolean;
}

/**
 * Reads the persisted Telegram connector configuration from the shared
 * SQLite connector store. Returns undefined when nothing has been saved yet,
 * so the dialog can render an empty form instead of the old hardcoded file.
 */
export function readTelegramConnectorConfig():
	| TelegramConnectorConfig
	| undefined {
	try {
		return withConnectorStore((store) => {
			const config = store.getConfig(TELEGRAM_CHANNEL);
			const running = listActiveConnectors().some(
				(record) => record.type === TELEGRAM_CHANNEL,
			);
			if (!config && !running) {
				return undefined;
			}
			return {
				botToken: config?.values.botToken ?? "",
				chatId: config?.values.chatId ?? "",
				running,
			};
		});
	} catch {
		return undefined;
	}
}

/**
 * Persists the Telegram bot token and chat id to the shared connector store.
 * Starting/stopping the live connector is handled separately by the caller so
 * the process lifecycle stays in one place.
 */
export function writeTelegramCredentials(input: {
	botToken: string;
	chatId: string;
}): void {
	const botToken = input.botToken.trim();
	const chatId = input.chatId.trim();

	withConnectorStore((store) => {
		store.upsertConfig({
			channel: TELEGRAM_CHANNEL,
			type: TELEGRAM_CHANNEL,
			values: { botToken, chatId },
		});
	});
}

/**
 * Builds the `cline connect telegram` args from saved credentials. The chat id
 * doubles as the allow-list user id so only the owner can drive the bot.
 */
export function buildTelegramConnectArgs(input: {
	botToken: string;
	chatId: string;
}): string[] {
	const args = ["-k", input.botToken.trim()];
	const chatId = input.chatId.trim();
	if (chatId) {
		args.push("--allowed-user-id", chatId);
	}
	return args;
}

export function isTelegramConnectorRunning(): boolean {
	try {
		return listActiveConnectors().some(
			(record) => record.type === TELEGRAM_CHANNEL,
		);
	} catch {
		return false;
	}
}
