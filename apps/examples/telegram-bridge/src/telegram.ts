/**
 * Minimal Telegram Bot API client (long-polling `getUpdates` / `sendMessage`).
 *
 * Deliberately dependency-free: the bridge only needs messages, callback
 * queries (for tool approvals) and inline keyboards. We send plain text (no
 * `parse_mode`) with link previews disabled, which is the most robust way to
 * surface arbitrary model output without Telegram markdown parse failures.
 */

export interface TelegramUser {
	id: number;
	is_bot: boolean;
	first_name: string;
	username?: string;
}

export interface TelegramChat {
	id: number;
	type: string;
	title?: string;
	username?: string;
}

export interface TelegramMessage {
	message_id: number;
	chat: TelegramChat;
	from?: TelegramUser;
	date: number;
	text?: string;
}

export interface TelegramCallbackQuery {
	id: string;
	from: TelegramUser;
	message?: { message_id: number; chat: TelegramChat };
	data?: string;
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboardButton {
	text: string;
	callback_data?: string;
	url?: string;
}

export type InlineKeyboardMarkup = { inline_keyboard: InlineKeyboardButton[][] };

export interface SendMessageResult {
	message_id: number;
	chat: { id: number };
	text?: string;
}

export interface TelegramClientOptions {
	token: string;
	apiBase?: string;
	fetchImpl?: typeof fetch;
}

export class TelegramClient {
	private readonly base: string;
	private readonly fetchImpl: typeof fetch;
	/** Next `getUpdates` offset. Advances only after `acknowledge()` is called. */
	private offset = 0;

	constructor(opts: TelegramClientOptions) {
		this.fetchImpl = opts.fetchImpl ?? fetch;
		const apiBase = (opts.apiBase?.trim() || "https://api.telegram.org").replace(/\/+$/, "");
		this.base = `${apiBase}/bot${opts.token}`;
	}

	private async call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
		let res: Response;
		try {
			res = await this.fetchImpl(`${this.base}/${method}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch (error) {
			throw new Error(
				`Telegram ${method} network error: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		let data: { ok?: boolean; result?: T; description?: string };
		try {
			data = (await res.json()) as { ok?: boolean; result?: T; description?: string };
		} catch {
			throw new Error(`Telegram ${method} failed (${res.status}): non-JSON response`);
		}
		if (res.ok !== true || data.ok !== true) {
			throw new Error(
				`Telegram ${method} failed (${res.status}): ${data.description ?? "unknown error"}`,
			);
		}
		return data.result as T;
	}

	async getMe(): Promise<{ id: number; username?: string; first_name?: string }> {
		return this.call("getMe");
	}

	async fetchUpdates(timeoutSec = 30): Promise<TelegramUpdate[]> {
		return this.call<TelegramUpdate[]>("getUpdates", {
			timeout: timeoutSec,
			offset: this.offset,
			allowed_updates: ["message", "callback_query"],
		});
	}

	/** Confirm processed updates so Telegram does not redeliver them. */
	acknowledge(updates: TelegramUpdate[]): void {
		for (const update of updates) {
			if (update.update_id + 1 > this.offset) {
				this.offset = update.update_id + 1;
			}
		}
	}

	async send(
		chatId: number,
		text: string,
		opts: {
			disableLinkPreview?: boolean;
			replyMarkup?: InlineKeyboardMarkup;
			replyToMessageId?: number;
		} = {},
	): Promise<SendMessageResult> {
		return this.call<SendMessageResult>("sendMessage", {
			chat_id: chatId,
			text,
			link_preview_options: opts.disableLinkPreview === false ? undefined : { is_disabled: true },
			reply_markup: opts.replyMarkup,
			reply_to_message_id: opts.replyToMessageId,
		});
	}

	async edit(chatId: number, messageId: number, text: string): Promise<void> {
		await this.call("editMessageText", {
			chat_id: chatId,
			message_id: messageId,
			text,
			link_preview_options: { is_disabled: true },
		});
	}

	async delete(chatId: number, messageId: number): Promise<void> {
		await this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
	}

	async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
		await this.call("answerCallbackQuery", {
			callback_query_id: callbackQueryId,
			text,
		});
	}
}

/** Split long text into Telegram-safe (<= `max`) chunks. */
export function chunkText(text: string, max = 4096): string[] {
	const body = text.trim() ? text : " ";
	const chunks: string[] = [];
	for (let i = 0; i < body.length; i += max) {
		chunks.push(body.slice(i, i + max));
	}
	return chunks.length > 0 ? chunks : [" "];
}
