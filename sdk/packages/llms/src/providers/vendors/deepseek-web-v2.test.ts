import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateDeepSeekWebUsage } from "./deepseek-web";
import {
	buildPrompt,
	buildSendScript,
	chatKeyFromPrompt,
	computeSendDelay,
	consumeThrottleRecoveryReload,
	isRateLimitText,
	isSameChatLocation,
	lookupChatSession,
	parseFallbackToolUses,
	parseSessionIdFromUrl,
	randomInRange,
	recordChatSession,
	requestThrottleRecoveryReload,
	resolveDeepSeekWebV2Config,
	resolveV2ModelOptions,
} from "./deepseek-web-v2";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("deepseek-web-v2 resolveV2ModelOptions", () => {
	it("maps deepseek-chat to the default model with deep thinking off", () => {
		expect(resolveV2ModelOptions("deepseek-chat")).toEqual({
			modelType: "default",
			deepThinking: false,
		});
	});

	it("maps deepseek-reasoner to default model with deep thinking on", () => {
		expect(resolveV2ModelOptions("deepseek-reasoner")).toEqual({
			modelType: "default",
			deepThinking: true,
		});
	});

	it("maps deepseek-expert to the expert radio model", () => {
		expect(resolveV2ModelOptions("deepseek-expert")).toEqual({
			modelType: "expert",
			deepThinking: false,
		});
	});

	it("maps deepseek-expert-reasoner to expert + deep thinking", () => {
		expect(resolveV2ModelOptions("deepseek-expert-reasoner")).toEqual({
			modelType: "expert",
			deepThinking: true,
		});
	});

	it("maps deepseek-vision to the vision radio and leaves the toggle alone", () => {
		expect(resolveV2ModelOptions("deepseek-vision")).toEqual({
			modelType: "vision",
			deepThinking: null,
		});
	});
});

describe("deepseek-web-v2 buildSendScript", () => {
	it("embeds the prompt and options as JSON literals", () => {
		const script = buildSendScript("Hello world", {
			modelType: "expert",
			deepThinking: true,
		});
		expect(script).toContain(JSON.stringify("Hello world"));
		expect(script).toContain('"model":"expert"');
		expect(script).toContain('"deepThinking":true');
		expect(script).toContain("function sendMessageToDeepSeek");
		expect(script).toContain("sendMessageToDeepSeek(");
		// No demo calls from the reference sendmessage.js leak in.
		expect(script).not.toContain('"Hello!"');
	});

	it("omits deepThinking when the model has no toggle (vision)", () => {
		const script = buildSendScript("Describe this", {
			modelType: "vision",
			deepThinking: null,
		});
		expect(script).toContain('"model":"vision"');
		expect(script).not.toContain('"deepThinking"');
	});

	it("produces syntactically valid JavaScript", () => {
		const script = buildSendScript("Can you fix this bug?\n```ts\nx = 1\n```", {
			modelType: "default",
			deepThinking: false,
		});
		// Parsing-only check — executing it needs the chat.deepseek.com DOM.
		expect(() => new Function(script)).not.toThrow();
	});

	it("keeps the reference sendmessage.js fire-and-forget contract", () => {
		const script = buildSendScript("Hi", {
			modelType: "default",
			deepThinking: false,
		});
		// The page-side script returns true immediately; typing + send happen in
		// setTimeout callbacks, exactly like the reference sendmessage.js.
		expect(script).toContain("function sendMessageToDeepSeek");
		expect(script).toContain("setTimeout(function ()");
		expect(script).toContain("sendMessageToDeepSeek(");
		expect(script).toContain("return true;");
		// No in-page verification that could bail out before the send click.
		expect(script).not.toContain("composer-rejected-input");
		expect(script).not.toContain("composer-textarea-not-found");
		// No demo calls from the reference leak in.
		expect(script).not.toContain('"Hello!"');
	});
});

