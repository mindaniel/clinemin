import {
	type AgentEvent,
	ClineCore,
	type CoreSessionEvent,
	type ToolApprovalRequest,
	type ToolApprovalResult,
} from "@cline/sdk";

/**
 * "ClineCore" mode — a full, persistent, tool-capable runtime (one session per
 * Telegram chat). Use it to assign real work: the model can inspect/edit files
 * and run commands, and each tool use that needs approval is surfaced to the
 * user via a Telegram inline keyboard.
 */

export interface CoreModeConfig {
	providerId: string;
	modelId: string;
	apiKey?: string;
	baseUrl?: string;
	cwd: string;
	workspaceRoot: string;
	systemPrompt?: string;
	maxIterations: number;
	enableTools: boolean;
	autoApprove: boolean;
	/** Bridged to a Telegram inline-keyboard approval prompt. */
	requestApproval: (req: ToolApprovalRequest) => Promise<ToolApprovalResult>;
}

const DEFAULT_SYSTEM_PROMPT = `You are a helpful coding assistant running through a Telegram bridge.
You can use built-in tools to inspect files, search the workspace, and run shell commands when helpful.
Be concise and report results clearly.`;

export interface CoreTurnUI {
	onDelta: (text: string) => void;
	onNotice: (text: string) => void;
}

export class CoreMode {
	enableTools: boolean;
	autoApprove: boolean;

	private cline: ClineCore | null = null;
	private sessionId: string | null = null;
	private unsubscribe: (() => void) | null = null;
	private ui: CoreTurnUI | null = null;

	constructor(
		private readonly chatId: number,
		private readonly cfg: CoreModeConfig,
	) {
		this.enableTools = cfg.enableTools;
		this.autoApprove = cfg.autoApprove;
	}

	private async ensureCline(): Promise<ClineCore> {
		if (this.cline) return this.cline;
		const cline = await ClineCore.create({
			clientName: "cline-telegram-bridge",
			backendMode: "local",
			capabilities: {
				requestToolApproval: (req) => this.cfg.requestApproval(req),
			},
		});
		this.unsubscribe = cline.subscribe((event: CoreSessionEvent) => {
			if (event.type === "agent_event") {
				this.handleAgentEvent(event.payload.event);
			}
		});
		this.cline = cline;
		return cline;
	}

	private handleAgentEvent(event: AgentEvent): void {
		const ui = this.ui;
		if (!ui) return;
		switch (event.type) {
			case "content_start":
				if (event.contentType === "text" && event.text) {
					ui.onDelta(event.text);
				} else if (event.contentType === "tool" && event.toolName) {
					ui.onNotice(`🔧 \`${event.toolName}\``);
				}
				break;
			case "content_update":
				// contentType is strictly "tool" here — text streaming arrives via
				// content_start; this event only carries tool progress, so ignore it.
				break;
			case "content_end":
				if (event.contentType === "tool" && event.error) {
					ui.onNotice(`⚠️ \`${event.toolName}\`: ${this.truncate(event.error)}`);
				}
				break;
			case "notice":
				ui.onNotice(`ℹ️ ${event.message}`);
				break;
			case "error":
				ui.onNotice(`⚠️ ${event.error?.message ?? String(event.error)}`);
				break;
		}
	}

	private async ensureSession(): Promise<string> {
		if (this.sessionId) return this.sessionId;
		const cline = await this.ensureCline();
		const started = await cline.start({
			source: "telegram",
			interactive: true,
			config: {
				cwd: this.cfg.cwd,
				workspaceRoot: this.cfg.workspaceRoot,
				providerId: this.cfg.providerId,
				modelId: this.cfg.modelId,
				apiKey: this.cfg.apiKey,
				baseUrl: this.cfg.baseUrl,
				systemPrompt: this.cfg.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
				maxIterations: this.cfg.maxIterations,
				enableTools: this.enableTools,
				mode: "act",
				enableSpawnAgent: false,
				enableAgentTeams: false,
				disableMcpSettingsTools: true,
			},
			toolPolicies: this.autoApprove
				? { "*": { autoApprove: true } }
				: {
						read_files: { autoApprove: true },
						search_codebase: { autoApprove: true },
					},
		});
		this.sessionId = started.sessionId;
		return this.sessionId;
	}

	async run(prompt: string, ui: CoreTurnUI): Promise<string> {
		this.ui = ui;
		try {
			const sessionId = await this.ensureSession();
			const result = await this.cline!.send({ sessionId, prompt });
			return result?.text ?? "";
		} finally {
			this.ui = null;
		}
	}

	setTools(enabled: boolean): void {
		this.enableTools = enabled;
	}

	setAutoApprove(value: boolean): void {
		this.autoApprove = value;
	}

	async abort(): Promise<void> {
		if (this.sessionId && this.cline) {
			await this.cline.abort(this.sessionId).catch(() => undefined);
		}
	}

	async reset(): Promise<void> {
		if (this.sessionId && this.cline) {
			await this.cline.stop(this.sessionId).catch(() => undefined);
		}
		this.sessionId = null;
	}

	async getRecentMessages(count: number = 10): Promise<string> {
		if (!this.cline || !this.sessionId) {
			return "No active session.";
		}
		try {
			const messages = await this.cline.readMessages(this.sessionId);
			const recent = messages.slice(-count);
			if (recent.length === 0) return "No messages in this session yet.";

			const formatted = recent
				.map((msg: any) => {
					const role = msg.role === "user" ? "👤 You" : "🤖 Assistant";
					let content = "";
					if (typeof msg.content === "string") {
						content = msg.content;
					} else if (Array.isArray(msg.content)) {
						content = msg.content
							.map((c: any) => (typeof c === "string" ? c : c.text || ""))
							.join("");
					} else {
						content = String(msg.content || "");
					}
					const maxLen = 800;
					const truncated =
						content.length > maxLen
							? content.slice(0, maxLen) + "..."
							: content;
					return `${role}:\n\`\`\`\n${truncated}\n\`\`\``;
				})
				.join("\n");

			return `Last ${Math.min(count, recent.length)} messages:\n\n${formatted}`;
		} catch (error) {
			return `Failed to read messages: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	async dispose(): Promise<void> {
		await this.reset();
		if (this.unsubscribe) {
			try {
				this.unsubscribe();
			} catch {
				// ignore
			}
			this.unsubscribe = null;
		}
		if (this.cline) {
			await this.cline
				.dispose("telegram-bridge shutdown")
				.catch(() => undefined);
			this.cline = null;
		}
	}

	private truncate(value: string, max = 240): string {
		return value.length > max ? `${value.slice(0, max)}…` : value;
	}
}
