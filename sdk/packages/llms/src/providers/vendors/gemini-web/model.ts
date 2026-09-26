/**
 * The provider itself: build the prompt, drive one turn, parse what comes back.
 *
 * This is where the parse ladder lives — the order in which a reply is offered
 * to each parser — and that order is the part of a vendor that genuinely
 * differs from every other vendor. Everything it calls is either shared
 * (`../tool-pipeline/`) or one of this folder's own modules.
 */

import type {
	LanguageModelV2,
	LanguageModelV2CallOptions,
	LanguageModelV2Content,
	LanguageModelV2FinishReason,
	LanguageModelV2FunctionTool,
	LanguageModelV2Prompt,
	LanguageModelV2StreamPart,
} from "@ai-sdk/provider";
import type {
	BasicLogger,
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
} from "@cline/shared";
import {
	messagesToPrompt,
	normalizeToolName,
	parseDeepSeekToolCalls,
	parseLooseDeepSeekToolCalls,
	parseRepairedToolJson,
} from "../deepseek-web";
import { buildLeanConversation, currentUserLabel } from "../deepseek-web-v2";
import { withBrowserLock } from "../tool-pipeline/browser-lock";
import { resolveChatKey } from "../tool-pipeline/chat-target";
import { confirmChatLocation } from "../tool-pipeline/confirm-chat-location";
import { logConversationTurn } from "../tool-pipeline/conversation-logger";
import { addToChatContext } from "../tool-pipeline/estimate-usage";
import { parseInvokeStyleToolCalls } from "../tool-pipeline/invoke-parser";
import { parseManagerBlocks } from "../tool-pipeline/manager-block";
import { unappliedPatchNotice } from "../tool-pipeline/patch-block";
import { stripPreviousUserBlock } from "../tool-pipeline/previous-user-dedupe";
import { validateToolCalls } from "../tool-pipeline/tool-dispatcher";
import type { ProviderFactoryResult } from "../types";
import { connectBrowser, waitForComposerReady } from "./browser";
import { sendAndCapture } from "./capture";
import {
	chatKeyFromPrompt,
	extractGeminiSessionId,
	lookupGeminiChatSession,
	recordGeminiChatSession,
} from "./chat-registry";
import {
	consumeGeminiThrottleRecoveryReload,
	GEMINI_WEB_URL,
	resolveGeminiWebV2Config,
	sleep,
} from "./config";
import { navigateGeminiChat, readPageUrl } from "./navigation";

// ── Main provider ─────────────────────────────────────────────────────────────

export interface GeminiCompletionResult {
	text: string;
	toolCalls: { name: string; arguments: Record<string, unknown> }[];
	usage: { inputTokens: number; outputTokens: number; totalTokens: number };
	/**
	 * Set when every tool call in the reply was rejected (e.g. invalid Python
	 * in an `editor` call). It is OUR commentary on what the model typed, so
	 * the model never sees it unless we send it back into the chat — the web
	 * client's server-side history has no idea we rejected anything.
	 */
	retryPrompt?: string;
}

/**
 * Build the flat prompt sent to gemini.google.com, mirroring deepseek-web-v2's
 * `buildPrompt`: the real web client keeps its own server-side conversation
 * state, so the system prompt is sent verbatim on the conversation's first
 * turn (via `buildLeanConversation`'s own first-turn passthrough) and dropped
 * on every follow-up turn in the SAME Gemini chat — re-added only when
 * `reInjectSystem` is true (a brand-new Gemini chat, e.g. right after a
 * compaction opens a fresh one).
 */
export function buildGeminiPrompt(
	prompt: LanguageModelV2Prompt,
	reInjectSystem: boolean,
	preserveCompactionContext: boolean,
): string {
	// The system prompt arrives already chosen: `buildClineSystemPrompt`
	// picks this provider's `default` / `worker` / `manager` wording from
	// its prompts file. This used to call `applySimpleWebSystemPrompt`,
	// which swapped the prompt here by testing it for a marker heading
	// that no web provider is ever sent — so it never once fired.
	const effectivePrompt = prompt;

	const conversation = buildLeanConversation(
		effectivePrompt,
		preserveCompactionContext,
	);
	const systemMessage = effectivePrompt.find((m) => m.role === "system");
	const alreadyHasSystem = conversation.some((m) => m.role === "system");
	const promptOptions = {
		historyWindow: 10,
		userLabel: "My last message",
		lastUserLabel: currentUserLabel(conversation),
		toolResultLabel: "Tool result",
	};
	if (
		reInjectSystem &&
		systemMessage &&
		!alreadyHasSystem &&
		conversation.length > 0
	) {
		return messagesToPrompt([systemMessage, ...conversation], promptOptions);
	}
	return messagesToPrompt(conversation, promptOptions);
}