describe("deepseek-web-v2 parseFallbackToolUses", () => {
	it("turns a markdown code fence into an editor file-write call", () => {
		const text = [
			"Here's the script:",
			"```python",
			'print("Hello World!")',
			"```",
			"You can save it as google_stock_fetcher.py.",
		].join("\n");
		const { cleanedText, toolUses } = parseFallbackToolUses(
			text,
			"build me a script",
			["editor", "run_commands"],
		);
		expect(toolUses).toEqual([
			{
				name: "editor",
				arguments: {
					path: "google_stock_fetcher.py",
					new_text: 'print("Hello World!")',
				},
			},
		]);
		// The code fence is stripped from the visible text.
		expect(cleanedText).not.toContain("print(");
		expect(cleanedText).toContain("Here's the script:");
	});

	it("infers a filename from the user prompt when the reply has none", () => {
		const { toolUses } = parseFallbackToolUses(
			"```python\nx = 1\n```",
			"save it as helper.py",
			["editor"],
		);
		expect(toolUses[0]?.arguments).toEqual({
			path: "helper.py",
			new_text: "x = 1",
		});
	});

	it("generates a filename when neither reply nor prompt names one", () => {
		const { toolUses } = parseFallbackToolUses(
			"```python\nx = 1\n```",
			"write some code",
			["editor"],
		);
		expect(toolUses[0]?.arguments.path).toMatch(/^output_\d+\.py$/);
	});

	it("turns pip install lines into a run_commands call", () => {
		const { toolUses } = parseFallbackToolUses(
			"Install the dependency:\npip install yfinance pandas",
			"",
			["editor", "run_commands"],
		);
		expect(toolUses).toContainEqual({
			name: "run_commands",
			arguments: { commands: ["pip install yfinance pandas"] },
		});
	});

	it("emits nothing when the tools are unavailable", () => {
		const text = "```python\nx = 1\n```\npip install yfinance";
		const { cleanedText, toolUses } = parseFallbackToolUses(text, "", []);
		expect(toolUses).toEqual([]);
		// Text is left untouched.
		expect(cleanedText).toContain("x = 1");
	});
});

describe("deepseek-web-v2 resolveDeepSeekWebV2Config", () => {
	it("uses env overrides for the browser runtime", () => {
		vi.stubEnv("DEEPSEEK_WEB_V2_DEBUG_PORT", "9333");
		vi.stubEnv("DEEPSEEK_WEB_V2_CHROME_PATH", "C:\\chrome\\chrome.exe");
		vi.stubEnv("DEEPSEEK_WEB_V2_HEADLESS", "true");
		vi.stubEnv("DEEPSEEK_WEB_V2_DEBUG", "true");
		vi.stubEnv("DEEPSEEK_WEB_V2_RESPONSE_TIMEOUT_MS", "5000");
		vi.stubEnv("DEEPSEEK_WEB_V2_LOGIN_TIMEOUT_MS", "60000");

		const config = resolveDeepSeekWebV2Config();
		expect(config.debugPort).toBe(9333);
		expect(config.chromePath).toBe("C:\\chrome\\chrome.exe");
		expect(config.headless).toBe(true);
		expect(config.debug).toBe(true);
		expect(config.responseTimeoutMs).toBe(5000);
		expect(config.loginTimeoutMs).toBe(60000);
	});

	it("defaults to a visible Chrome (headless off), no debug, port 9222", () => {
		const config = resolveDeepSeekWebV2Config();
		expect(config.debugPort).toBe(9222);
		expect(config.headless).toBe(false);
		expect(config.debug).toBe(false);
		expect(config.responseTimeoutMs).toBeGreaterThan(30_000);
		expect(config.loginTimeoutMs).toBe(120_000);
		expect(config.toolPromptMode).toBe("lean");
		expect(config.toolPromptThresholdChars).toBe(20_000);
	});

	it("overrides tool prompt mode and threshold via env", () => {
		vi.stubEnv("DEEPSEEK_WEB_V2_TOOL_PROMPT_MODE", "always");
		vi.stubEnv("DEEPSEEK_WEB_V2_TOOL_PROMPT_THRESHOLD_CHARS", "9999");
		const config = resolveDeepSeekWebV2Config();
		expect(config.toolPromptMode).toBe("always");
		expect(config.toolPromptThresholdChars).toBe(9999);
	});

	it("defaults to a sane randomized pacing range and allows override", () => {
		const config = resolveDeepSeekWebV2Config();
		expect(config.minSendDelayMs).toBeGreaterThanOrEqual(0);
		expect(config.maxSendDelayMs).toBeGreaterThan(config.minSendDelayMs);
		expect(config.toolTurnExtraMinMs).toBeGreaterThanOrEqual(0);
		expect(config.toolTurnExtraMaxMs).toBeGreaterThan(
			config.toolTurnExtraMinMs,
		);

		vi.stubEnv("DEEPSEEK_WEB_V2_MIN_SEND_DELAY_MS", "500");
		vi.stubEnv("DEEPSEEK_WEB_V2_MAX_SEND_DELAY_MS", "1500");
		const overridden = resolveDeepSeekWebV2Config();
		expect(overridden.minSendDelayMs).toBe(500);
		expect(overridden.maxSendDelayMs).toBe(1500);
	});
});

