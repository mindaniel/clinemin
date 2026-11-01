/**
 * What chat.deepseek.com knows about the signed-in account: the name the site
 * gives each chat, and the account's email.
 *
 * Both come from the site's own JSON API, called from inside the page with the
 * page's token, so nothing here handles credentials itself:
 *
 *  - `chat_session/fetch_page` lists chats newest first with their `title`
 *    (what the sidebar shows). `/findchat` and history show it instead of a
 *    timestamp and a first prompt like ".".
 *  - `users/current` returns the email MASKED (`q***@st-andrews.ac.uk`). The
 *    full address only exists in the login form, so `/login` watches the form
 *    and keeps what was typed when it matches the masked one.
 */

import {
	describeBrowserProfile,
	getActiveBrowserProfile,
	listBrowserProfiles,
	setBrowserProfileAccount,
} from "../tool-pipeline/browser-profiles";
import { readBrowserVersion } from "../tool-pipeline/browser-visibility";
import {
	CdpClient,
	connectBrowser,
	ensureDeepSeekPage,
	isEndpointUp,
	withTimeout,
} from "./browser";
import { listRegistrySessionIds, setChatTitles } from "./chat-registry";
import { resolveDeepSeekWebV2Config, sleep } from "./config";

type Cdp = Pick<CdpClient, "send">;

/**
 * GET one site API path from inside the page and return its `biz_data`, or
 * `undefined` when signed out or the call fails. The token never leaves the
 * page: only the response body comes back.
 */
export async function deepSeekApiGet(
	cdp: Cdp,
	cdpSessionId: string,
	apiPath: string,
): Promise<unknown> {
	const expression = `(async () => {
		try {
			const raw = localStorage.getItem("userToken");
			const token = raw ? JSON.parse(raw).value : "";
			if (!token) return null;
			const res = await fetch(${JSON.stringify(apiPath)}, {
				headers: { authorization: "Bearer " + token },
			});
			if (!res.ok) return null;
			const body = await res.json();
			return body && body.data ? body.data.biz_data ?? null : null;
		} catch {
			return null;
		}
	})()`;
	try {
		const res = await cdp.send(
			"Runtime.evaluate",
			{ expression, awaitPromise: true, returnByValue: true },
			cdpSessionId,
		);
		return res?.result?.value ?? undefined;
	} catch {
		return undefined;
	}
}

interface ChatSessionPage {
	chat_sessions?: Array<{
		id?: string;
		title?: string;
		pinned?: boolean;
		updated_at?: number;
	}>;
	has_more?: boolean;
}

/**
 * Site chat titles by `session_id`, newest chats first. Stops once every id in
 * `wanted` is found, the list ends, or `maxPages` pages have been read.
 */
export async function fetchChatTitles(
	cdp: Cdp,
	cdpSessionId: string,
	options: {
		wanted?: ReadonlySet<string>;
		maxPages?: number;
		pageSize?: number;
	} = {},
): Promise<Map<string, string>> {
	const { wanted, maxPages = 5, pageSize = 100 } = options;
	const titles = new Map<string, string>();
	let cursor = "";
	for (let page = 0; page < maxPages; page++) {
		const data = (await deepSeekApiGet(
			cdp,
			cdpSessionId,
			`/api/v0/chat_session/fetch_page?count=${pageSize}${cursor}`,
		)) as ChatSessionPage | undefined;
		const sessions = data?.chat_sessions ?? [];
		for (const session of sessions) {
			if (session.id && session.title?.trim()) {
				titles.set(session.id, session.title.trim());
			}
		}
		if (wanted && [...wanted].every((id) => titles.has(id))) break;
		const last = sessions.at(-1);
		if (!data?.has_more || last?.updated_at === undefined) break;
		// Pinned chats come first, so a cursor past them must say `pinned=false`
		// or the site hands back the first page again.
		cursor = `&lte_cursor.pinned=false&lte_cursor.updated_at=${last.updated_at}`;
	}
	return titles;
}

/** The account's email as the site reports it (masked), or its phone number. */
export async function fetchAccountEmail(
	cdp: Cdp,
	cdpSessionId: string,
): Promise<string | undefined> {
	const data = (await deepSeekApiGet(
		cdp,
		cdpSessionId,
		"/api/v0/users/current",
	)) as { email?: string; mobile_number?: string } | undefined;
	const value = data?.email?.trim() || data?.mobile_number?.trim();
	return value || undefined;
}

/**
 * True when `email` could be what the site masked into `masked`: every
 * visible character in place, each run of `*` standing for at least one.
 */
export function matchesMaskedEmail(email: string, masked: string): boolean {
	const pattern = masked
		.split(/\*+/)
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(".+");
	return new RegExp(`^${pattern}$`, "i").test(email.trim());
}

/**
 * After a turn: store the current chat's site title, and the profile's
 * account if none is known yet. Best-effort and off the turn's critical path;
 * the site names a new chat a moment after the first reply, hence the delay.
 */
