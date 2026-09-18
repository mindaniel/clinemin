import type {
	LanguageModelV2,
	LanguageModelV2CallOptions,
	LanguageModelV2FinishReason,
	LanguageModelV2FunctionTool,
	LanguageModelV2Prompt,
	LanguageModelV2StreamPart,
} from "@ai-sdk/provider";
import type {
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
} from "@cline/shared";
import { ensureFetch } from "../../http";
import { parseFallbackToolUses } from "../deepseek-web-v2";
import { validateToolCalls } from "../tool-pipeline/tool-dispatcher";
import type { ProviderFactoryResult } from "../types";
import { extractUserToken, runCompletion } from "./client";
import {
	type DeepSeekWebUsageEstimate,
	estimateDeepSeekWebUsage,
} from "./config";
import { buildPrompt } from "./prompt";
import {
	type ParsedToolCall,
	parseDeepSeekToolCalls,
	parseLooseDeepSeekToolCalls,
} from "./tool-parsing";

function lastUserText(prompt: LanguageModelV2Prompt): string {
	for (let i = prompt.length - 1; i >= 0; i--) {
		const message = prompt[i];
		if (message.role !== "user") continue;
		const content = Array.isArray(message.content)
			? message.content
					.map((block) => ("text" in block ? block.text : ""))
					.join("\n")
			: message.content;
		return typeof content === "string" ? content.trim() : "";
	}
	return "";
}

function finishReasonFor(
	text: string,
	toolCalls: ParsedToolCall[],
): LanguageModelV2FinishReason {
	return toolCalls.length > 0 ? "tool-calls" : text ? "stop" : "unknown";
}

// ── LanguageModelV2 adapter ────────────────────────────────────────────────