describe("deepseek-web-v2 pacing (computeSendDelay / randomInRange)", () => {
	const config = {
		minSendDelayMs: 1000,
		maxSendDelayMs: 2000,
		toolTurnExtraMinMs: 2000,
		toolTurnExtraMaxMs: 3000,
	};

	it("returns a deterministic value within range for a pinned rng", () => {
		// rng -> 0 => min; rng -> 0.9999 => max.
		expect(randomInRange(10, 20, () => 0)).toBe(10);
		const maxValue = randomInRange(10, 20, () => 0.99999);
		expect(maxValue).toBe(20);
		expect(maxValue).toBeLessThanOrEqual(20);
	});

	it("adds the extra tool-turn delay only when isToolTurn", () => {
		// rng=0 ⇒ base = 1000. Tool turn adds extra min 2000 ⇒ 3000.
		expect(computeSendDelay(config, { isToolTurn: false }, () => 0)).toBe(1000);
		expect(computeSendDelay(config, { isToolTurn: true }, () => 0)).toBe(
			1000 + 2000,
		);
	});

	it("always stays within the configured ranges across many random draws", () => {
		for (let i = 0; i < 100; i++) {
			const normal = computeSendDelay(config, { isToolTurn: false });
			expect(normal).toBeGreaterThanOrEqual(config.minSendDelayMs);
			expect(normal).toBeLessThanOrEqual(config.maxSendDelayMs);

			const toolTurn = computeSendDelay(config, { isToolTurn: true });
			expect(toolTurn).toBeGreaterThanOrEqual(
				config.minSendDelayMs + config.toolTurnExtraMinMs,
			);
			expect(toolTurn).toBeLessThanOrEqual(
				config.maxSendDelayMs + config.toolTurnExtraMaxMs,
			);
		}
	});

	it("degenerate/inverted ranges do not throw and stay sane", () => {
		expect(randomInRange(5, 5, () => 0.5)).toBe(5);
		expect(randomInRange(10, 2, () => 0.5)).toBeLessThanOrEqual(10);
		expect(randomInRange(10, 2, () => 0.5)).toBeGreaterThanOrEqual(2);
	});
});

describe("deepseek-web-v2 isRateLimitText", () => {
	it("detects DeepSeek's anti-abuse phrasing", () => {
		expect(isRateLimitText("Messages too frequent. Try again later.")).toBe(
			true,
		);
		expect(isRateLimitText("Slow down: too many requests")).toBe(true);
	});

	it("ignores normal completions", () => {
		expect(isRateLimitText("Here is the code you asked for.")).toBe(false);
		expect(isRateLimitText("")).toBe(false);
	});
});