export async function captureChatMetadata(input: {
	cdp: Cdp;
	cdpSessionId: string;
	chatsFile: string;
	chatSessionId: string;
	delayMs?: number;
}): Promise<void> {
	const { cdp, cdpSessionId, chatsFile, chatSessionId } = input;
	try {
		await sleep(input.delayMs ?? 4_000);
		const titles = await fetchChatTitles(cdp, cdpSessionId, {
			wanted: new Set([chatSessionId]),
			maxPages: 1,
			pageSize: 30,
		});
		const title = titles.get(chatSessionId);
		if (title) setChatTitles(chatsFile, new Map([[chatSessionId, title]]));
		await recordProfileAccountOnce(cdp, cdpSessionId);
	} catch {
		// Display data only; never let it disturb a conversation.
	}
}

const accountChecked = new Set<string>();

async function recordProfileAccountOnce(
	cdp: Cdp,
	cdpSessionId: string,
): Promise<void> {
	const profile = getActiveBrowserProfile();
	if (accountChecked.has(profile)) return;
	accountChecked.add(profile);
	if (listBrowserProfiles().find((entry) => entry.name === profile)?.account) {
		return;
	}
	const email = await fetchAccountEmail(cdp, cdpSessionId);
	if (email) setBrowserProfileAccount(profile, email);
}

/**
 * Fetch site titles for every chat in the active profile's registry and store
 * them. Only when DeepSeek's browser is already running: `/findchat` should not
 * launch Chrome just to decorate a list. Returns how many titles changed.
 */
export async function refreshDeepSeekChatTitles(
	timeoutMs = 10_000,
): Promise<number> {
	try {
		const config = resolveDeepSeekWebV2Config();
		if (!(await isEndpointUp(config.debugPort))) return 0;
		const wanted = new Set(listRegistrySessionIds(config.chatsFile));
		if (wanted.size === 0) return 0;
		return await withTimeout(
			(async () => {
				const cdp = await connectBrowser(config);
				const { sessionId } = await ensureDeepSeekPage(cdp);
				const titles = await fetchChatTitles(cdp, sessionId, { wanted });
				return setChatTitles(config.chatsFile, titles);
			})(),
			timeoutMs,
		);
	} catch {
		return 0;
	}
}

/**
 * Watch the `/login` window until the user is signed in, then record the
 * account on `profile`: the email typed into the login form when it matches
 * the masked one the site reports, else the masked one. Resolves with the
 * profile's display name (`name (email)`) once recorded, or `undefined` if the
 * window closes or `timeoutMs` passes first.
 */
export async function watchDeepSeekLogin(input: {
	profile: string;
	debugPort: number;
	timeoutMs?: number;
	intervalMs?: number;
	signal?: AbortSignal;
}): Promise<string | undefined> {
	const { profile, debugPort, signal } = input;
	const deadline = Date.now() + (input.timeoutMs ?? 10 * 60_000);
	const intervalMs = input.intervalMs ?? 1_500;
	let cdp: CdpClient | undefined;
	let attached: { targetId: string; sessionId: string } | undefined;
	let sawBrowser = false;
	let typed: string | undefined;
	try {
		while (Date.now() < deadline && !signal?.aborted) {
			await sleep(intervalMs);
			const version = await readBrowserVersion(debugPort);
			if (!version?.wsUrl) {
				// Closed after it was seen: the user is done with it.
				if (sawBrowser) return undefined;
				continue;
			}
			sawBrowser = true;
			try {
				if (!cdp?.isOpen()) {
					cdp = new CdpClient(version.wsUrl);
					await cdp.waitOpen();
					attached = undefined;
				}
				const { targetInfos } = await cdp.send("Target.getTargets");
				const page = (
					targetInfos as Array<{ type: string; url: string; targetId: string }>
				).find(
					(target) =>
						target.type === "page" && target.url.includes("chat.deepseek.com"),
				);
				if (!page) continue;
				if (attached?.targetId !== page.targetId) {
					const { sessionId } = await cdp.send("Target.attachToTarget", {
						targetId: page.targetId,
						flatten: true,
					});
					attached = { targetId: page.targetId, sessionId };
				}
				const state = await cdp.send(
					"Runtime.evaluate",
					{
						expression: `(() => {
							const email = [...document.querySelectorAll("input")]
								.map((el) => el.value.trim())
								.find((v) => /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(v));
							return {
								email: email || null,
								signedIn: !!localStorage.getItem("userToken") &&
									!/sign_in|login/.test(location.pathname),
							};
						})()`,
						returnByValue: true,
					},
					attached.sessionId,
				);
				const value = state?.result?.value as
					| { email: string | null; signedIn: boolean }
					| undefined;
				if (value?.email) typed = value.email;
				if (!value?.signedIn) continue;
				const masked = await fetchAccountEmail(cdp, attached.sessionId);
				if (!masked) continue;
				const account =
					typed && matchesMaskedEmail(typed, masked) ? typed : masked;
				setBrowserProfileAccount(profile, account);
				const entry = listBrowserProfiles().find((p) => p.name === profile);
				return entry ? describeBrowserProfile(entry) : undefined;
			} catch {
				// Mid-navigation or a reload; the next tick tries again.
				attached = undefined;
			}
		}
		return undefined;
	} finally {
		cdp?.close();
	}
}
