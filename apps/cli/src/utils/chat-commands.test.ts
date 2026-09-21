import { describe, expect, it, vi } from "vitest";
import {
	createChatCommandHost,
	isCommandAddressedToBot,
	maybeHandleChatCommand,
	normalizeCommandName,
	resolveSessionReference,
	shortSessionLabel,
} from "./chat-commands";

describe("chat commands", () => {
	it("shows connector help for /help and /start", async () => {
		for (const { command, botUserName } of [
			{ command: "/help" },
			{ command: "/start" },
			{ command: "/help@clinebot", botUserName: "clinebot" },
			{ command: "/start@cline_bot", botUserName: "@cline_bot" },
		]) {
			const reply = vi.fn(async () => undefined);

			const handled = await maybeHandleChatCommand(command, {
				enabled: true,
				botUserName,
				getState: async () => ({
					enableTools: true,
					autoApproveTools: false,
					cwd: "/tmp",
					workspaceRoot: "/tmp",
				}),
				setState: async () => undefined,
				reply,
			});

			expect(handled).toBe(true);
			expect(reply).toHaveBeenCalledWith(
				expect.stringContaining("Cline connector commands:"),
			);
			expect(reply).toHaveBeenCalledWith(
				expect.stringContaining("Current state: tools=on, yolo=off"),
			);
			expect(reply).toHaveBeenCalledWith(
				expect.stringContaining(
					"/schedule create/list/trigger/delete - manage scheduled workflows",
				),
			);
			expect(reply).toHaveBeenCalledWith(
				expect.stringContaining(
					"When tools are on, I can inspect files, edit code, run commands/tests, and help prepare PRs.",
				),
			);
		}
	});

	it("does not handle bot-suffixed commands addressed to another bot", async () => {
		const reply = vi.fn(async () => undefined);

		const handled = await maybeHandleChatCommand("/help@otherbot", {
			enabled: true,
			botUserName: "clinebot",
			getState: async () => ({
				enableTools: true,
				autoApproveTools: false,
				cwd: "/tmp",
				workspaceRoot: "/tmp",
			}),
			setState: async () => undefined,
			reply,
		});

		expect(handled).toBe(false);
		expect(reply).not.toHaveBeenCalled();
	});

	it("requires a bot suffix when requested", async () => {
		const reply = vi.fn(async () => undefined);
		const context = {
			enabled: true,
			botUserName: "clinebot",
			requireBotMention: true,
			getState: async () => ({
				enableTools: true,
				autoApproveTools: false,
				cwd: "/tmp",
				workspaceRoot: "/tmp",
			}),
			setState: async () => undefined,
			reply,
		};

		expect(await maybeHandleChatCommand("/help", context)).toBe(false);
		expect(reply).not.toHaveBeenCalled();

		expect(await maybeHandleChatCommand("/help@clinebot", context)).toBe(true);
		expect(reply).toHaveBeenCalledWith(
			expect.stringContaining("Cline connector commands:"),
		);
	});

	it("detects commands addressed to the configured bot", () => {
		expect(isCommandAddressedToBot("/new@clinebot", "clinebot")).toBe(true);
		expect(isCommandAddressedToBot("/new@cline_bot", "@cline_bot")).toBe(true);
		expect(isCommandAddressedToBot("/new@cline.bot", "cline.bot")).toBe(true);
		expect(isCommandAddressedToBot("/new@cline-bot", "cline-bot")).toBe(true);
		expect(isCommandAddressedToBot("/new", "clinebot")).toBe(false);
		expect(isCommandAddressedToBot("/new@otherbot", "clinebot")).toBe(false);
		expect(isCommandAddressedToBot("/new@clinebot", undefined)).toBe(false);
	});

	it("normalizes commands addressed to dotted and hyphenated bot names", () => {
		expect(normalizeCommandName("/new@cline.bot", "cline.bot")).toBe("/new");
		expect(normalizeCommandName("/new@cline-bot", "cline-bot")).toBe("/new");
	});

	it("leaves bot-suffixed commands unmatched without a known bot username", async () => {
		const reply = vi.fn(async () => undefined);

		const handled = await maybeHandleChatCommand("/help@clinebot", {
			enabled: true,
			getState: async () => ({
				enableTools: true,
				autoApproveTools: false,
				cwd: "/tmp",
				workspaceRoot: "/tmp",
			}),
			setState: async () => undefined,
			reply,
		});

		expect(handled).toBe(false);
		expect(reply).not.toHaveBeenCalled();
	});

	it("explains when tool controls are locked by startup", async () => {
		const reply = vi.fn(async () => undefined);

		const handled = await maybeHandleChatCommand("/help", {
			enabled: true,
			getState: async () => ({
				enableTools: false,
				autoApproveTools: false,
				cwd: "/tmp",
				workspaceRoot: "/tmp",
				toolsLocked: true,
			}),
			setState: async () => undefined,
			reply,
		});

		expect(handled).toBe(true);
		expect(reply).toHaveBeenCalledWith(
			expect.stringContaining(
				"Tool controls are locked because this connector was started with --no-tools.",
			),
		);
	});

	it("treats /new as a reset alias", async () => {
		const reset = vi.fn(async () => undefined);
		const reply = vi.fn(async () => undefined);

		const handled = await maybeHandleChatCommand("/new", {
			enabled: true,
			getState: async () => ({
				enableTools: false,
				autoApproveTools: false,
				cwd: "/tmp",
				workspaceRoot: "/tmp",
			}),
			setState: async () => undefined,
			reply,
			reset,
		});

		expect(handled).toBe(true);
		expect(reset).toHaveBeenCalledTimes(1);
		expect(reply).toHaveBeenCalledWith("Started a fresh session.");
	});

	it("supports registering reusable commands on a host", async () => {
		const reply = vi.fn(async () => undefined);
		const host = createChatCommandHost().register("command", {
			names: ["/echo"],
			run: async ({ args }, context) => {
				await context.reply(args.join(" "));
			},
		});

		const handled = await host.handle("/echo hello world", {
			enabled: true,
			getState: async () => ({
				enableTools: false,
				autoApproveTools: false,
				cwd: "/tmp",
				workspaceRoot: "/tmp",
			}),
			setState: async () => undefined,
			reply,
		});

		expect(handled).toBe(true);
		expect(reply).toHaveBeenCalledWith("hello world");
	});

	it("shows usage for /team with no arguments", async () => {
		const reply = vi.fn(async () => undefined);

		const handled = await maybeHandleChatCommand("/team", {
			enabled: true,
			getState: async () => ({
				enableTools: false,
				autoApproveTools: false,
				cwd: "/tmp",
				workspaceRoot: "/tmp",
			}),
			setState: async () => undefined,
			reply,
		});

		expect(handled).toBe(true);
		expect(reply).toHaveBeenCalledWith(
			"Usage: /team <task description>\nStarts a team of agents for the given task.",
		);
	});

	it("replies with unsupported message for /team with arguments in default host", async () => {
		const reply = vi.fn(async () => undefined);

		const handled = await maybeHandleChatCommand("/team build a web app", {
			enabled: true,
			getState: async () => ({
				enableTools: false,
				autoApproveTools: false,
				cwd: "/tmp",
				workspaceRoot: "/tmp",
			}),
			setState: async () => undefined,
			reply,
		});

		expect(handled).toBe(true);
		expect(reply).toHaveBeenCalledWith(
			"The /team command must be entered directly as a prompt, not via a chat command.",
		);
	});

	it("runs /fork and replies with forked session ids", async () => {
		const reply = vi.fn(async () => undefined);
		const fork = vi.fn(async () => ({
			forkedFromSessionId: "sess_original",
			newSessionId: "sess_fork",
		}));

		const handled = await maybeHandleChatCommand("/fork", {
			enabled: true,
			getState: async () => ({
				enableTools: false,
				autoApproveTools: false,
				cwd: "/tmp",
				workspaceRoot: "/tmp",
			}),
			setState: async () => undefined,
			reply,
			fork,
		});

		expect(handled).toBe(true);
		expect(fork).toHaveBeenCalledTimes(1);
		expect(reply).toHaveBeenCalledWith(
			"Forked session sess_original into new session sess_fork. This is now the active session. Use /history to switch sessions.",
		);
	});

	it("replies with failure message when fork returns undefined", async () => {
		const reply = vi.fn(async () => undefined);
		const fork = vi.fn(async () => undefined);

		const handled = await maybeHandleChatCommand("/fork", {
			enabled: true,
			getState: async () => ({
				enableTools: false,
				autoApproveTools: false,
				cwd: "/tmp",
				workspaceRoot: "/tmp",
			}),
			setState: async () => undefined,
			reply,
			fork,
		});

		expect(handled).toBe(true);
		expect(fork).toHaveBeenCalledTimes(1);
		expect(reply).toHaveBeenCalledWith(
			"Fork failed: could not read messages from the current session.",
		);
	});

	it("surfaces thrown error message when fork throws", async () => {
		const reply = vi.fn(async () => undefined);
		const fork = vi.fn(async () => {
			throw new Error("Cannot fork an empty session.");
		});

		const handled = await maybeHandleChatCommand("/fork", {
			enabled: true,
			getState: async () => ({
				enableTools: false,
				autoApproveTools: false,
				cwd: "/tmp",
				workspaceRoot: "/tmp",
			}),
			setState: async () => undefined,
			reply,
			fork,
		});

		expect(handled).toBe(true);
		expect(fork).toHaveBeenCalledTimes(1);
		expect(reply).toHaveBeenCalledWith("Cannot fork an empty session.");
	});

	it("ignores /fork when fork callback is not provided", async () => {
		const reply = vi.fn(async () => undefined);

		const handled = await maybeHandleChatCommand("/fork", {
			enabled: true,
			getState: async () => ({
				enableTools: false,
				autoApproveTools: false,
				cwd: "/tmp",
				workspaceRoot: "/tmp",
			}),
			setState: async () => undefined,
			reply,
			// No fork callback, so the command should not be available.
		});

		// isAvailable returns false when fork is not defined, so the command
		// is not matched and the handler returns false.
		expect(handled).toBe(false);
		expect(reply).not.toHaveBeenCalled();
	});

	it("runs /abort without disconnecting", async () => {
		const abort = vi.fn(async () => undefined);
		const reply = vi.fn(async () => undefined);

		const handled = await maybeHandleChatCommand("/abort", {
			enabled: true,
			getState: async () => ({
				enableTools: false,
				autoApproveTools: false,
				cwd: "/tmp",
				workspaceRoot: "/tmp",
			}),
			setState: async () => undefined,
			reply,
			abort,
		});

		expect(handled).toBe(true);
		expect(abort).toHaveBeenCalledTimes(1);
		expect(reply).not.toHaveBeenCalled();
	});
});