/**
 * Map the provider `modelId` (e.g. "gemini-2.5-pro", "gemini-flash-latest",
 * "gemini-3.1-flash-lite") to the Gemini web UI tier name ("Pro", "Flash",
 * "Flash-Lite"). The web client picks models from a menu whose labels are the
 * tier name with a leading version number ("3.6 Flash"), and
 * `selectGeminiModel` strips that number before matching. "auto"/unknown ids
 * return null so the browser is left on whatever model it's currently using,
 * matching the reference automation's `send <msg>` (no `model=` suffix).
 */
function modelIdToGeminiUiModel(modelId: string): string | null {
	const id = modelId.toLowerCase();
	if (id.includes("auto")) return null;
	if (id.includes("flash-lite")) return "Flash-Lite";
	if (id.includes("pro")) return "Pro";
	if (id.includes("flash")) return "Flash";
	return null;
}

/**
 * Parse Gemini's native tool-call format — a JSON array (or single object) of
 * `{"name": "...", "args": {...}}` entries, usually wrapped in a ```json code
 * fence. Gemini does not emit the `<tool>` tag contract the DeepSeek parsers
 * expect; left to `parseFallbackToolUses`, that ```json fence is misread as
 * "code to write to a file", turning a `read_files` call into a destructive
 * `editor` call. This parser runs before the fallback so a real tool call wins.
 */
function parseGeminiToolCalls(
	content: string,
	toolNames: string[],
): {
	cleanedContent: string;
	toolCalls: { name: string; arguments: Record<string, unknown> }[];
} {
	const accepted = new Set(toolNames.map((name) => normalizeToolName(name)));
	const toolCalls: { name: string; arguments: Record<string, unknown> }[] = [];
	const cleanedParts: string[] = [];
	let cursor = 0;

	// Find ```json ... ``` fences AND bare JSON arrays/objects. The fence is the
	// common Gemini shape; a bare array is a fallback for unfenced output.
	const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
	let match: RegExpExecArray | null;
	while ((match = fenceRe.exec(content)) !== null) {
		const body = match[1].trim();
		const parsed = parseRepairedToolJson(body);
		cleanedParts.push(content.slice(cursor, match.index));
		cursor = match.index + match[0].length;
		if (parsed === undefined) continue;

		for (const call of asToolCallList(parsed)) {
			if (call && accepted.has(normalizeToolName(call.name))) {
				toolCalls.push(call);
			}
		}
	}
	cleanedParts.push(content.slice(cursor));

	// No fence matched — try the whole text as a bare JSON array/object.
	if (toolCalls.length === 0) {
		const parsed = parseRepairedToolJson(content);
		if (parsed !== undefined) {
			for (const call of asToolCallList(parsed)) {
				if (call && accepted.has(normalizeToolName(call.name))) {
					toolCalls.push(call);
				}
			}
			if (toolCalls.length > 0) {
				return { cleanedContent: "", toolCalls };
			}
		}
	}

	return { cleanedContent: cleanedParts.join("").trim(), toolCalls };
}

/** Normalize a parsed tool-call value into `{name, arguments}` entries. */
function asToolCallList(
	parsed: unknown,
): { name: string; arguments: Record<string, unknown> }[] {
	const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
	const out: { name: string; arguments: Record<string, unknown> }[] = [];
	for (const item of items) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const name =
			typeof record.name === "string"
				? record.name
				: typeof record.type === "string"
					? record.type
					: "";
		if (!name) continue;
		let args: unknown = record.args ?? record.arguments ?? record.params;
		if (args === undefined && record.arguments_json !== undefined) {
			try {
				args = JSON.parse(String(record.arguments_json));
			} catch {
				args = undefined;
			}
		}
		if (args === undefined) args = {};
		if (args && typeof args === "object" && !Array.isArray(args)) {
			out.push({ name, arguments: args as Record<string, unknown> });
		}
	}
	return out;
}

