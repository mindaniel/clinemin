import * as os from "node:os";

/**
 * Confirmation that the built-in connector — not some other bot, and not an
 * older copy running elsewhere — has come up and is talking to this chat.
 *
 * Two bots answering the same token look identical from Telegram's side: the
 * only way to tell which process is live, and which checkout it was started
 * from, is to have the process say so itself. Everything here is chosen to
 * answer "is this the right one?": who the bot is, what version it is, which
 * machine and pid it runs as, and what workspace it will act on.
 */
export interface TelegramStartupNoticeInput {
	botUsername: string;
	cliVersion: string;
	pid: number;
	rpcAddress: string;
	cwd: string;
	provider?: string;
	model?: string;
	mode: string;
	enableTools: boolean;
	hostname?: string;
	startedAt?: Date;
}

const TELEGRAM_API_BASE = "https://api.telegram.org";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function buildTelegramStartupNotice(
	input: TelegramStartupNoticeInput,
): string {
	const startedAt = (input.startedAt ?? new Date()).toISOString();
	const host = input.hostname ?? os.hostname();
	const model = [input.provider, input.model].filter(Boolean).join("/");
	return [
		"Cline connector online.",
		"",
		`source: cline connect telegram (built-in connector, v${input.cliVersion})`,
		`bot: @${input.botUsername}`,
		`host: ${host} pid ${input.pid}`,
		`cwd: ${input.cwd}`,
		`model: ${model || "(default)"}`,
		`mode: ${input.mode}, tools ${input.enableTools ? "on" : "off"}`,
		`rpc: ${input.rpcAddress}`,
		`started: ${startedAt}`,
		"",
		"Reply here to start a session. /help lists the commands.",
	].join("\n");
}

/**
 * Post the notice straight to the Bot API rather than through the chat
 * adapter: at startup there is no thread yet, and a direct call also proves
 * the token and chat id are a working pair. Never throws — a connector that
 * cannot announce itself should still run.
 */
export async function sendTelegramStartupNotice(input: {
	botToken: string;
	chatId: string;
	text: string;
	apiBaseUrl?: string;
	fetchImpl?: FetchLike;
}): Promise<{ ok: true } | { ok: false; error: string }> {
	const fetchImpl = input.fetchImpl ?? fetch;
	const apiBaseUrl = (input.apiBaseUrl?.trim() || TELEGRAM_API_BASE).replace(
		/\/+$/,
		"",
	);
	try {
		const response = await fetchImpl(
			`${apiBaseUrl}/bot${input.botToken}/sendMessage`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					chat_id: input.chatId,
					text: input.text,
					link_preview_options: { is_disabled: true },
				}),
			},
		);
		const body = await response.text();
		let parsed: { ok?: boolean; description?: string } | undefined;
		try {
			parsed = JSON.parse(body) as { ok?: boolean; description?: string };
		} catch {
			parsed = undefined;
		}
		if (!response.ok || parsed?.ok !== true) {
			const detail = parsed?.description || body.trim().slice(0, 240);
			return {
				ok: false,
				error: detail
					? `Telegram sendMessage failed (${response.status} ${response.statusText}): ${detail}`
					: `Telegram sendMessage failed (${response.status} ${response.statusText})`,
			};
		}
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