describe("session labels", () => {
	// Two CLIs started together: same millisecond-prefix, different tail.
	const sessions = [
		{ sessionId: "1789945712345_iua87", unattended: true },
		{ sessionId: "1789945798765_njnwb", unattended: true },
	] as never as Parameters<typeof resolveSessionReference>[0];

	it("labels sessions by the part that actually differs", () => {
		expect(shortSessionLabel("1789945712345_iua87")).toBe("iua87");
		expect(shortSessionLabel("1789945798765_njnwb")).toBe("njnwb");
		// An id with no tail falls back to a prefix.
		expect(shortSessionLabel("01JABCDEFGHJKMNPQRSTVWXYZ")).toBe("01JABCDE");
	});

	it("resolves the label the list showed", () => {
		const resolved = resolveSessionReference(sessions, "njnwb");
		expect(resolved.ok && resolved.session.sessionId).toBe(
			"1789945798765_njnwb",
		);
	});

	it("still resolves a full id and a unique prefix", () => {
		expect(resolveSessionReference(sessions, "1789945712345_iua87").ok).toBe(
			true,
		);
		expect(resolveSessionReference(sessions, "17899457123").ok).toBe(true);
	});

	it("refuses a prefix both sessions share instead of guessing", () => {
		const resolved = resolveSessionReference(sessions, "17899457");
		expect(resolved.ok).toBe(false);
		expect(!resolved.ok && resolved.error).toContain("matches 2 sessions");
	});
});

