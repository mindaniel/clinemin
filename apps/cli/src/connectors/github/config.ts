import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { canSeal, isSealed, seal, unseal } from "./secrets";

export interface BridgeConfig {
	/** "owner/name" of the private chat repo. */
	repo: string;
	/** Token the bridge reads and writes the chat repo with. */
	token: string;
	/** GitHub logins whose issues and comments count as messages. */
	allowedUsers: string[];
	/** Only for the old standalone bridge in the minh-mobile repo; unused here. */
	clinemin?: string;
	/** Folder new chats run in. */
	cwd: string;
	/** Folders to always offer in the phone's folder picker (recent ones are added). */
	folders?: string[];
	/** Defaults to the provider/model minh used last. */
	provider?: string;
	model?: string;
	/** Run tools without asking. Off: every tool call waits for Approve on the phone. */
	autoApproveTools: boolean;
	pollSeconds: number;
	/** Show chats run in a minh window on this machine on the phone too. Default on. */
	mirrorTerminal?: boolean;
	/** How far back to pick up terminal chats, in days. Default 7. */
	mirrorDays?: number;
	/** Only for the fake GitHub in dev/. */
	apiBase?: string;
	vapid?: { publicKey: string; privateKey: string; subject: string };
}

/**
 * Where the phone bridge keeps its settings and progress. Shared with the
 * standalone bridge in the minh-mobile repo, so a setup made there carries on.
 */
export function bridgeHome(): string {
	return resolve(
		process.env.MINH_MOBILE_HOME?.trim() || join(homedir(), ".minh-mobile"),
	);
}

export const configPath = () => join(bridgeHome(), "config.json");
export const statePath = () => join(bridgeHome(), "state.json");

export function readJson<T>(path: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return fallback;
	}
}

export function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}

export function loadConfig(): BridgeConfig {
	const path = configPath();
	if (!existsSync(path)) {
		throw new Error(`No phone app setup yet (${path}). Run /setupweb in minh.`);
	}
	const raw = readJson<Partial<BridgeConfig>>(path, {});
	const missing = (["repo", "token", "cwd"] as const).filter(
		(key) => !raw[key],
	);
	if (missing.length > 0 || !raw.allowedUsers?.length) {
		throw new Error(
			`${path} is missing ${[...missing, ...(raw.allowedUsers?.length ? [] : ["allowedUsers"])].join(", ")}. Run /setupweb again.`,
		);
	}
	// Secrets left in plain text (older setups, or typed in by hand) get sealed now.
	if (
		canSeal &&
		(!isSealed(raw.token) || (raw.vapid && !isSealed(raw.vapid.privateKey)))
	) {
		writeJson(path, sealSecrets(raw));
		console.log(`Sealed the token in ${path} for this Windows account.`);
	}
	return {
		autoApproveTools: true,
		pollSeconds: 3,
		...raw,
		token: unseal(raw.token!),
		...(raw.vapid
			? { vapid: { ...raw.vapid, privateKey: unseal(raw.vapid.privateKey) } }
			: {}),
		allowedUsers: raw.allowedUsers.map((user) => user.toLowerCase()),
	} as BridgeConfig;
}

/** The saved setup with secrets still sealed, or undefined; for showing what is there. */
export function readSavedConfig(): Partial<BridgeConfig> | undefined {
	return existsSync(configPath())
		? readJson<Partial<BridgeConfig>>(configPath(), {})
		: undefined;
}

/** Write the setup, sealing its secrets. */
export function saveConfig(config: Partial<BridgeConfig>): void {
	writeJson(configPath(), sealSecrets(config));
}

/** The config as it goes on disk: token and push key sealed (see secrets.ts). */
export function sealSecrets<T extends Partial<BridgeConfig>>(config: T): T {
	return {
		...config,
		...(config.token ? { token: seal(config.token) } : {}),
		...(config.vapid
			? {
					vapid: { ...config.vapid, privateKey: seal(config.vapid.privateKey) },
				}
			: {}),
	};
}