/**
 * Parse text for patch blocks before we decide whether the reply is tool calls
 * or plain text. A `# File: <path>` + `
```
` block is an `editor` tool use;
 * the model has no other way to edit a file. The unapplied patch notice is
 * appended so the user knows something was written but not applied.
 */
function parseFallbackEditorUses(
	text: string,
	toolNames: string[],
): {
	cleanedText: string;
	toolUses: { name: string; arguments: Record<string, unknown> }[];
} {
	if (!toolNames.includes("editor")) {
		return { cleanedText: text, toolUses: [] };
	}

	// Scan for # File: lines followed by a code fence
	const lines = text.split("\n");
	const kept: string[] = [];
	const toolUses: { name: string; arguments: Record<string, unknown> }[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		// Look for "# File: <path>"
		const fileMatch = /^# File:\s*(.+)$/.exec(line);
		if (!fileMatch) {
			kept.push(line);
			i++;
			continue;
		}
		const filePath = fileMatch[1].trim();
		// Skip to next non-empty line
		let j = i + 1;
		while (j < lines.length && !(lines[j] ?? "").trim()) {
			j++;
		}
		if (j >= lines.length) {
			// No code block after the file header
			kept.push(line);
			i++;
			continue;
		}
		// Look for a code fence: ``` or ```language
		const fenceLine = lines[j] ?? "";
		if (!/^```(?:\w*)$/.test(fenceLine.trim())) {
			kept.push(line);
			i++;
			continue;
		}
		// Find closing fence
		let k = j + 1;
		while (k < lines.length && !/^```$/.test((lines[k] ?? "").trim())) {
			k++;
		}
		if (k >= lines.length) {
			// Unterminated code block
			kept.push(line);
			i++;
			continue;
		}
		// Extract code body (lines between fences)
		const codeLines = lines.slice(j + 1, k);
		const code = codeLines.join("\n").trim();
		if (code) {
			toolUses.push({
				name: "editor",
				arguments: { path: filePath, new_text: code },
			});
			// Skip the whole block
			i = k + 1;
		} else {
			// Empty code block, keep the header
			kept.push(line);
			i++;
		}
	}

	const cleanedText = kept.join("\n").trim();
	if (toolUses.length === 0) {
		return { cleanedText: text, toolUses: [] };
	}
	// If we stripped something, add a notice if no apply_patch tool is available
	const notice = unappliedPatchNotice(text, toolNames);
	const cleaned = notice ? `${cleanedText}\n\n${notice}`.trim() : cleanedText;
	return { cleanedText: cleaned, toolUses };
}

/**
 * Turn a finished reply into visible text plus tool calls.
 *
 * Two callers hand us a reply string: the normal capture path, and `/paste`,
 * where the user copied the reply out of the browser because a network error
 * ate ours. Both need the same parse ladder, so they run the same code.
 */
