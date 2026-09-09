/**
 * Browser connection and CDP client for ChatGPT Web.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { claimBrowserPort } from "../tool-pipeline/browser-claims";
import {
	browserNotFoundMessage,
	findChromePath,
} from "../tool-pipeline/browser-path";
import { registerLaunchedBrowser } from "../tool-pipeline/browser-processes";
import {
	CDP_CALL_TIMEOUT_MS,
	CdpClient,
	connectCdp,
	isEndpointUp,
	waitForEndpoint,
} from "../tool-pipeline/cdp-client";
import { getPooledCdp, setPooledCdp } from "../tool-pipeline/cdp-pool";
import {
	CHATGPT_WEB_URL,
	type ChatGPTWebV2RuntimeConfig,
	CONFIG_DIR,
} from "./config";

export { CdpClient, CDP_CALL_TIMEOUT_MS };

let activeChatGPTTargetId: string | null = null;
let activeChatGPTCdpSessionId: string | null = null;
export const chatgptNetworkEnabledSessions = new Set<string>();

export async function connectBrowser(
	config: ChatGPTWebV2RuntimeConfig,
): Promise<CdpClient> {
	// Connections are pooled per port, so two sessions on two profiles each
	// keep their own socket. A single cached slot made them close each
	// other's on every turn. See tool-pipeline/cdp-pool.ts.
	const pooled = getPooledCdp<CdpClient>("chatgpt-web", config.debugPort);
	if (pooled) return pooled;

	const connectTimeoutMs = Math.max(config.launchTimeoutMs, 30000);

	if (await isEndpointUp(config.debugPort)) {
		claimBrowserPort(config.debugPort);
		const cdp = await connectCdp(
			config.debugPort,
			connectTimeoutMs,
			"chatgpt-web",
		);
		setPooledCdp("chatgpt-web", config.debugPort, cdp);
		return cdp;
	}

	const executablePath = config.chromePath ?? findChromePath();
	if (!executablePath) {
		throw new Error(
			browserNotFoundMessage(
				"~/.cline/chatgpt-web/config.json",
				"CHATGPT_WEB_CHROME_PATH",
			),
		);
	}
	const profileDir = config.profileDir ?? path.join(CONFIG_DIR, "profile");
	fs.mkdirSync(profileDir, { recursive: true });

	const args = [
		`--remote-debugging-port=${config.debugPort}`,
		`--user-data-dir=${profileDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--remote-allow-origins=*",
		CHATGPT_WEB_URL,
	];
	if (config.headless) args.push("--headless=new");

	const child = spawn(executablePath, args, {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	if (child.pid) {
		registerLaunchedBrowser({
			providerId: "chatgpt-web",
			pid: child.pid,
			debugPort: config.debugPort,
		});
	}

	try {
		await waitForEndpoint(config.debugPort, config.launchTimeoutMs);
	} catch (err) {
		throw new Error(
			`Failed to launch Chrome for ChatGPT Web: ${(err as Error).message}. ` +
				"If Chrome is already running with this profile, close it or set a different CHATGPT_WEB_PROFILE_DIR.",
		);
	}
	const cdp = await connectCdp(
		config.debugPort,
		connectTimeoutMs,
		"chatgpt-web",
	);
	setPooledCdp("chatgpt-web", config.debugPort, cdp);
	return cdp;
}

export function getActiveChatGPTTargetId(): string | null {
	return activeChatGPTTargetId;
}

export function setActiveChatGPTTargetId(id: string | null): void {
	activeChatGPTTargetId = id;
}

export function getActiveChatGPTCdpSessionId(): string | null {
	return activeChatGPTCdpSessionId;
}

export function setActiveChatGPTCdpSessionId(id: string | null): void {
	activeChatGPTCdpSessionId = id;
}
