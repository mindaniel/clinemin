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
import { getPooledCdp, setPooledCdp } from "../tool-pipeline/cdp-pool";
import {
	CONFIG_DIR,
	Grok_WEB_URL,
	type GrokWebV2RuntimeConfig,
} from "./config";

export { CdpClient, connectCdp, isEndpointUp, waitForEndpoint };

// ── Module-level state ─────────────────────────────────────────────────────

export async function connectBrowser(
	config: GrokWebV2RuntimeConfig,
): Promise<CdpClient> {
	// Connections are pooled per port, so two sessions on two profiles each
	// keep their own socket. A single cached slot made them close each
	// other's on every turn. See tool-pipeline/cdp-pool.ts.
	const pooled = getPooledCdp<CdpClient>("grok-web", config.debugPort);
	if (pooled) return pooled;

	const connectTimeoutMs = Math.max(config.launchTimeoutMs, 30000);

	if (await isEndpointUp(config.debugPort)) {
		// Attaching to a browser someone else launched. We do not own it and
		// must never kill it, but the claim tells whoever DOES own it not to
		// close it out from under this session. See browser-claims.ts.
		claimBrowserPort(config.debugPort);
		const cdp = await connectCdp(
			config.debugPort,
			connectTimeoutMs,
			"grok-web",
		);
		setPooledCdp("grok-web", config.debugPort, cdp);
		return cdp;
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
	const cdp = await connectCdp(config.debugPort, connectTimeoutMs, "grok-web");
	setPooledCdp("grok-web", config.debugPort, cdp);
	return cdp;
}
