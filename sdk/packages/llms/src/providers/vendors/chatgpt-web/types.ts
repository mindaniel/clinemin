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
	limits_progress?: Array<{
		featureName: string;
		remaining: number;
		resetAfter: string;
	}>;
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