function createDeepSeekWebModel(
	modelId: string,
	config: GatewayResolvedProviderConfig,
	fetchImpl: typeof fetch,
): LanguageModelV2 {
	const userToken = extractUserToken(config.apiKey);

	const doCompletion = async (
		options: LanguageModelV2CallOptions,
		onText?: (text: string) => void,
		onReasoning?: (text: string) => void,
	): Promise<{
		text: string;
		reasoning: string;
		toolCalls: ParsedToolCall[];
		usage: DeepSeekWebUsageEstimate;
	}> => {
		if (!userToken) {
			throw new Error(
				"Missing userToken — paste the value from DevTools → Application → Local Storage → chat.deepseek.com → userToken",
			);
		}
		const functionTools = (options.tools ?? []).filter(
			(tool): tool is LanguageModelV2FunctionTool => tool.type === "function",
		);
		const prompt = buildPrompt(options.prompt, functionTools);
		const { text, reasoning, accumulatedTokenUsage } = await runCompletion({
			userToken,
			modelId,
			prompt,
			fetchImpl,
			signal: options.abortSignal,
			onText,
			onReasoning,
		});
		// Prefer DeepSeek's cumulative context-token count when reported;
		// otherwise fall back to the chars/3 estimate.
		const estimated = estimateDeepSeekWebUsage(prompt, `${text}${reasoning}`);
		const usage: DeepSeekWebUsageEstimate =
			accumulatedTokenUsage !== undefined
				? {
						inputTokens: accumulatedTokenUsage,
						outputTokens: estimated.outputTokens,
						totalTokens: accumulatedTokenUsage + estimated.outputTokens,
					}
				: estimated;

		if (functionTools.length === 0) {
			return { text, reasoning, toolCalls: [], usage };
		}

		const toolNames = functionTools.map((t) => t.name);
		// Recovery ladder, mirroring deepseek-web-v2: strict `<tool>` blocks
		// first, then loose tags, then the plain-prose fallback so a web reply
		// that ignores the `<tool>` contract still produces real tool calls.
		const { cleanedContent, toolCalls } = parseDeepSeekToolCalls(
			text,
			toolNames,
		);
		if (toolCalls.length > 0) {
			const { tools: validated, retryPrompt } = validateToolCalls(toolCalls);
			return {
				text: retryPrompt
					? `${cleanedContent}\n\n${retryPrompt}`.trim()
					: cleanedContent,
				reasoning,
				toolCalls: validated,
				usage,
			};
		}
		const loose = parseLooseDeepSeekToolCalls(text, toolNames);
		if (loose.length > 0) {
			const { tools: validated, retryPrompt } = validateToolCalls(loose);
			return {
				text: retryPrompt
					? `${cleanedContent}\n\n${retryPrompt}`.trim()
					: cleanedContent,
				reasoning,
				toolCalls: validated,
				usage,
			};
		}
		const fallback = parseFallbackToolUses(
			cleanedContent,
			lastUserText(options.prompt),
			toolNames,
		);
		return {
			text: fallback.cleanedText,
			reasoning,
			toolCalls: fallback.toolUses,
			usage,
		};
	};

	return {
		specificationVersion: "v2",
		provider: "deepseek-web",
		modelId,
		supportedUrls: {},
		doGenerate: async (options) => {
			const { text, reasoning, toolCalls, usage } = await doCompletion(options);
			const content: Array<
				| { type: "text"; text: string }
				| { type: "reasoning"; text: string }
				| {
						type: "tool-call";
						toolCallId: string;
						toolName: string;
						input: string;
				  }
			> = [];
			if (reasoning) content.push({ type: "reasoning", text: reasoning });
			if (text) content.push({ type: "text", text });
			for (let i = 0; i < toolCalls.length; i++) {
				content.push({
					type: "tool-call",
					toolCallId: `call-${Date.now()}-${i}`,
					toolName: toolCalls[i].name,
					input: JSON.stringify(toolCalls[i].arguments),
				});
			}
			return {
				content,
				finishReason: finishReasonFor(text, toolCalls),
				usage: {
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					totalTokens: usage.totalTokens,
				},
				warnings: [],
			};
		},
		doStream: async (options) => {
			const id = `deepseek-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const textChunks: string[] = [];
			const reasoningChunks: string[] = [];

			// The web endpoint has no per-token tool streaming; buffer the reply
			// so `<tool>` blocks can be parsed and stripped before emitting.
			const completion = await doCompletion(
				options,
				(t) => textChunks.push(t),
				(r) => reasoningChunks.push(r),
			);

			const reasoningText = reasoningChunks.join("");
			// Use the calls `doCompletion` already resolved through the full
			// recovery ladder (`<tool>` blocks, loose tags, then the
			// shell-fence/prose fallback). Re-parsing `rawText` here with only
			// `parseDeepSeekToolCalls` threw that ladder away, so a reply that
			// arrived as a ```powershell fence was shown as text and never ran.
			const cleanedContent = completion.text;
			const toolCalls = completion.toolCalls;

			const parts: LanguageModelV2StreamPart[] = [
				{ type: "stream-start", warnings: [] },
				{ type: "response-metadata", id },
			];
			if (reasoningText) {
				parts.push({ type: "reasoning-start", id });
				parts.push({ type: "reasoning-delta", id, delta: reasoningText });
				parts.push({ type: "reasoning-end", id });
			}
			if (cleanedContent) {
				parts.push({ type: "text-start", id });
				parts.push({ type: "text-delta", id, delta: cleanedContent });
				parts.push({ type: "text-end", id });
			}
			for (let i = 0; i < toolCalls.length; i++) {
				const input = JSON.stringify(toolCalls[i].arguments);
				parts.push({
					type: "tool-input-start",
					id,
					toolName: toolCalls[i].name,
				});
				parts.push({ type: "tool-input-delta", id, delta: input });
				parts.push({ type: "tool-input-end", id });
				parts.push({
					type: "tool-call",
					toolCallId: `call-${Date.now()}-${i}`,
					toolName: toolCalls[i].name,
					input,
				});
			}
			parts.push({
				type: "finish",
				finishReason: finishReasonFor(cleanedContent, toolCalls),
				usage: {
					inputTokens: completion.usage.inputTokens,
					outputTokens: completion.usage.outputTokens,
					totalTokens: completion.usage.totalTokens,
				},
			});

			let index = 0;
			const stream = new ReadableStream<LanguageModelV2StreamPart>({
				pull(controller) {
					if (index < parts.length) {
						controller.enqueue(parts[index++]);
						return;
					}
					controller.close();
				},
				cancel() {
					index = parts.length;
				},
			});

			return { stream, warnings: [] };
		},
	};
}

export function createDeepSeekWebProviderModule(
	config: GatewayResolvedProviderConfig,
	_context: GatewayProviderContext,
): ProviderFactoryResult {
	const fetchImpl = ensureFetch(config.fetch);
	return {
		model: (modelId) => createDeepSeekWebModel(modelId, config, fetchImpl),
	};
}
