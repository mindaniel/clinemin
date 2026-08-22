import { Agent } from "@cline/sdk";

/**
 * "Agent" mode — a lightweight, stateless-per-conversation runtime using the
 * SDK's `Agent.run()` / `Agent.continue()`. Best for quick Q&A over llama.cpp;
 * no built-in tools are attached (use ClineCore mode for real work).
 */

export interface AgentModeConfig {
	providerId: string;
	modelId: string;
	apiKey?: string;
	baseUrl?: string;
	systemPrompt?: string;
}

export interface AgentTurnUI {
	onDelta: (text: string) => void;
}

export class AgentMode {
	private agent: Agent | null = null;
	private started = false;
	private ui: AgentTurnUI | null = null;

	constructor(private readonly cfg: AgentModeConfig) {}

	async run(prompt: string, ui: AgentTurnUI): Promise<string> {
		this.ui = ui;
		try {
			if (!this.agent) {
				this.agent = new Agent({
					providerId: this.cfg.providerId,
					modelId: this.cfg.modelId,
					apiKey: this.cfg.apiKey,
					baseUrl: this.cfg.baseUrl,
					systemPrompt: this.cfg.systemPrompt,
				});
				this.agent.subscribe((event) => {
					if (event.type === "assistant-text-delta" && typeof event.text === "string") {
						this.ui?.onDelta(event.text);
					}
				});
			}
			const result = this.started
				? await this.agent.continue(prompt)
				: await this.agent.run(prompt);
			this.started = true;
			return result.outputText;
		} finally {
			this.ui = null;
		}
	}

	async abort(): Promise<void> {
		this.agent?.abort("Aborted by user");
	}

	async reset(): Promise<void> {
		this.agent = null;
		this.started = false;
	}

	async dispose(): Promise<void> {
		this.agent = null;
		this.started = false;
	}
}
