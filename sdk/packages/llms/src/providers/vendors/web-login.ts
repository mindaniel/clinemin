/**
 * `/login` for the web providers: open the provider's Chrome, visible, on its
 * site, so a first-time user can sign in before sending anything.
 *
 * Without this the only way to reach the login page was to send a prompt and
 * let the turn launch Chrome, then sign in while the turn waited, which does
 * not work at all when the browser is set to hidden.
 *
 * Uses the same user-data-dir and debug port the provider resolves for the
 * active profile, so the login lands where the next turn looks for it. A
 * hidden browser already on that port is closed first; the provider's next
 * turn restarts it hidden again if that is the preference (see
 * `tool-pipeline/browser-visibility.ts`), with the new login in the profile.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	CHATGPT_WEB_URL,
	resolveChatGPTWebV2Config,
} from "./chatgpt-web/config";
import { CLAUDE_WEB_URL, resolveClaudeWebV2Config } from "./claude-web/config";
import {
	DEEPSEEK_WEB_URL,
	resolveDeepSeekWebV2Config,
} from "./deepseek-web-v2/config";
import { GEMINI_WEB_URL, resolveGeminiWebV2Config } from "./gemini-web/config";
import { Grok_WEB_URL, resolveGrokWebV2Config } from "./grok-web/config";
import { Kimi_WEB_URL, resolveKimiWebV2Config } from "./kimi-web/config";
import { QWEN_WEB_URL, resolveQwenWebV2Config } from "./qwen-web/config";
import {
	browserNotFoundMessage,
	findChromePath,
} from "./tool-pipeline/browser-path";
import { getActiveBrowserProfile } from "./tool-pipeline/browser-profiles";
import {
	closeBrowser,
	readBrowserVersion,
} from "./tool-pipeline/browser-visibility";

interface LoginTarget {
	name: string;
	url: string;
	envPrefix: string;
	resolve: () => {
		chromePath?: string;
		profileDir?: string;
		debugPort: number;
	};
}

const LOGIN_TARGETS: Record<string, LoginTarget> = {
	"deepseek-web-v2": {
		name: "DeepSeek",
		url: DEEPSEEK_WEB_URL,
		envPrefix: "DEEPSEEK_WEB_V2",
		resolve: resolveDeepSeekWebV2Config,
	},
	"qwen-web": {
		name: "Qwen",
		url: QWEN_WEB_URL,
		envPrefix: "QWEN_WEB",
		resolve: resolveQwenWebV2Config,
	},
	"chatgpt-web": {
		name: "ChatGPT",
		url: CHATGPT_WEB_URL,
		envPrefix: "CHATGPT_WEB",
		resolve: resolveChatGPTWebV2Config,
	},
	"claude-web": {
		name: "Claude",
		url: CLAUDE_WEB_URL,
		envPrefix: "CLAUDE_WEB",
		resolve: resolveClaudeWebV2Config,
	},
	"gemini-web": {
		name: "Gemini",
		url: GEMINI_WEB_URL,
		envPrefix: "GEMINI_WEB",
		resolve: resolveGeminiWebV2Config,
	},
	"kimi-web": {
		name: "Kimi",
		url: Kimi_WEB_URL,
		envPrefix: "Kimi_WEB",
		resolve: resolveKimiWebV2Config,
	},
	"grok-web": {
		name: "Grok",
		url: Grok_WEB_URL,
		envPrefix: "Grok_WEB",
		resolve: resolveGrokWebV2Config,
	},
};

export function isWebLoginProvider(providerId: string): boolean {
	return providerId in LOGIN_TARGETS;
}

export interface WebLoginResult {
	/** Provider display name, e.g. "DeepSeek". */
	name: string;
	url: string;
	profile: string;
	/** "launched": a new window; "focused": a visible one was already open. */
	outcome: "launched" | "focused";
}

/** Open a tab on `url` in the visible Chrome on `port` and bring it forward. */
async function openTab(port: number, url: string): Promise<void> {
	const res = await fetch(
		`http://127.0.0.1:${port}/json/new?${encodeURI(url)}`,
		{ method: "PUT", signal: AbortSignal.timeout(3_000) },
	);
	const target = (await res.json().catch(() => undefined)) as
		| { id?: string }
		| undefined;
	if (target?.id) {
		await fetch(`http://127.0.0.1:${port}/json/activate/${target.id}`, {
			signal: AbortSignal.timeout(3_000),
		}).catch(() => undefined);
	}
}

export async function openWebProviderLogin(
	providerId: string,
): Promise<WebLoginResult> {
	const target = LOGIN_TARGETS[providerId];
	if (!target) {
		throw new Error(`"${providerId}" is not a browser-driven web provider.`);
	}
	const config = target.resolve();
	const result = {
		name: target.name,
		url: target.url,
		profile: getActiveBrowserProfile(),
	};

	const running = await readBrowserVersion(config.debugPort);
	if (running?.wsUrl && !running.userAgent.includes("HeadlessChrome")) {
		await openTab(config.debugPort, target.url);
		return { ...result, outcome: "focused" };
	}
	if (running?.wsUrl) {
		// Hidden: a login page there cannot be seen, so restart it visible.
		await closeBrowser(config.debugPort, running.wsUrl);
	}

	const executablePath = config.chromePath ?? findChromePath();
	if (!executablePath) {
		throw new Error(
			browserNotFoundMessage(
				`~/.cline/${providerId}/config.json`,
				`${target.envPrefix}_CHROME_PATH`,
			),
		);
	}
	const profileDir =
		config.profileDir ??
		path.join(os.homedir(), ".cline", providerId, "profile");
	fs.mkdirSync(profileDir, { recursive: true });
	// Not registered with browser-processes: the user closes this window when
	// done, and it must outlive the CLI process that opened it.
	spawn(
		executablePath,
		[
			`--remote-debugging-port=${config.debugPort}`,
			`--user-data-dir=${profileDir}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--remote-allow-origins=*",
			target.url,
		],
		{ detached: true, stdio: "ignore" },
	).unref();
	return { ...result, outcome: "launched" };
}
