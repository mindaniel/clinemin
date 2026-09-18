/**
 * Common types for ChatGPT Web provider.
 */

import type { LanguageModelV2CallOptions } from "@ai-sdk/provider";

/** CDP Target info from Target.getTargets */
export interface TargetInfo {
	targetId: string;
	type: string;
	url?: string;
	title?: string;
	attached?: boolean;
	canAccessOpaqueOrigin?: boolean;
}

/** ChatGPT SSE event structure */
export interface ChatGPTSSEEvent {
	o?: string; // operation: "patch", "append"
	v?:
		| string
		| {
				message?: {
					author?: { role?: string };
					content?: string | { parts?: string[] };
				};
		  };
	message?: {
		author?: { role?: string };
		content?: string | { parts?: string[] };
	};
	content?: string;
	text?: string;
	type?: string;
	/** Raw wire shape, snake_case — see `consumeChatGPTSse`. */
	limits_progress?: Array<{
		feature_name?: string;
		remaining?: number;
		reset_after?: string;
	}> | null;
	/**
	 * Present once a model's cap is reached: the metered model and when it
	 * frees up. ChatGPT stops sending `limits_progress` at the same moment, so
	 * this is the only place the reset time survives.
	 */
	model_limits?: Array<{
		model_slug?: string;
		resets_after?: string;
	}> | null;
	/** Features currently locked out, each with its own reset time. */
	blocked_features?: Array<{
		name?: string;
		resets_after?: string;
		resets_after_text?: string;
	}> | null;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		total_tokens?: number;
		prompt_tokens?: number;
		completion_tokens?: number;
	};
}

/** Extended call options with experimental context */
export interface ChatGPTWebCallOptions extends LanguageModelV2CallOptions {
	experimental_context?: {
		reInjectSystemPrompt?: boolean;
		preserveCompactionContext?: boolean;
		think?: boolean;
		model?: string | null;
	};
}