describe("deepseek-web-v2 isSameChatLocation (no-reload guard)", () => {
	it("is true when already on the exact same chat URL", () => {
		expect(
			isSameChatLocation(
				"https://chat.deepseek.com/a/chat/s/abc123",
				"https://chat.deepseek.com/a/chat/s/abc123",
			),
		).toBe(true);
		expect(
			isSameChatLocation(
				"https://chat.deepseek.com/",
				"https://chat.deepseek.com/",
			),
		).toBe(true);
	});

	it("ignores trailing slash and fragment differences (no reload)", () => {
		expect(
			isSameChatLocation(
				"https://chat.deepseek.com/",
				"https://chat.deepseek.com",
			),
		).toBe(true);
		expect(
			isSameChatLocation(
				"https://chat.deepseek.com/a/chat/s/abc123",
				"https://chat.deepseek.com/a/chat/s/abc123#foo",
			),
		).toBe(true);
	});

	it("is false when on a different chat (reload needed)", () => {
		expect(
			isSameChatLocation(
				"https://chat.deepseek.com/a/chat/s/one",
				"https://chat.deepseek.com/a/chat/s/two",
			),
		).toBe(false);
		// A fresh composer when currently inside a chat is a real navigation.
		expect(
			isSameChatLocation(
				"https://chat.deepseek.com/a/chat/s/one",
				"https://chat.deepseek.com/",
			),
		).toBe(false);
	});

	it("is false for empty destination (never treat as already there)", () => {
		expect(isSameChatLocation("", "")).toBe(false);
		expect(isSameChatLocation("https://chat.deepseek.com/", "")).toBe(false);
	});
});

describe("deepseek-web-v2 throttle recovery reload", () => {
	afterEach(() => {
		// Reset the module flag so tests don't leak into each other.
		consumeThrottleRecoveryReload();
	});

	it("is empty by default (healthy turns do not reload)", () => {
		expect(consumeThrottleRecoveryReload()).toBe(false);
	});

	it("returns true exactly once after a throttle is requested", () => {
		requestThrottleRecoveryReload();
		expect(consumeThrottleRecoveryReload()).toBe(true);
		// One-shot: the second read is false again.
		expect(consumeThrottleRecoveryReload()).toBe(false);
	});

	it("a fresh request re-arms the flag for the next turn", () => {
		requestThrottleRecoveryReload();
		expect(consumeThrottleRecoveryReload()).toBe(true);
		requestThrottleRecoveryReload();
		expect(consumeThrottleRecoveryReload()).toBe(true);
	});
});

describe("deepseek-web-v2 buildPrompt (no tool-contract block)", () => {
	const tool = {
		type: "function",
		name: "editor",
		description: "edit files",
		inputSchema: { type: "object", properties: {} },
	} as never;

	const msg = (role: string, text: string) =>
		({ role, content: [{ type: "text", text }] }) as never;

	it("sends only the system prompt + user message on a tiny conversation", () => {
		const prompt = [
			msg("system", "You are an agent."),
			msg("user", "hi"),
		] as never;
		const built = buildPrompt(prompt, [tool]);
		expect(built).toContain("You are an agent.");
		expect(built).toContain("hi");
		expect(built).not.toContain("You can call tools.");
	});

	it("omits the tool block on an ordinary mid-length conversation", () => {
		const prompt = [
			msg("system", "You are an agent."),
			msg("user", "first"),
			msg("assistant", "ok"),
			msg("user", "second"),
			msg("assistant", "done"),
			msg("user", "third request"),
		] as never;
		const built = buildPrompt(prompt, [tool]);
		expect(built).not.toContain("You can call tools.");
		expect(built).toContain("third request");
	});

	it("never prepends the tool block, even for a very long conversation", () => {
		const long = "x".repeat(25_000);
		const prompt = [
			msg("system", "You are an agent."),
			msg("user", "first"),
			msg("tool", long),
		] as never;
		const built = buildPrompt(prompt, [tool]);
		expect(built).not.toContain("You can call tools.");
		expect(built).toContain(long);
	});

	it("ignores the legacy 'always' tool prompt mode", () => {
		vi.stubEnv("DEEPSEEK_WEB_V2_TOOL_PROMPT_MODE", "always");
		const prompt = [
			msg("system", "You are an agent."),
			msg("user", "first"),
			msg("assistant", "ok"),
			msg("user", "second request"),
		] as never;
		const built = buildPrompt(prompt, [tool]);
		expect(built).not.toContain("You can call tools.");
		expect(built).toContain("second request");
	});
});