describe("live sessions", () => {
	// One the hub runs, one stopped, one a TUI still has open on its local
	// backend, one from an older hub that cannot tell.
	const rows = [
		{ sessionId: "1789946300000_hubok", unattended: true, live: true },
		{ sessionId: "1789946100000_stopd", unattended: false, live: false },
		{
			sessionId: "1789946386463_mgsr5",
			unattended: false,
			live: false,
			heldByPid: 15032,
		},
		{ sessionId: "1789946200000_oldhb", unattended: true },
	];
	const context = (reply: (text: string) => Promise<void>) => ({
		enabled: true,
		getState: async () => ({
			enableTools: true,
			autoApproveTools: false,
			cwd: "/tmp",
			workspaceRoot: "/tmp",
		}),
		setState: async () => undefined,
		reply,
		sessions: {
			list: async () => rows,
			attached: async () => undefined,
			attach: vi.fn(
				async (id: string, _options?: { revive?: boolean }) =>
					`Attached to ${id}.`,
			),
			detach: async () => "Detached.",
		},
	});

	it("/sessions lists every session with what state it is in", async () => {
		const reply = vi.fn(async (_text: string) => undefined);
		await maybeHandleChatCommand("/sessions", context(reply));
		const text = reply.mock.calls[0]?.[0] ?? "";
		expect(text).toContain("hubok · running, unattended");
		expect(text).toContain("stopd · stopped");
		expect(text).toContain("mgsr5 · open in a TUI (pid 15032)");
		expect(text).toContain("oldhb · running");
	});

	it("/attach revives a stopped session", async () => {
		const reply = vi.fn(async (_text: string) => undefined);
		const ctx = context(reply);
		await maybeHandleChatCommand("/attach stopd", ctx);
		expect(ctx.sessions.attach).toHaveBeenCalledWith("1789946100000_stopd", {
			revive: true,
		});
		// Revived by this connector, so no "approvals go elsewhere" warning.
		expect(reply.mock.calls[0]?.[0]).not.toContain("Heads up");
	});

	it("/attach refuses a session a TUI still has open", async () => {
		const reply = vi.fn(async (_text: string) => undefined);
		const ctx = context(reply);
		await maybeHandleChatCommand("/attach mgsr5", ctx);
		expect(ctx.sessions.attach).not.toHaveBeenCalled();
		expect(reply.mock.calls[0]?.[0]).toContain("Close that TUI");
	});

	it("/attach attaches a live session without reviving it", async () => {
		const reply = vi.fn(async (_text: string) => undefined);
		const ctx = context(reply);
		await maybeHandleChatCommand("/attach hubok", ctx);
		expect(ctx.sessions.attach).toHaveBeenCalledWith("1789946300000_hubok", {
			revive: false,
		});
	});
});
