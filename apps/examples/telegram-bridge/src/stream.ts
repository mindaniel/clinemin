import { TelegramClient, chunkText, type InlineKeyboardMarkup } from "./telegram.js";

/**
 * Streams one assistant turn into Telegram.
 *
 * During streaming it edits a single live "preview" message (debounced) so the
 * user sees tokens appear. When the turn finishes, `done()` deletes the preview
 * and sends the complete answer as properly chunked messages. Tool/status
 * notices are posted as separate standalone messages.
 */

const SOFT_LIMIT = 3800; // keep edits safely under Telegram's 4096-char cap

export class ReplyStreamer {
	private buffer = "";
	private pending = "";
	private currentMessageId: number | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private closed = false;

	constructor(
		private readonly tg: TelegramClient,
		private readonly chatId: number,
	) {}

	/** Append a streamed text delta and schedule a live edit. */
	stream(delta: string): void {
		if (this.closed) return;
		this.pending += delta;
		if (!this.timer) {
			this.timer = setTimeout(() => {
				this.timer = null;
				void this.flush();
			}, 600);
		}
	}

	private async flush(): Promise<void> {
		const delta = this.pending;
		this.pending = "";
		if (!delta.trim()) return;

		this.buffer += delta;
		const preview =
			this.buffer.length > SOFT_LIMIT ? this.buffer.slice(-SOFT_LIMIT) : this.buffer;

		try {
			if (this.currentMessageId === null) {
				const sent = await this.tg.send(this.chatId, preview);
				this.currentMessageId = sent.message_id;
			} else {
				await this.tg.edit(this.chatId, this.currentMessageId, preview);
			}
		} catch {
			// Message too large, edited too fast, or deleted — restart a fresh preview.
			try {
				const sent = await this.tg.send(this.chatId, preview);
				if (this.currentMessageId !== null) {
					await this.tg.delete(this.chatId, this.currentMessageId).catch(() => undefined);
				}
				this.currentMessageId = sent.message_id;
			} catch {
				// ignore — best effort streaming
			}
		}
	}

	/** Post a standalone status / tool notice. */
	async notice(text: string): Promise<void> {
		await this.tg.send(this.chatId, text).catch(() => undefined);
	}

	/** Surface an error. */
	async error(text: string): Promise<void> {
		this.close();
		await this.tg.send(this.chatId, `⚠️ ${text}`).catch(() => undefined);
	}

	/**
	 * Finalize the turn: remove the live preview and send the authoritative full
	 * answer (preferring the caller-provided final text, falling back to what was
	 * streamed).
	 */
	async done(finalText?: string): Promise<void> {
		this.close();
		if (this.pending) {
			try {
				await this.flush();
			} catch {
				// ignore
			}
		}
		const body = finalText && finalText.trim() ? finalText.trim() : this.buffer;
		if (this.currentMessageId !== null) {
			await this.tg.delete(this.chatId, this.currentMessageId).catch(() => undefined);
			this.currentMessageId = null;
		}
		if (body) {
			for (const chunk of chunkText(body)) {
				await this.tg.send(this.chatId, chunk).catch(() => undefined);
			}
		}
	}

	/** Send a message with an inline keyboard; returns its id + a responder. */
	async askApproval(
		text: string,
		keyboard: InlineKeyboardMarkup,
	): Promise<{ messageId: number; respond: (approved: boolean) => Promise<void> }> {
		const sent = await this.tg.send(this.chatId, text, { replyMarkup: keyboard });
		let responded = false;
		const respond = async (approved: boolean): Promise<void> => {
			if (responded) return;
			responded = true;
			await this.tg
				.edit(this.chatId, sent.message_id, `${text}\n\n${approved ? "✅ Approved" : "⛔ Denied"}`)
				.catch(() => undefined);
			if (!approved) {
				await this.tg.send(this.chatId, "⛔ Tool use denied.").catch(() => undefined);
			}
		};
		return { messageId: sent.message_id, respond };
	}

	private close(): void {
		this.closed = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}
}