describe("deepseek-web-v2 buildPrompt (system prompt on first turn only)", () => {
	const sys = (text: string) =>
		({ role: "system", content: [{ type: "text", text }] }) as never;
	const msg = (role: string, text: string) =>
		({ role, content: [{ type: "text", text }] }) as never;

	it("keeps the system prompt on the first turn ([system] + one user)", () => {
		const prompt = [sys("LONG SYSTEM PROMPT"), msg("user", "hello")] as never;
		const built = buildPrompt(prompt, undefined);
		expect(built).toContain("LONG SYSTEM PROMPT");
		expect(built).toContain("hello");
	});

	it("drops the system prompt once the agent starts iterating (assistant + tool turns)", () => {
		const prompt = [
			sys("LONG SYSTEM PROMPT"),
			msg("user", "do the thing"),
			msg("assistant", "I will read a file"),
			msg("tool", "file contents"),
		] as never;
		const built = buildPrompt(prompt, undefined);
		expect(built).not.toContain("LONG SYSTEM PROMPT");
		expect(built).toContain("file contents");
	});

	it("drops the system prompt on a follow-up user message", () => {
		const prompt = [
			sys("LONG SYSTEM PROMPT"),
			msg("user", "first"),
			msg("assistant", "done"),
			msg("user", "second request"),
		] as never;
		const built = buildPrompt(prompt, undefined);
		expect(built).not.toContain("LONG SYSTEM PROMPT");
		expect(built).toContain("second request");
	});

	it("re-injects the system prompt when a context-token threshold was crossed", () => {
		const prompt = [
			sys("LONG SYSTEM PROMPT"),
			msg("user", "first"),
			msg("assistant", "done"),
			msg("user", "second request"),
		] as never;
		const built = buildPrompt(prompt, undefined, true);
		expect(built).toContain("LONG SYSTEM PROMPT");
		expect(built).toContain("second request");
	});

	it("does not duplicate the system prompt on a first turn even when re-inject is requested", () => {
		const prompt = [sys("LONG SYSTEM PROMPT"), msg("user", "hello")] as never;
		const built = buildPrompt(prompt, undefined, true);
		// `reInjectSystem` is forced true for a brand-new chat, but the first
		// turn's lean conversation already carries the system — it must appear
		// exactly once, not twice.
		const occurrences = (built.match(/LONG SYSTEM PROMPT/g) ?? []).length;
		expect(occurrences).toBe(1);
		expect(built).toContain("hello");
	});

	it("re-injects the system exactly once on a follow-up turn (new chat after compaction)", () => {
		const prompt = [
			sys("LONG SYSTEM PROMPT"),
			msg("user", "first"),
			msg("assistant", "done"),
			msg("user", "second request"),
			msg("tool", "result"),
		] as never;
		const built = buildPrompt(prompt, undefined, true);
		const occurrences = (built.match(/LONG SYSTEM PROMPT/g) ?? []).length;
		expect(occurrences).toBe(1);
		expect(built).toContain("second request");
		expect(built).toContain("result");
	});
});

