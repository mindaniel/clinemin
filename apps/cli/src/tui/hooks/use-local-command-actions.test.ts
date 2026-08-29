import { describe, expect, it, vi } from "vitest";
import { formatCompactionStatus } from "../utils/compaction-status";
import {
	type LocalSlashCommandActionInput,
	runLocalSlashCommandAction,
} from "./local-command-actions";

function makeActions(
	overrides: Partial<Omit<LocalSlashCommandActionInput, "name">> = {},
): Omit<LocalSlashCommandActionInput, "name"> {
	return {
		isRunning: false,
		openAccount: vi.fn(),
		openConfig: vi.fn(),
		openMcpManager: vi.fn(async () => false),
		openModelSelector: vi.fn(),
		openSkills: vi.fn(),
		runCompact: vi.fn(),
		runAutocompact: vi.fn(async () => false),
		runFork: vi.fn(),
		runUndo: vi.fn(async () => {}),
		clearConversation: vi.fn(async () => {}),
		openHelp: vi.fn(),
		openHistory: vi.fn(),
		exitCline: vi.fn(),
		findChat: vi.fn(async () => true),
		pasteReply: vi.fn(async () => true),
		setNote: vi.fn(() => true),
		switchProfile: vi.fn(async () => true),
		...overrides,
	};
}

describe("runLocalSlashCommandAction", () => {
	it("opens the skills picker with skills", () => {
		const openSkills = vi.fn();
		const actions = makeActions({ openSkills });
		const invocation = {
			text: "please /skills",
			cursorOffset: "please /skills".length,
			replaceRange: { start: "please ".length, end: "please /skills".length },
		};

		const handled = runLocalSlashCommandAction({
			name: "skills",
			invocation,
			...actions,
		});

		expect(handled).toBe(true);
		expect(openSkills).toHaveBeenCalledWith(invocation);
	});

	it("opens settings to the plugins tab with plugins", () => {
		const openConfig = vi.fn();
		const actions = makeActions({ openConfig });

		const handled = runLocalSlashCommandAction({
			name: "plugins",
			...actions,
		});

		expect(handled).toBe(true);
		expect(openConfig).toHaveBeenCalledWith({ initialTab: "plugins" });
	});

	it("does not start compaction while a turn is running", () => {
		const runCompact = vi.fn();
		const actions = makeActions({ isRunning: true, runCompact });

		const handled = runLocalSlashCommandAction({
			name: "compact",
			...actions,
		});

		expect(handled).toBe(true);
		expect(runCompact).not.toHaveBeenCalled();
	});

	it("starts compaction while the session is idle", () => {
		const runCompact = vi.fn();
		const actions = makeActions({ runCompact });

		const handled = runLocalSlashCommandAction({
			name: "compact",
			...actions,
		});

		expect(handled).toBe(true);
		expect(runCompact).toHaveBeenCalledOnce();
	});

	it("invokes findChat for the /findchat command", async () => {
		const findChat = vi.fn(async () => true);
		const actions = makeActions({ findChat });

		const handled = runLocalSlashCommandAction({
			name: "findchat",
			...actions,
		});

		await expect(handled).resolves.toBe(true);
		expect(findChat).toHaveBeenCalledOnce();
	});

	it("parses the autocompact argument (with suffix) and runs it", async () => {
		const runAutocompact = vi.fn(async () => true);
		const actions = makeActions({ runAutocompact });

		const handled = await runLocalSlashCommandAction({
			name: "autocompact",
			invocation: { text: "/autocompact 1M", cursorOffset: 13 },
			...actions,
		});

		expect(handled).toBe(true);
		expect(runAutocompact).toHaveBeenCalledWith(1_000_000);
	});

	it("passes undefined to autocompact when no argument is given", async () => {
		const runAutocompact = vi.fn(async () => false);
		const actions = makeActions({ runAutocompact });

		const handled = await runLocalSlashCommandAction({
			name: "autocompact",
			...actions,
		});

		expect(handled).toBe(false);
		expect(runAutocompact).toHaveBeenCalledWith(undefined);
	});

	it("waits for clear to reset the runtime session", async () => {
		let resolveClear: (() => void) | undefined;
		const clearConversation = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveClear = resolve;
				}),
		);
		const actions = makeActions({ clearConversation });

		const handled = runLocalSlashCommandAction({
			name: "clear",
			...actions,
		});
		const handledPromise = Promise.resolve(handled);
		let settled = false;
		void handledPromise.then(() => {
			settled = true;
		});

		await Promise.resolve();

		expect(clearConversation).toHaveBeenCalledOnce();
		expect(settled).toBe(false);

		resolveClear?.();

		expect(await handledPromise).toBe(true);
		expect(settled).toBe(true);
	});

	it("waits for undo to finish restoring", async () => {
		let resolveUndo: (() => void) | undefined;
		const runUndo = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveUndo = resolve;
				}),
		);
		const actions = makeActions({ runUndo });

		const handled = runLocalSlashCommandAction({
			name: "undo",
			...actions,
		});
		const handledPromise = Promise.resolve(handled);
		let settled = false;
		void handledPromise.then(() => {
			settled = true;
		});

		await Promise.resolve();

		expect(runUndo).toHaveBeenCalledOnce();
		expect(settled).toBe(false);

		resolveUndo?.();

		expect(await handledPromise).toBe(true);
		expect(settled).toBe(true);
	});

	it("exits Cline with quit", () => {
		vi.useFakeTimers();
		const exitCline = vi.fn();
		const actions = makeActions({ exitCline });

		try {
			const handled = runLocalSlashCommandAction({
				name: "quit",
				...actions,
			});

			expect(handled).toBe(true);
			expect(exitCline).not.toHaveBeenCalled();

			vi.runAllTimers();

			expect(exitCline).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("formatCompactionStatus", () => {
	it("reports when core did not return a compaction result", () => {
		expect(
			formatCompactionStatus({
				messagesBefore: 300,
				messagesAfter: 300,
				compacted: false,
			}),
		).toBe("No compaction needed.");
	});

	it("reports same-count compaction without implying no-op", () => {
		expect(
			formatCompactionStatus({
				messagesBefore: 300,
				messagesAfter: 300,
				compacted: true,
			}),
		).toBe("Compacted context; message count stayed at 300 messages.");
	});

	it("reports empty sessions separately", () => {
		expect(
			formatCompactionStatus({
				messagesBefore: 0,
				messagesAfter: 0,
				compacted: false,
			}),
		).toBe("No messages to compact.");
	});
});
