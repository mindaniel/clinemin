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
	CdpClient,
	connectCdp,
	isEndpointUp,
	waitForEndpoint,
} from "../tool-pipeline/cdp-client";
import {
	CONFIG_DIR,
	Grok_WEB_URL,
	type GrokWebV2RuntimeConfig,
} from "./config";

export { CdpClient, connectCdp, isEndpointUp, waitForEndpoint };

// ── Module-level state ─────────────────────────────────────────────────────

let activeCdp: CdpClient | null = null;
let activeCdpKey: string | null = null;

export async function connectBrowser(
	config: GrokWebV2RuntimeConfig,
): Promise<CdpClient> {
	const key = `${config.debugPort}`;
	if (activeCdp && activeCdpKey === key && activeCdp.isOpen()) {
		return activeCdp;
	}
	// A different key means a different browser — `/profile` switched the
	// user-data-dir and with it the debug port. Drop the old socket rather than
	// leaking it; the Chrome behind it stays up so switching back is instant.
	if (activeCdp && activeCdpKey !== key) {
		try {
			activeCdp.close();
		} catch {
			// Already gone; nothing to release.
		}
		activeCdp = null;
		activeCdpKey = null;
	}

	const connectTimeoutMs = Math.max(config.launchTimeoutMs, 30000);

	if (await isEndpointUp(config.debugPort)) {
		// Attaching to a browser someone else launched. We do not own it and
		// must never kill it, but the claim tells whoever DOES own it not to
		// close it out from under this session. See browser-claims.ts.
		claimBrowserPort(config.debugPort);
		activeCdp = await connectCdp(
			config.debugPort,
			connectTimeoutMs,
			"grok-web",
		);
		activeCdpKey = key;
		return activeCdp;
	}

	const executablePath = config.chromePath ?? findChromePath();
	if (!executablePath) {
		throw new Error(
			browserNotFoundMessage(
				"~/.cline/grok-web/config.json",
				"Grok_WEB_CHROME_PATH",
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
		Grok_WEB_URL,
	];
	if (config.headless) args.push("--headless=new");

	const child = spawn(executablePath, args, {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	// We own this browser, so the CLI can close it on exit instead of leaving
	// it holding the debug port. See tool-pipeline/browser-processes.ts.
	if (child.pid) {
		registerLaunchedBrowser({
			providerId: "grok-web",
			pid: child.pid,
			debugPort: config.debugPort,
		});
	}

	try {
		await waitForEndpoint(config.debugPort, config.launchTimeoutMs);
	} catch (err) {
		throw new Error(
			`Failed to launch Chrome for Grok Web: ${(err as Error).message}. ` +
				"If Chrome is already running with this profile, close it or set a different Grok_WEB_PROFILE_DIR.",
		);
	}
	activeCdp = await connectCdp(config.debugPort, connectTimeoutMs, "grok-web");
	activeCdpKey = key;
	return activeCdp;
}
