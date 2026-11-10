/**
 * The GitHub bridge's side of the minh hub: start, revive and switch
 * sessions, run turns, and relay approvals. Same hub calls as the Telegram
 * connector, without its chat-SDK layer.
 */

import { mkdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
	HubSessionClient,
	listLocalProviders,
	ProviderSettingsManager,
} from "@cline/core";
import { resolveSystemPrompt } from "../../runtime/prompt";
import { ensureCliHubServer } from "../../utils/hub-runtime";
import type { BridgeConfig } from "./config";
import { folderChoices, isFolder, recentFolders } from "./folders";
import type { ChatOptions } from "./protocol";

export interface ResolvedOptions {
	provider: string;
	model: string;
	mode: "act" | "plan";
	autoApprove: boolean;
	cwd: string;
}

/** Published to .minh/options.json for the phone's settings sheet. */
export interface OptionsCatalog {
	defaults?: ResolvedOptions;
	/** Folders to offer: the default, config.json's, then recently used ones. */
	folders: string[];
	providers: Array<{
		id: string;
		name: string;
		/** The model minh last used with this provider. */
		model?: string;
		models: Array<{ id: string; name: string }>;
	}>;
}

export interface HubEvent {
	sessionId: string;
	eventType: string;
	payload: Record<string, unknown>;
}

export interface TurnResult {
	text: string;
	finishReason?: string;
	error?: string;
}

type StartRequest = Parameters<HubSessionClient["startRuntimeSession"]>[0];
type Messages = Awaited<ReturnType<HubSessionClient["readMessages"]>>;

/** What the bridge needs from the hub; tests stand in a fake. */
export interface BridgeHub {
	hubUrl: string;
	connect(): Promise<void>;
	close(): void;
	onEvent(listener: (event: HubEvent) => void): () => void;
	resolve(options?: ChatOptions): ResolvedOptions;
	catalog(): Promise<OptionsCatalog>;
	startSession(
		title: string,
		issue: number,
		options?: ChatOptions,
		from?: string,
	): Promise<string>;
	ensureLive(sessionId: string, options?: ChatOptions): Promise<boolean>;
	send(
		sessionId: string,
		prompt: string,
		mode?: "act" | "plan",
	): Promise<TurnResult>;
	abort(sessionId: string): Promise<unknown>;
	release(sessionId: string): Promise<void>;
	respondApproval(
		approvalId: string,
		approved: boolean,
		reason?: string,
	): Promise<void>;
}

const PHONE_RULES =
	"The user is chatting from a phone app. Keep replies readable on a small screen: short paragraphs, and code blocks only when they help.";

export class Hub implements BridgeHub {
	private client!: HubSessionClient;
	private readonly listeners = new Set<(event: HubEvent) => void>();
	private unsubscribe?: () => void;
	hubUrl = "";

	constructor(private readonly config: BridgeConfig) {}

	async connect(): Promise<void> {
		const hub = await ensureCliHubServer(this.config.cwd);
		this.hubUrl = hub.url;
		this.client = new HubSessionClient({
			address: hub.url,
			authToken: hub.authToken,
			clientId: `github-${process.pid}-${Date.now()}`,
			clientType: "cli",
			displayName: "phone app (GitHub)",
			workspaceRoot: this.config.cwd,
			cwd: this.config.cwd,
			metadata: { transport: "github", repo: this.config.repo },
		});
		await this.client.connect();
		this.unsubscribe = this.client.streamEvents(
			{},
			{
				onEvent: (event) => {
					for (const listener of this.listeners) listener(event);
				},
				onError: (error) => console.warn("hub event stream:", error.message),
			},
		);
	}

	close(): void {
		this.unsubscribe?.();
		this.client?.close();
	}

