import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import {
	CLINE_HUB_DEV_PORT,
	CLINE_HUB_PORT,
	resolveClineBuildEnv,
} from "@cline/shared";

const HUB_HOST_ENV = "CLINE_HUB_HOST";
const HUB_PORT_ENV = "CLINE_HUB_PORT";
const HUB_PATHNAME_ENV = "CLINE_HUB_PATHNAME";

export const DEFAULT_HUB_HOST = "127.0.0.1";
export const DEFAULT_HUB_PORT = CLINE_HUB_PORT;
export const DEFAULT_HUB_PATHNAME = "/hub";

export interface HubEndpointOverrides {
	host?: string;
	port?: number;
	pathname?: string;
}

export interface ResolveHubDefaultsOptions {
	env?: NodeJS.ProcessEnv;
	execArgv?: string[];
	/** OS account the default port is derived for; the current one if unset. */
	username?: string;
}

// Ports per user stay 10 apart so a user's production and dev hubs (3 apart)
// never land on another user's, and below 32768 where Linux starts handing
// out ephemeral ports.
const HUB_PORT_USER_STRIDE = 10;
const HUB_PORT_USER_SLOTS = 700;

function currentUsername(env: NodeJS.ProcessEnv): string {
	try {
		return userInfo().username;
	} catch {
		return env.USERNAME || env.USER || "";
	}
}

/**
 * How far this OS user's default hub port sits above the base port. Every
 * user on a machine shares 127.0.0.1, so one fixed port would make each
 * user's CLI find (and try to use or stop) somebody else's hub.
 */
export function hubPortUserOffset(username: string): number {
	if (!username) {
		return 0;
	}
	const slot =
		createHash("sha256")
			.update(username.toLowerCase())
			.digest()
			.readUInt32BE(0) % HUB_PORT_USER_SLOTS;
	return slot * HUB_PORT_USER_STRIDE;
}

function fallbackHubPort(options: ResolveHubDefaultsOptions): number {
	const base =
		resolveClineBuildEnv(options) === "development"
			? CLINE_HUB_DEV_PORT
			: DEFAULT_HUB_PORT;
	const username =
		options.username ?? currentUsername(options.env ?? process.env);
	return base + hubPortUserOffset(username);
}

export function resolveDefaultHubHost(
	options: ResolveHubDefaultsOptions = {},
): string {
	const env = options.env ?? process.env;
	return env[HUB_HOST_ENV]?.trim() || DEFAULT_HUB_HOST;
}

export function resolveDefaultHubPort(
	options: ResolveHubDefaultsOptions = {},
): number {
	const env = options.env ?? process.env;
	const raw = env[HUB_PORT_ENV]?.trim();
	if (!raw) {
		return fallbackHubPort(options);
	}
	const port = Number.parseInt(raw, 10);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		return fallbackHubPort(options);
	}
	return port;
}

export function resolveDefaultHubPathname(
	options: ResolveHubDefaultsOptions = {},
): string {
	const env = options.env ?? process.env;
	return env[HUB_PATHNAME_ENV]?.trim() || DEFAULT_HUB_PATHNAME;
}

export function resolveHubEndpointOptions(
	overrides: HubEndpointOverrides = {},
	options: ResolveHubDefaultsOptions = {},
): Required<HubEndpointOverrides> {
	return {
		host: overrides.host ?? resolveDefaultHubHost(options),
		port: overrides.port ?? resolveDefaultHubPort(options),
		pathname: overrides.pathname ?? resolveDefaultHubPathname(options),
	};
}