describe("deepseek-web-v2 buildPrompt (lean conversation on follow-up turns)", () => {
	const msg = (role: string, text: string) =>
		({ role, content: [{ type: "text", text }] }) as never;

	it("drops prior user + assistant messages, keeps only the last user message", () => {
		const prompt = [
			msg("system", "sys"),
			msg("user", "first question"),
			msg("assistant", "the first answer"),
			msg("user", "second question"),
			msg("assistant", "the second answer"),
			msg("user", "latest question"),
		] as never;
		const built = buildPrompt(prompt, undefined);
		expect(built).toContain("latest question");
		expect(built).not.toContain("first question");
		expect(built).not.toContain("second question");
		expect(built).not.toContain("the first answer");
		expect(built).not.toContain("the second answer");
		expect(built).not.toContain("sys");
	});

	it("keeps trailing tool results that follow the last user message", () => {
		const prompt = [
			msg("system", "sys"),
			msg("user", "do the thing"),
			msg("assistant", "ok"),
			msg("tool", "the latest result"),
		] as never;
		const built = buildPrompt(prompt, undefined);
		expect(built).toContain("do the thing");
		expect(built).toContain("the latest result");
		expect(built).not.toContain("ok");
		expect(built).not.toContain("sys");
	});

	it("keeps all tool results that follow the last user message", () => {
		const prompt = [
			msg("system", "sys"),
			msg("user", "run it"),
			msg("tool", "first result"),
			msg("assistant", "mid"),
			msg("tool", "second result"),
		] as never;
		const built = buildPrompt(prompt, undefined);
		expect(built).toContain("first result");
		expect(built).toContain("second result");
		expect(built).not.toContain("mid");
	});

	it("drops a tool result from an earlier user turn", () => {
		const prompt = [
			msg("system", "sys"),
			msg("user", "first request"),
			msg("tool", "stale result"),
			msg("assistant", "mid"),
			msg("user", "second request"),
			msg("tool", "fresh result"),
		] as never;
		const built = buildPrompt(prompt, undefined);
		expect(built).toContain("second request");
		expect(built).toContain("fresh result");
		expect(built).not.toContain("first request");
		expect(built).not.toContain("stale result");
		expect(built).not.toContain("mid");
	});

	it("preserves the compaction summary on the first turn that opens the new chat", () => {
		const prompt = [
			msg("system", "sys"),
			msg("user", "Context summary:\n\nWe listed the Downloads folder."),
			msg("user", "continue"),
		] as never;
		// `preserveCompactionContext` is true when `isNewChat` is true (the very
		// first call after /compact opens a fresh DeepSeek web chat).
		const built = buildPrompt(prompt, undefined, true, true);
		// The compaction summary must survive the lean trimmer so the fresh
		// DeepSeek web chat is re-seeded with the compacted context.
		expect(built).toContain("Context summary:");
		expect(built).toContain("We listed the Downloads folder.");
		expect(built).toContain("continue");
	});

	it("drops the compaction summary on later turns once the web chat has it server-side", () => {
		const prompt = [
			msg("system", "sys"),
			msg("user", "Context summary:\n\nWe listed the Downloads folder."),
			msg("user", "continue"),
		] as never;
		// On subsequent turns `isNewChat` is false → `preserveCompactionContext`
		// is false → the summary is not re-sent (the web chat already holds it).
		const built = buildPrompt(prompt, undefined, false, false);
		expect(built).toContain("continue");
		expect(built).not.toContain("Context summary:");
	});

	it("re-injects the system prompt for a compaction-transition new chat", () => {
		const prompt = [
			msg("system", "LONG SYSTEM PROMPT"),
			msg("user", "Context summary:\n\nWe listed the Downloads folder."),
			msg("user", "continue"),
		] as never;
		const built = buildPrompt(prompt, undefined, true, true);
		// A fresh DeepSeek chat after compaction must be re-taught the tool
		// contract once, exactly once.
		const occurrences = (built.match(/LONG SYSTEM PROMPT/g) ?? []).length;
		expect(occurrences).toBe(1);
		expect(built).toContain("Context summary:");
		expect(built).toContain("continue");
	});
});

