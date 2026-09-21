import { afterEach, describe, expect, it, vi } from "vitest";
import { startSessionMirror, stopAllSessionMirrors } from "./session-mirror";

type Handler = (event: {
	sessionId: string;
	eventType: string;
	payload: Record<string, unknown>;
}) => void;

function setup() {
	let onEvent: Handler = () => undefined;
	const posted: string[] = [];
	startSessionMirror({
		thread: { id: "telegram:1" } as never,
		sessionId: "s_1",
		client: {
			streamEvents: (_filter: unknown, handlers: { onEvent: Handler }) => {
				onEvent = handlers.onEvent;
				return () => undefined;
			},
		} as never,
		clientId: "telegram-test",
		transport: "telegram",
		logger: { core: { log: vi.fn() } } as never,
		pendingApprovals: new Map(),
		post: async (text) => {
			posted.push(text);
		},
	});
	const emit = (eventType: string, payload: Record<string, unknown> = {}) =>
		onEvent({ sessionId: "s_1", eventType, payload });
	return { emit, posted };
}

afterEach(() => stopAllSessionMirrors());

describe("session mirror", () => {
	it("posts the model's text when an iteration ends, without waiting for the turn to end", () => {
		// A turn run from the hub's queue: its reply must reach the phone even
		// though no terminal event with text follows.
		const { emit, posted } = setup();
		emit("runtime.chat.text_delta", { text: "Here is what I found." });
		emit("runtime.chat.iteration_end");
		expect(posted).toEqual(["Here is what I found."]);
	});

	it("posts text before the tool status that follows it", () => {
		const { emit, posted } = setup();
		emit("runtime.chat.text_delta", { text: "Let me look." });
		emit("runtime.chat.tool_call_start", {
			toolName: "read_files",
			input: { paths: ["a.ts"] },
		});
		expect(posted[0]).toBe("Let me look.");
		expect(posted.length).toBe(2);
	});

	it("does not post the same text twice at the end of the turn", () => {
		const { emit, posted } = setup();
		emit("runtime.chat.text_delta", { text: "Done." });
		emit("runtime.chat.iteration_end");
		emit("runtime.chat.completed", { result: { text: "Done." } });
		expect(posted).toEqual(["Done."]);
	});

	it("falls back to the result text when nothing streamed", () => {
		const { emit, posted } = setup();
		emit("runtime.chat.completed", { result: { text: "Final answer." } });
		expect(posted).toEqual(["Final answer."]);
	});
});