function parseCapturedReply(
	text: string,
	options: LanguageModelV2CallOptions,
	usage: GeminiCompletionResult["usage"],
): GeminiCompletionResult {
	const functionTools = (options.tools ?? []).filter(
		(tool): tool is LanguageModelV2FunctionTool => tool.type === "function",
	);
	if (functionTools.length === 0) {
		return { text, toolCalls: [], usage };
	}

	const toolNames = functionTools.map((t) => t.name);

	// `<manager>` blocks come first, and only when the session actually has the
	// team tool to dispatch them with. A lead on a web provider is prompted to
	// write delegations as prose rather than tool calls - see
	// `tool-pipeline/manager-block.ts` for why that framing is what keeps it out
	// of tool machinery it cannot use.
	if (toolNames.includes("team_run_task")) {
		const manager = parseManagerBlocks(text, {
			// Only when the session actually has the shell tool to run it with.
			allowCommands: toolNames.includes("run_commands"),
			toolNames,
		});
		if (manager.delegations.length > 0 || manager.problems.length > 0) {
			const retryPrompt =
				manager.problems.length > 0 ? manager.problems.join("\n") : undefined;
			return {
				text: retryPrompt
					? `${manager.cleanedContent}\n\n${retryPrompt}`.trim()
					: manager.cleanedContent,
				toolCalls: manager.delegations.map((delegation) => ({
					name: delegation.name,
					arguments: delegation.arguments as Record<string, unknown>,
				})),
				usage,
				retryPrompt,
			};
		}
	}

	const { cleanedContent, toolCalls } = parseDeepSeekToolCalls(text, toolNames);
	const looseCalls =
		toolCalls.length === 0
			? parseLooseDeepSeekToolCalls(text, toolNames)
			: toolCalls;
	if (looseCalls.length > 0) {
		const { tools: validatedCalls, retryPrompt } =
			validateToolCalls(looseCalls);
		return {
			text: retryPrompt
				? `${cleanedContent}

${retryPrompt}`.trim()
				: cleanedContent,
			toolCalls: validatedCalls,
			usage,
			retryPrompt,
		};
	}

	// Anthropic-style `<invoke>` bodies, which every big model reaches for
	// under load. See tool-pipeline/invoke-parser.ts.
	const invoked = parseInvokeStyleToolCalls(text, toolNames);
	if (invoked.toolCalls.length > 0) {
		const { tools: validatedInvoked, retryPrompt } = validateToolCalls(
			invoked.toolCalls,
		);
		return {
			text: retryPrompt
				? `${invoked.cleanedContent}

${retryPrompt}`.trim()
				: invoked.cleanedContent,
			toolCalls: validatedInvoked,
			usage,
			retryPrompt,
		};
	}

	// Gemini native JSON tool calls (`{"name":"read_files","args":{...}}`).
	const geminiParsed = parseGeminiToolCalls(text, toolNames);
	if (geminiParsed.toolCalls.length > 0) {
		const { tools: validatedGemini, retryPrompt } = validateToolCalls(
			geminiParsed.toolCalls,
		);
		return {
			text: retryPrompt
				? `${geminiParsed.cleanedContent}

${retryPrompt}`.trim()
				: geminiParsed.cleanedContent,
			toolCalls: validatedGemini,
			usage,
			retryPrompt,
		};
	}

	// Patch blocks as a last resort: `# File: <path>` + code. This is what
	// Gemini reaches for when it wants to write a file but can't find the
	// tool-call shape it expects. It is also what made the earlier parse ladder
	// destructive: a `read_files` call misread as an `editor` call would wipe a
	// file. Since this parser runs last, it only takes what is left over.
	const editorParsed = parseFallbackEditorUses(text, toolNames);
	if (editorParsed.toolUses.length > 0) {
		const { tools: validatedEditor, retryPrompt } = validateToolCalls(
			editorParsed.toolUses,
		);
		return {
			text: retryPrompt
				? `${editorParsed.cleanedText}

${retryPrompt}`.trim()
				: editorParsed.cleanedText,
			toolCalls: validatedEditor,
			usage,
			retryPrompt,
		};
	}

	return { text, toolCalls: [], usage };
}

function finishReasonFor(
	text: string,
	toolCalls: GeminiCompletionResult["toolCalls"],
): LanguageModelV2FinishReason {
	return toolCalls.length > 0 ? "tool-calls" : text ? "stop" : "unknown";
}