describe("deepseek-web-v2 estimateDeepSeekWebUsage", () => {
	it("estimates input from the exact prompt string and output from the reply", () => {
		const usage = estimateDeepSeekWebUsage("x".repeat(300), "hello world");

		expect(usage.inputTokens).toBe(100);
		expect(usage.outputTokens).toBe(4);
		expect(usage.totalTokens).toBe(104);
	});

	it("never reports zero tokens", () => {
		const usage = estimateDeepSeekWebUsage("", "");

		expect(usage.inputTokens).toBe(1);
		expect(usage.outputTokens).toBe(1);
		expect(usage.totalTokens).toBe(2);
	});

	it("scales with both prompt and reply length", () => {
		const small = estimateDeepSeekWebUsage("a".repeat(30), "b".repeat(30));
		const large = estimateDeepSeekWebUsage(
			"a".repeat(3_000),
			"b".repeat(3_000),
		);

		expect(large.inputTokens).toBeGreaterThan(small.inputTokens * 10);
		expect(large.outputTokens).toBeGreaterThan(small.outputTokens * 10);
	});
});

describe("deepseek-web-v2 chat continuity (start_continue_chat.py parity)", () => {
	const userMsg = (text: string) =>
		({ role: "user", content: [{ type: "text", text }] }) as never;
	const sysMsg = (text: string) =>
		({ role: "system", content: [{ type: "text", text }] }) as never;

	it("derives a stable key from the first user message across turns", () => {
		const firstTurn = [sysMsg("sys"), userMsg("Fix the sidebar")] as never;
		const followUp = [
			sysMsg("sys"),
			userMsg("Fix the sidebar"),
			{ role: "assistant", content: "ok" } as never,
			userMsg("also center the text") as never,
		] as never;

		// Same first user message -> same key (this is what lets a resumed or
		// continued CLI chat reopen the same DeepSeek web chat).
		expect(chatKeyFromPrompt(firstTurn)).toBe(chatKeyFromPrompt(followUp));
	});

	it("produces a different key for a different first user message", () => {
		expect(chatKeyFromPrompt([userMsg("Fix the sidebar")] as never)).not.toBe(
			chatKeyFromPrompt([userMsg("Write a backend")] as never),
		);
	});

	it("stays deterministic across restarts", () => {
		const prompt = [userMsg("Refactor the CLI")] as never;
		expect(chatKeyFromPrompt(prompt)).toBe(chatKeyFromPrompt(prompt));
	});

	it("parses a session id out of a DeepSeek chat URL", () => {
		expect(
			parseSessionIdFromUrl("https://chat.deepseek.com/a/chat/s/abc123def"),
		).toBe("abc123def");
		expect(parseSessionIdFromUrl("https://chat.deepseek.com/")).toBeUndefined();
		expect(parseSessionIdFromUrl("")).toBeUndefined();
	});

	it("round-trips a CLI chat mapping through the registry file", () => {
		const dir = mkdtempSync(join(tmpdir(), "dsweb-v2-"));
		try {
			const chatsFile = join(dir, "chats.json");
			const chatKey = "clikey1";
			expect(lookupChatSession(chatsFile, chatKey)).toBeUndefined();

			recordChatSession(chatsFile, chatKey, "sess_new");
			expect(lookupChatSession(chatsFile, chatKey)).toBe("sess_new");

			// Re-recording keeps the original first_seen but refreshes last_active.
			recordChatSession(chatsFile, chatKey, "sess_new");
			expect(lookupChatSession(chatsFile, chatKey)).toBe("sess_new");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps separate DeepSeek chats for separate CLI conversations", () => {
		const dir = mkdtempSync(join(tmpdir(), "dsweb-v2-"));
		try {
			const chatsFile = join(dir, "chats.json");
			const keyA = chatKeyFromPrompt([userMsg("Task A")] as never);
			const keyB = chatKeyFromPrompt([userMsg("Task B")] as never);
			recordChatSession(chatsFile, keyA, "sess_a");
			recordChatSession(chatsFile, keyB, "sess_b");
			expect(lookupChatSession(chatsFile, keyA)).toBe("sess_a");
			expect(lookupChatSession(chatsFile, keyB)).toBe("sess_b");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
