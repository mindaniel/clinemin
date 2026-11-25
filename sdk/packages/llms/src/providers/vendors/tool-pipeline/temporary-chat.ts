/**
 * Temporary (incognito) chats for the web providers, toggled with `/temporary`.
 *
 * On: every NEW chat a web provider opens is the site's temporary kind, so it
 * stays out of the account's history (and, where the site says so, out of
 * training). Existing chats are not touched; turning it on mid-session applies
 * from the next new chat.
 *
 * How each site starts one (checked against the live sites, Nov 2026):
 *   - chatgpt: `https://chatgpt.com/?temporary-chat=true`
 *   - claude:  `https://claude.ai/new?incognito`
 *   - qwen:    `https://chat.qwen.ai/?temporary-chat=true`
 *   - gemini:  the "Temporary chat" button (no URL form)
 *   - grok:    the "Switch to Private Chat" button (no URL form)
 *   - deepseek, kimi: no temporary mode found, so a normal chat is used and
 *              `/temporary` says so.
 *
 * Caveat: a temporary chat cannot be reopened once its tab is reloaded or the
 * browser restarts, so a session resumed later starts a new chat.
 *
 * Kept in a state file because the toggle lives in the TUI while providers run
 * in the hub process (see `process-file.ts`); providers read it per new chat.
 */

import { clineStateFile, readStateFile, writeStateFile } from "./process-file";

const PREFERENCE_FILE = "temporary-chat.json";

interface PreferenceState {
	on?: unknown;
}

export type TemporaryChatMethod = "url" | "button" | "none";

/** Which providers can open a temporary chat, and how. */
export const TEMPORARY_CHAT_SUPPORT: Record<string, TemporaryChatMethod> = {
	"chatgpt-web": "url",
	"claude-web": "url",
	"gemini-web": "button",
	"deepseek-web": "none",
	"deepseek-web-v2": "none",
	"grok-web": "button",
	"copilot-web": "button",
	"kimi-web": "none",
	"qwen-web": "url",
};

/** Whether new web chats should be temporary. */
export function readTemporaryChat(): boolean {
	const state = readStateFile<PreferenceState>(clineStateFile(PREFERENCE_FILE));
	return state?.on === true;
}

export function writeTemporaryChat(on: boolean): void {
	writeStateFile(clineStateFile(PREFERENCE_FILE), { on });
}

/** `url` for a new chat, switched to the site's temporary form when on. */
export function newChatUrl(provider: string, url: string): string {
	if (!readTemporaryChat()) return url;
	if (provider === "chatgpt-web" || provider === "qwen-web") {
		return withQuery(url, "temporary-chat=true");
	}
	if (provider === "claude-web") {
		const base = /\/new\/?$/.test(url) ? url : `${url.replace(/\/+$/, "")}/new`;
		return withQuery(base, "incognito");
	}
	return url;
}

function withQuery(url: string, query: string): string {
	return url.includes("?") ? `${url}&${query}` : `${url}?${query}`;
}

/** Button labels per site: `on` turns temporary mode on, `off` shows it is on. */
const BUTTONS: Record<string, { on: string; off: string }> = {
	"gemini-web": {
		on: "turn on temporary chat|temporary chat|bật cuộc trò chuyện tạm thời",
		off: "turn off temporary|exit temporary|tắt cuộc trò chuyện tạm thời",
	},
	"grok-web": { on: "switch to private chat", off: "exit private chat" },
	"copilot-web": {
		on: "^temporary chat$",
		off: "exit temporary chat|turn off temporary",
	},
};

/**
 * Page script that presses the site's temporary-chat button on the new-chat
 * page, unless it is already on. Evaluates to true when temporary mode is on.
 */
export function temporaryButtonScript(provider: string): string | undefined {
	const b = BUTTONS[provider];
	if (!b) return undefined;
	return `(() => {
	const label = (el) => ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '')).trim();
	const on = new RegExp(${JSON.stringify(b.on)}, 'i');
	const off = new RegExp(${JSON.stringify(b.off)}, 'i');
	const buttons = [...document.querySelectorAll('button')];
	if (buttons.some((x) => off.test(label(x)) || (on.test(label(x)) && x.getAttribute('aria-pressed') === 'true'))) return true;
	const btn = buttons.find((x) => on.test(label(x)));
	if (!btn) return false;
	btn.click();
	return true;
})()`;
}

/** The bit of a CDP client this needs (each provider has its own client type). */
interface CdpSender {
	send(method: string, params?: unknown, sessionId?: string): Promise<unknown>;
}

/**
 * `/temporary` on, for a site with a button instead of a URL: press it once the
 * new-chat page has rendered (retries while it is still loading).
 */
export async function pressTemporaryChatButton(
	provider: string,
	cdp: CdpSender,
	cdpSessionId: string,
	logger?: { debug?: (msg: string) => void },
): Promise<void> {
	const script = temporaryButtonScript(provider);
	if (!script || !readTemporaryChat()) return;
	for (let attempt = 0; attempt < 5; attempt++) {
		await new Promise((r) => setTimeout(r, 1000));
		const res = (await cdp
			.send(
				"Runtime.evaluate",
				{ expression: script, returnByValue: true },
				cdpSessionId,
			)
			.catch(() => undefined)) as { result?: { value?: unknown } } | undefined;
		if (res?.result?.value === true) {
			logger?.debug?.(`[${provider}] temporary chat on`);
			await new Promise((r) => setTimeout(r, 800));
			return;
		}
	}
	logger?.debug?.(`[${provider}] temporary chat button not found; normal chat`);
}
