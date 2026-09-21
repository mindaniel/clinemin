/**
 * Make sure a web provider's tab is really on the saved chat before sending.
 *
 * Every provider reopens an old chat by pointing the tab at its URL and
 * waiting a fixed moment. Nothing checked that the tab got there. When it did
 * not — a tab opened a second earlier whose own start-up routing overrode
 * ours, a slow load — the message was typed into whatever composer was
 * showing, which is an empty new chat. The model answered with no history,
 * and the provider then saved that new chat's id over the old one, so the old
 * conversation was also lost for every later turn.
 *
 * So: confirm the address bar names the chat. If it does not, navigate again,
 * this time with a real browser navigation. If it still does not, stop. An
 * error the user can see is better than a reply from a model that has
 * silently forgotten the whole conversation.
 */

import type { BasicLogger } from "@cline/shared";

/** Just the part of a CDP client this needs, so every vendor's client fits. */
type CdpClient = {
	send(method: string, params?: unknown, sessionId?: string): Promise<any>;
};

export class ChatNotReachableError extends Error {
	constructor(provider: string, chatId: string, landedOn: string) {
		super(
			`[${provider}] could not open the saved chat ${chatId} (the tab is on ${landedOn || "an unknown page"}). ` +
				"Not sending into a new chat, which would lose this conversation's history. " +
				"Check the chat still exists and the browser is signed in to the same account, then send again — or use /findchat to pick a different chat.",
		);
		this.name = "ChatNotReachableError";
	}
}

async function readUrl(cdp: CdpClient, cdpSessionId: string): Promise<string> {
	try {
		const res = await cdp.send(
			"Runtime.evaluate",
			{ expression: "window.location.href", returnByValue: true },
			cdpSessionId,
		);
		return typeof res.result?.value === "string" ? res.result.value : "";
	} catch {
		return "";
	}
}

/** True when `url` is the page for `chatId` — its id is a whole path segment. */
export function urlNamesChat(url: string, chatId: string): boolean {
	if (!url || !chatId) return false;
	try {
		return new URL(url).pathname
			.split("/")
			.some((segment) => segment === chatId);
	} catch {
		return false;
	}
}

async function waitForChatUrl(
	cdp: CdpClient,
	cdpSessionId: string,
	chatId: string,
	timeoutMs: number,
	sleepImpl: (ms: number) => Promise<unknown>,
): Promise<{ ok: boolean; url: string }> {
	const deadline = Date.now() + timeoutMs;
	let url = await readUrl(cdp, cdpSessionId);
	while (!urlNamesChat(url, chatId) && Date.now() < deadline) {
		await sleepImpl(250);
		url = await readUrl(cdp, cdpSessionId);
	}
	return { ok: urlNamesChat(url, chatId), url };
}

export async function confirmChatLocation(input: {
	cdp: CdpClient;
	cdpSessionId: string;
	provider: string;
	/** The saved chat's id, as it appears in its URL path. */
	chatId: string;
	/** The saved chat's full URL, used to navigate again. */
	chatUrl: string;
	/** The provider's own "composer is usable" wait, re-run after navigating. */
	waitReady: () => Promise<void>;
	logger?: BasicLogger;
	sleepImpl?: (ms: number) => Promise<unknown>;
}): Promise<void> {
	const sleepImpl =
		input.sleepImpl ??
		((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
	const first = await waitForChatUrl(
		input.cdp,
		input.cdpSessionId,
		input.chatId,
		3_000,
		sleepImpl,
	);
	if (first.ok) return;

	input.logger?.log(
		`[${input.provider}] tab is on ${first.url || "an unknown page"}, not saved chat ${input.chatId} — navigating again`,
		{ severity: "warn" },
	);
	try {
		await input.cdp.send(
			"Page.navigate",
			{ url: input.chatUrl },
			input.cdpSessionId,
		);
	} catch {
		await input.cdp
			.send(
				"Runtime.evaluate",
				{
					expression: `window.location.href = ${JSON.stringify(input.chatUrl)}`,
				},
				input.cdpSessionId,
			)
			.catch(() => undefined);
	}
	await sleepImpl(1_500);
	await input.waitReady();
	const second = await waitForChatUrl(
		input.cdp,
		input.cdpSessionId,
		input.chatId,
		8_000,
		sleepImpl,
	);
	if (second.ok) {
		input.logger?.log(
			`[${input.provider}] reopened saved chat ${input.chatId}`,
		);
		return;
	}
	throw new ChatNotReachableError(input.provider, input.chatId, second.url);
}
