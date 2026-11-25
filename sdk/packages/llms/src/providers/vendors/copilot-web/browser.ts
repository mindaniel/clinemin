import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { claimBrowserPort } from "../tool-pipeline/browser-claims";
import {
	browserNotFoundMessage,
	findChromePath,
	NO_BROWSER_SIGNIN_ARG,
	prepareBrowserProfile,
} from "../tool-pipeline/browser-path";
import { registerLaunchedBrowser } from "../tool-pipeline/browser-processes";
import {
	closeBrowserIfModeChanged,
	resolveHeadless,
} from "../tool-pipeline/browser-visibility";
import {
	CdpClient,
	connectCdp,
	isEndpointUp,
	waitForEndpoint,
} from "../tool-pipeline/cdp-client";
import {
	dropPooledCdp,
	getPooledCdp,
	setPooledCdp,
} from "../tool-pipeline/cdp-pool";
import {
	CONFIG_DIR,
	COPILOT_WEB_URL,
	type CopilotWebV2RuntimeConfig,
} from "./config";

export { CdpClient, connectCdp, isEndpointUp, waitForEndpoint };

// ── Module-level state ─────────────────────────────────────────────────────

export async function connectBrowser(
	config: CopilotWebV2RuntimeConfig,
): Promise<CdpClient> {
	// Connections are pooled per port, so two sessions on two profiles each
	// keep their own socket. A single cached slot made them close each
	// other's on every turn. See tool-pipeline/cdp-pool.ts.
	// Tab in the TUI switched hidden/visible: restart Chrome in the new mode.
	if (await closeBrowserIfModeChanged(config.debugPort)) {
		dropPooledCdp("copilot-web", config.debugPort);
	}
	const pooled = getPooledCdp<CdpClient>("copilot-web", config.debugPort);
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
			"copilot-web",
		);
		setPooledCdp("copilot-web", config.debugPort, cdp);
		return cdp;
	}

	const executablePath = config.chromePath ?? findChromePath();
	if (!executablePath) {
		throw new Error(
			browserNotFoundMessage(
				"~/.cline/copilot-web/config.json",
				"COPILOT_WEB_CHROME_PATH",
			),
		);
	}
	const profileDir = config.profileDir ?? path.join(CONFIG_DIR, "profile");
	fs.mkdirSync(profileDir, { recursive: true });
	prepareBrowserProfile(profileDir);

	const args = [
		`--remote-debugging-port=${config.debugPort}`,
		`--user-data-dir=${profileDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		NO_BROWSER_SIGNIN_ARG,
		"--remote-allow-origins=*",
		COPILOT_WEB_URL,
	];
	if (resolveHeadless(config.headless)) args.push("--headless=new");

	const child = spawn(executablePath, args, {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	// We own this browser, so the CLI can close it on exit instead of leaving
	// it holding the debug port. See tool-pipeline/browser-processes.ts.
	if (child.pid) {
		registerLaunchedBrowser({
			providerId: "copilot-web",
			pid: child.pid,
			debugPort: config.debugPort,
		});
	}

	try {
		await waitForEndpoint(config.debugPort, config.launchTimeoutMs);
	} catch (err) {
		throw new Error(
			`Failed to launch Chrome for Copilot Web: ${(err as Error).message}. ` +
				"If Chrome is already running with this profile, close it or set a different COPILOT_WEB_PROFILE_DIR.",
		);
	}
	const cdp = await connectCdp(
		config.debugPort,
		connectTimeoutMs,
		"copilot-web",
	);
	setPooledCdp("copilot-web", config.debugPort, cdp);
	return cdp;
}