	onEvent(listener: (event: HubEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * What a chat runs with: its own picks first, then config.json, then the
	 * provider/model minh used last. A provider picked without a model gets the
	 * model minh last used with it. A relative folder is inside the default one.
	 */
	resolve(options: ChatOptions = {}): ResolvedOptions {
		const manager = new ProviderSettingsManager();
		const last = manager.getLastUsedProviderSettings({
			isClinePassEnabled: true,
		});
		const provider = options.provider || this.config.provider || last?.provider;
		let model = options.model;
		if (!model && provider) {
			model =
				provider === (this.config.provider || last?.provider)
					? this.config.model || last?.model
					: manager.getProviderSettings(provider)?.model;
		}
		if (!provider || !model) {
			throw new Error(
				options.provider
					? `No model picked for ${options.provider}. Pick one in the app.`
					: "No provider/model yet. Chat once in minh first, or pick one in the app.",
			);
		}
		const cwd = resolvePath(this.config.cwd, options.cwd || ".");
		if (!isFolder(cwd)) {
			if (!options.createFolder) {
				throw new Error(
					`Folder not found on the server: ${cwd}. Pick "Create it if missing" to make it.`,
				);
			}
			mkdirSync(cwd, { recursive: true });
			console.log(`made folder ${cwd}`);
		}
		return {
			provider,
			model,
			mode: options.mode ?? "act",
			autoApprove: options.autoApprove ?? this.config.autoApproveTools,
			cwd,
		};
	}

	/** The providers set up in minh, with their models, and folders to offer. Never keys. */
	async catalog(): Promise<OptionsCatalog> {
		const manager = new ProviderSettingsManager();
		const { providers } = await listLocalProviders(manager, {
			isClinePassEnabled: true,
		});
		let defaults: ResolvedOptions | undefined;
		try {
			defaults = this.resolve();
		} catch {}
		return {
			defaults,
			folders: folderChoices(
				this.config.cwd,
				this.config.folders,
				recentFolders(),
			),
			providers: providers
				.filter(
					(provider) => provider.enabled || provider.id === defaults?.provider,
				)
				.map((provider) => ({
					id: provider.id,
					name: provider.name,
					model:
						manager.getProviderSettings(provider.id)?.model ||
						provider.defaultModelId,
					models: (provider.modelList ?? [])
						.slice(0, 300)
						.map((model) => ({ id: model.id, name: model.name || model.id })),
				})),
		};
	}

	private async startRequest(options?: ChatOptions): Promise<StartRequest> {
		const { provider, model, mode, autoApprove, cwd } = this.resolve(options);
		return {
			workspaceRoot: cwd,
			cwd,
			provider,
			model,
			mode,
			// No key: the hub uses the one minh saved for this provider. It must be
			// undefined, not "": the hub falls back with `??`.
			apiKey: undefined,
			systemPrompt: await resolveSystemPrompt({
				cwd,
				providerId: provider,
				rules: PHONE_RULES,
				mode,
			}),
			enableTools: true,
			enableSpawn: true,
			enableTeams: true,
			autoApproveTools: autoApprove,
			source: "github",
			interactive: true,
		} as unknown as StartRequest;
	}

	/**
	 * A new session for a chat. With `from`, it carries that session's
	 * conversation over (a new model, folder or tool setting mid-chat), and the
	 * old session is let go.
	 */
	async startSession(
		title: string,
		issue: number,
		options?: ChatOptions,
		from?: string,
	): Promise<string> {
		const request = await this.startRequest(options);
		let resume: { sessionId: string; initialMessages: Messages } | undefined;
		if (from) {
			resume = {
				initialMessages: await this.client.readMessages(from),
			} as unknown as typeof resume;
			await this.client.stopRuntimeSession(from).catch(() => undefined);
		}
		const started = await this.client.startRuntimeSession(request, resume);
		await this.client
			.updateSession({
				sessionId: started.sessionId,
				metadata: {
					title,
					transport: "github",
					githubIssue: issue,
					repo: this.config.repo,
				},
			})
			.catch(() => undefined);
		return started.sessionId;
	}

	/**
	 * Make sure the session can take a turn: running in the hub already, or
	 * started back up from its transcript (after a hub or bridge restart).
	 * Returns false when it no longer exists.
	 */
	async ensureLive(sessionId: string, options?: ChatOptions): Promise<boolean> {
		const row = (await this.client.listSessions({ limit: 500 })).find(
			(candidate) => candidate.sessionId === sessionId,
		);
		if (!row) return false;
		if (row.live) return true;
		if (row.heldByPid) {
			throw new Error(
				`this chat is open in a minh window (pid ${row.heldByPid}). Close it there first.`,
			);
		}
		// Back up with what the chat picked, or else what the session last ran with.
		const meta = row.metadata ?? {};
		const fallback: ChatOptions = {
			provider: typeof meta.provider === "string" ? meta.provider : undefined,
			model: typeof meta.model === "string" ? meta.model : undefined,
		};
		const request = await this.startRequest(
			options?.provider ? options : { ...options, ...fallback },
		);
		await this.client.startRuntimeSession(request, {
			sessionId,
			initialMessages: await this.client.readMessages(sessionId),
		});
		return true;
	}

	/** Runs one turn and resolves when it ends. Progress arrives through onEvent. */
	async send(
		sessionId: string,
		prompt: string,
		mode: "act" | "plan" = "act",
	): Promise<TurnResult> {
		const reply = await this.client.sendSessionInput(
			sessionId,
			{ prompt, mode },
			{ timeoutMs: null },
		);
		const result = reply.result as
			| { text?: string; finishReason?: string }
			| undefined;
		return {
			text: typeof result?.text === "string" ? result.text : "",
			finishReason: result?.finishReason,
			error:
				result?.finishReason === "error"
					? String(result.text || "The run failed.")
					: undefined,
		};
	}

	/** Stop running a session; its transcript stays, so it can come back. */
	async release(sessionId: string): Promise<void> {
		await this.client.stopRuntimeSession(sessionId).catch(() => undefined);
	}

	abort(sessionId: string): Promise<unknown> {
		return this.client.abortRuntimeSession(sessionId);
	}

	respondApproval(
		approvalId: string,
		approved: boolean,
		reason?: string,
	): Promise<void> {
		return this.client.respondToolApproval({ approvalId, approved, reason });
	}
}