export function createGeminiWebModel(
	modelId: string,
	logger?: BasicLogger,
): LanguageModelV2 {
	const runtimeConfig = resolveGeminiWebV2Config();
	const debugLog = (msg: string) => {
		if (runtimeConfig.debug) logger?.debug(`[gemini-web] ${msg}`);
	};

	// Cached across runs: the session ID of the chat we're currently in.
	// Used to skip navigation on the second turn of the same chat.
	let currentGeminiSession: string | undefined;
	let lastAppliedGeminiUiModel: string | null = null;

	async function runCompletion(
		options: LanguageModelV2CallOptions,
	): Promise<GeminiCompletionResult> {
		const config = resolveGeminiWebV2Config();
		const chatKey = resolveChatKey("gemini-web", () =>
			chatKeyFromPrompt(options.prompt),
		);

		// Look up the chat's session ID from the registry, or fall back to the
		// cached session if we're already in one.
		const savedSession = lookupGeminiChatSession(config.chatsFile, chatKey);
		const sessionId = savedSession ?? currentGeminiSession;

		const isNewChat =
			!sessionId ||
			!!(options as any).experimental_context?.reInjectSystemPrompt;

		const cdp = await connectBrowser(config);
		const targets = await cdp.send("Target.getTargets");
		let pageTarget = targets.targetInfos?.find(
			(t: any) =>
				t.type === "page" && t.url?.startsWith("https://gemini.google.com"),
		);
		if (!pageTarget) {
			const result = await cdp.send("Target.createTarget", {
				url: GEMINI_WEB_URL,
			});
			await sleep(2000);
			const newTargets = await cdp.send("Target.getTargets");
			pageTarget = newTargets.targetInfos?.find(
				(t: any) => t.targetId === result.targetId,
			);
			if (!pageTarget) {
				throw new Error("Failed to create Gemini page");
			}
		}
		const attachResult = await cdp.send("Target.attachToTarget", {
			targetId: pageTarget.targetId,
			flatten: true,
		});
		const cdpSessionId = attachResult.sessionId;

		// Check for a one-shot recovery reload flag: if the previous turn was
		// rate-limited, we reload the page now to clear the block before
		// carrying on. This avoids a dead turn where the composer stays stuck.
		const shouldForceReload = consumeGeminiThrottleRecoveryReload();
		if (shouldForceReload) {
			debugLog("forcing page reload to recover from rate-limit block");
		}

		// Navigate to the right chat, or reload the page to clear a block.
		await navigateGeminiChat(
			cdp,
			cdpSessionId,
			{
				fresh: isNewChat,
				sessionId: isNewChat ? undefined : sessionId,
			},
			logger,
			shouldForceReload,
		);

		await waitForComposerReady(cdp, cdpSessionId, config, logger);
		if (!isNewChat && sessionId) {
			await confirmChatLocation({
				cdp,
				cdpSessionId,
				provider: "gemini-web",
				chatId: sessionId,
				chatUrl: `https://gemini.google.com/app/${sessionId}`,
				waitReady: () =>
					waitForComposerReady(cdp, cdpSessionId, config, logger),
				logger,
			});
		}

		// Build the flat prompt sent to the UI, stripping the system prompt on
		// follow-up turns (the web chat already has it) and re-injecting it on
		// a fresh chat.
		const preserveCompactionContext = !!(options as any).experimental_context
			?.preserveCompactionContext;
		let promptText = buildGeminiPrompt(
			options.prompt,
			isNewChat,
			preserveCompactionContext,
		);

		// The web chat is stateful: everything the user typed is already in it.
		// The current instruction still goes out — `messagesToPrompt` labels it
		// `User:` (or `Note:` on an iteration turn) — but every OLDER
		// `My last message:` block is dropped, so an instruction is sent
		// once and never re-sent on each round of a tool loop. Anything the user
		// wants restated goes through `/note`.
		promptText = stripPreviousUserBlock(promptText);

		const functionTools = (options.tools ?? []).filter(
			(tool): tool is LanguageModelV2FunctionTool => tool.type === "function",
		);

		debugLog(`Sending prompt (${promptText.length} chars)`);

		// Only re-select the model in the web UI when it actually changes.
		// Gemini keeps its selection across sends, so re-clicking the picker on
		// every message (or tool-result follow-up) is an unneeded loop. When
		// the model is unchanged, pass `model: null` so the page script leaves
		// the picker alone.
		const geminiUiModel = modelIdToGeminiUiModel(modelId);
		const shouldSelectModel = geminiUiModel !== lastAppliedGeminiUiModel;
		if (shouldSelectModel) {
			lastAppliedGeminiUiModel = geminiUiModel;
		}
		const MAX_TOOL_REJECTION_RETRIES = 2;

		// Bounded retry: when EVERY tool call in a reply is rejected, resend the
		// rejection as a real follow-up message in the SAME chat so the model
		// actually sees why we refused it and can correct itself. Capped so a
		// persistently broken reply can't loop forever. The model picker is only
		// touched on the first send — the retry stays on whatever it selected.
		let sendPrompt = promptText;
		let selectModel = shouldSelectModel;
		let result: Awaited<ReturnType<typeof sendAndCapture>>;
		let parsed: GeminiCompletionResult;
		for (let attempt = 0; ; attempt++) {
			result = await sendAndCapture(
				cdp,
				cdpSessionId,
				sendPrompt,
				config,
				logger,
				{ model: selectModel ? geminiUiModel : null },
				functionTools.length > 0,
				options.abortSignal,
			);

			debugLog(`Received response (${result.text.length} chars)`);

			result.usage = addToChatContext(
				"gemini-web",
				chatKey,
				result.usage,
				isNewChat && attempt === 0,
			);
			parsed = parseCapturedReply(result.text, options, result.usage);

			// Log raw and parsed response per conversation
			try {
				logConversationTurn("gemini-web", chatKey, result.rawBody, {
					text: parsed.text,
					toolCalls: parsed.toolCalls.length > 0 ? parsed.toolCalls : undefined,
					usage: result.usage,
					finishReason: result.finishReason,
				});
			} catch (logErr) {
				// Ignore logging failures
			}

			if (
				parsed.toolCalls.length === 0 &&
				parsed.retryPrompt &&
				attempt < MAX_TOOL_REJECTION_RETRIES
			) {
				logger?.log(
					`[gemini-web] all tool calls rejected, resending correction into chat (attempt ${attempt + 1}/${MAX_TOOL_REJECTION_RETRIES})`,
					{ severity: "warn" },
				);
				sendPrompt = parsed.retryPrompt;
				selectModel = false;
				continue;
			}
			break;
		}

		// After sending, the SPA routes to `/app/<id>`; capture it so the next
		// turn (or a resume) can reopen this same Gemini chat.
		const pageUrl = await readPageUrl(cdp, cdpSessionId);
		const geminiSession = extractGeminiSessionId(pageUrl);
		if (geminiSession) {
			recordGeminiChatSession(config.chatsFile, chatKey, geminiSession);
			currentGeminiSession = geminiSession;
		}

		return parsed;
	}

	const provider: LanguageModelV2 = {
		specificationVersion: "v2",
		provider: "gemini-web",
		modelId,
		supportedUrls: {} as Record<string, RegExp[]>,

		async doGenerate(options: LanguageModelV2CallOptions) {
			try {
				const { text, toolCalls, usage } = await withBrowserLock(
					"gemini-web",
					options.abortSignal,
					() => runCompletion(options),
				);

				const content: LanguageModelV2Content[] = [];
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
					usage,
					warnings: [],
				};
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));
				logger?.error?.(`[gemini-web] doGenerate error: ${err.message}`);
				throw err;
			}
		},

		async doStream(options: LanguageModelV2CallOptions) {
			const { text, toolCalls, usage } = await withBrowserLock(
				"gemini-web",
				options.abortSignal,
				() => runCompletion(options),
			);
			const id = `gemini-web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

			const parts: LanguageModelV2StreamPart[] = [
				{ type: "stream-start", warnings: [] },
				{ type: "response-metadata", id },
			];
			if (text) {
				parts.push({ type: "text-start", id });
				parts.push({ type: "text-delta", id, delta: text });
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
				finishReason: finishReasonFor(text, toolCalls),
				usage,
			});

			const stream = new ReadableStream<LanguageModelV2StreamPart>({
				start(controller) {
					for (const part of parts) controller.enqueue(part);
					controller.close();
				},
			});
			return { stream, usage };
		},
	};

	return provider;
}

// ── Provider factory ──────────────────────────────────────────────────────────

export function createGeminiWebProvider(
	_config: GatewayResolvedProviderConfig,
	context?: GatewayProviderContext,
): ProviderFactoryResult {
	const logger = context?.logger;
	return {
		model: (modelId: string) => createGeminiWebModel(modelId, logger),
	};
}

export function createGeminiWebProviderFactory() {
	return { id: "gemini-web", create: createGeminiWebProvider };
}

// ── Module factory (used by ai-sdk.ts) ────────────────────────────────────────

export function createGeminiWebProviderModule(
	config: GatewayResolvedProviderConfig,
	context?: GatewayProviderContext,
): ProviderFactoryResult {
	return createGeminiWebProvider(config, context);
}
