import { listActiveConnectors } from "@cline/core";
import { withConnectorStore } from "@cline/shared/db";

const TELEGRAM_CHANNEL = "telegram";

export interface TelegramConnectorConfig {
	botToken: string;
	chatId: string;
	/**
	 * Whether the connector should come back on its own when Cline or the hub
	 * restarts. Without it the connector is off after every restart and has to
	 * be switched on by hand each time.
	 */
	autostart: boolean;
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
				autostart: config?.values.autostart === "true",
				running,
			};
		});
	} catch {
		return undefined;
	}
}

/**
 * Bot tokens and chat ids never contain whitespace, but a token pasted into a
 * terminal box can arrive with a space or a line break in the middle of it.
 * Stored as-is, that produces a 404 from Telegram that looks nothing like a
 * paste problem, so strip whitespace everywhere rather than only at the ends.
 */
function normalizeTelegramSecret(value: string): string {
	return value.replace(/\s+/g, "");
}

/**
 * Persists the Telegram bot token and chat id to the shared connector store.
 * Starting/stopping the live connector is handled separately by the caller so
 * the process lifecycle stays in one place.
 */
export function writeTelegramCredentials(input: {
	botToken: string;
	chatId: string;
	autostart?: boolean;
}): void {
	const botToken = normalizeTelegramSecret(input.botToken);
	const chatId = normalizeTelegramSecret(input.chatId);
	// The store holds strings, so the flag is stored as one.
	const autostart = input.autostart === true ? "true" : "false";

	withConnectorStore((store) => {
		store.upsertConfig({
			channel: TELEGRAM_CHANNEL,
			type: TELEGRAM_CHANNEL,
			values: { botToken, chatId, autostart },
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
	const args = ["-k", normalizeTelegramSecret(input.botToken)];
	const chatId = normalizeTelegramSecret(input.chatId);
	if (chatId) {
		args.push("--allowed-user-id", chatId);
	}
	return args;
}

/** The bot id is the digits before the colon in a bot token. */
export function telegramBotIdFromToken(botToken: string): string | undefined {
	const [botId] = botToken.trim().split(":", 1);
	return /^\d+$/.test(botId) ? botId : undefined;
}

export type TelegramCredentialCheck =
	| { ok: true; botId: string; username: string }
	| { ok: false; error: string };

/**
 * Ask Telegram who the saved token belongs to. Saving credentials is silent by
 * itself — a typo, a revoked token or a half-pasted string all look like
 * success — so the dialog states which bot the token actually resolves to and
 * whether it replaced a different one.
 */
export async function verifyTelegramBotToken(
	botToken: string,
	fetchImpl: typeof fetch = fetch,
): Promise<TelegramCredentialCheck> {
	const token = normalizeTelegramSecret(botToken);
	if (!token) {
		return { ok: false, error: "no bot token saved" };
	}
	try {
		const response = await fetchImpl(
			`https://api.telegram.org/bot${token}/getMe`,
		);
		const body = await response.text();
		let parsed:
			| {
					ok?: boolean;
					description?: string;
					result?: { id?: number; username?: string };
			  }
			| undefined;
		try {
			parsed = JSON.parse(body) as typeof parsed;
		} catch {
			parsed = undefined;
		}
		if (!response.ok || parsed?.ok !== true || !parsed.result?.username) {
			const detail = parsed?.description || body.trim().slice(0, 200);
			return {
				ok: false,
				error: detail
					? `${response.status} ${response.statusText}: ${detail}`
					: `${response.status} ${response.statusText}`,
			};
		}
		return {
			ok: true,
			botId: String(parsed.result.id ?? telegramBotIdFromToken(token) ?? ""),
			username: parsed.result.username,
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
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

/**
 * Shape of a Telegram bot token: `<bot id>:<secret>`. Checked before anything
 * is written, because a token that arrived mangled — a space in the middle, a
 * half-pasted secret — is otherwise indistinguishable from a good one until
 * the connector fails to start much later.
 */
const BOT_TOKEN_PATTERN = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;

export function looksLikeBotToken(value: string): boolean {
	return BOT_TOKEN_PATTERN.test(normalizeTelegramSecret(value));
}

/**
 * A token with its secret hidden, for showing which one is already saved
 * without printing it. Enough characters survive to tell two tokens apart.
 */
export function maskBotToken(value: string): string {
	const token = normalizeTelegramSecret(value);
	if (!token) return "(none)";
	const [botId, secret] = token.split(":", 2);
	if (!secret) return `${botId}… (${token.length} chars)`;
	return `${botId}:…${secret.slice(-4)} (${token.length} chars)`;
}
