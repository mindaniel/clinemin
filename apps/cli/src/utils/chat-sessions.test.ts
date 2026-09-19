import { describe, expect, it, vi } from "vitest";
import {
	type ChatCommandContext,
	type ConnectorSessionSummary,
	maybeHandleChatCommand,
	resolveSessionReference,
} from "./chat-commands";

const ZEN: ConnectorSessionSummary = {
	sessionId: "01JB4FAAAAAAAAAAAAAAAAAAAA",
	title: "refactor the auth module",
	model: "deepseek-chat",
	cwd: "C:/work/clinemin",
	unattended: true,
};
const TUI: ConnectorSessionSummary = {
	sessionId: "01JB4FBBBBBBBBBBBBBBBBBBBB",
	model: "claude-sonnet-4.6",
	unattended: false,
};

function baseContext(
	overrides: Partial<ChatCommandContext> = {},
): ChatCommandContext {
	return {
		enabled: true,
		getState: async () => ({
			enableTools: true,
			autoApproveTools: false,
			cwd: "/tmp",
			workspaceRoot: "/tmp",
		}),
		setState: async () => undefined,
		reply: async () => undefined,
		...overrides,
	};
}

/** The reply text for call `index`, failing the test rather than returning undefined. */
function replyText(reply: ReplyMock, index = 0): string {
	const text = reply.mock.calls.at(index)?.[0];
	expect(typeof text).toBe("string");
	return text as string;
}

type ReplyMock = ReturnType<typeof createReply>;

function createReply() {
	return vi.fn<(text: string) => Promise<void>>(async () => undefined);
}

describe("resolveSessionReference", () => {
	it("takes a short prefix, which is all you can retype on a phone", () => {
		const resolved = resolveSessionReference([ZEN, TUI], "01JB4FAA");
		expect(resolved.ok).toBe(true);
		if (resolved.ok) {
			expect(resolved.session.sessionId).toBe(ZEN.sessionId);
		}
	});

	it("takes the full id too", () => {
		const resolved = resolveSessionReference([ZEN, TUI], ZEN.sessionId);
		expect(resolved.ok).toBe(true);
	});

	it("refuses an ambiguous prefix instead of guessing", () => {
		// Guessing the newest of two matches sends the message into the wrong job,
		// and nothing about the reply would say so.
		const resolved = resolveSessionReference([ZEN, TUI], "01JB4F");
		expect(resolved.ok).toBe(false);
		if (!resolved.ok) {
			expect(resolved.error).toContain("matches 2");
		}
	});

	it("says so when nothing matches", () => {
		const resolved = resolveSessionReference([ZEN], "zzz");
		expect(resolved.ok).toBe(false);
		if (!resolved.ok) {
			expect(resolved.error).toContain("/sessions");
		}
	});
});

describe("/sessions", () => {
	it("lists sessions and marks the attached one", async () => {
		const reply = createReply();
		const handled = await maybeHandleChatCommand(
			"/sessions",
			baseContext({
				reply,
				sessions: {
					list: async () => [ZEN, TUI],
					attached: async () => TUI.sessionId,
				},
			}),
		);

		expect(handled).toBe(true);
		const text = replyText(reply);
		expect(text).toContain("01JB4FAA");
		expect(text).toContain("unattended");
		expect(text).toContain("has a client");
		// The marker sits on the attached row and nowhere else.
		const attachedLine = text
			.split("\n")
			.find((line) => line.includes("01JB4FBB"));
		expect(attachedLine?.startsWith("▶")).toBe(true);
	});

	it("points at --zen when the hub has nothing", async () => {
		const reply = createReply();
		await maybeHandleChatCommand(
			"/sessions",
			baseContext({ reply, sessions: { list: async () => [] } }),
		);
		expect(replyText(reply)).toContain("--zen");
	});

	it("is not offered when the host cannot list sessions", async () => {
		const reply = createReply();
		const handled = await maybeHandleChatCommand(
			"/sessions",
			baseContext({ reply }),
		);
		expect(handled).toBe(false);
		expect(reply).not.toHaveBeenCalled();
	});
});

describe("/attach", () => {
	it("attaches by prefix", async () => {
		const attach = vi.fn(
			async (id: string) => `Attached to ${id.slice(0, 8)}.`,
		);
		const reply = createReply();
		await maybeHandleChatCommand(
			"/attach 01JB4FAA",
			baseContext({
				reply,
				sessions: { list: async () => [ZEN, TUI], attach },
			}),
		);
		expect(attach).toHaveBeenCalledWith(ZEN.sessionId);
		expect(replyText(reply)).toContain("Attached to 01JB4FAA");
	});

	it("warns up front when the target answers its own approvals", async () => {
		// Otherwise the first tool call parks the turn and, from the phone, the
		// session just looks like it stopped replying.
		const reply = createReply();
		await maybeHandleChatCommand(
			"/attach 01JB4FBB",
			baseContext({
				reply,
				sessions: {
					list: async () => [ZEN, TUI],
					attach: async () => "Attached.",
				},
			}),
		);
		const text = replyText(reply);
		expect(text).toContain("Heads up");
		expect(text).toContain("--zen");
	});

	it("does not warn for an unattended session", async () => {
		const reply = createReply();
		await maybeHandleChatCommand(
			"/attach 01JB4FAA",
			baseContext({
				reply,
				sessions: {
					list: async () => [ZEN, TUI],
					attach: async () => "Attached.",
				},
			}),
		);
		expect(replyText(reply)).not.toContain("Heads up");
	});

	it("asks for an id when given none", async () => {
		const attach = vi.fn(async () => "nope");
		const reply = createReply();
		await maybeHandleChatCommand(
			"/attach",
			baseContext({ reply, sessions: { list: async () => [ZEN], attach } }),
		);
		expect(attach).not.toHaveBeenCalled();
		expect(replyText(reply)).toContain("/sessions");
	});
});

describe("/detach", () => {
	it("reports what it detached from", async () => {
		const reply = createReply();
		await maybeHandleChatCommand(
			"/detach",
			baseContext({
				reply,
				sessions: { detach: async () => "Detached from 01JB4FAA." },
			}),
		);
		expect(reply).toHaveBeenCalledWith("Detached from 01JB4FAA.");
	});
});
