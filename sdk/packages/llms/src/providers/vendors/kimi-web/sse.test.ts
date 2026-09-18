import { describe, expect, it } from "vitest";
import { consumeKimiSse } from "./sse";

/**
 * Frames shaped exactly like a real Kimi stream.
 *
 * Taken from a captured body in `~/.cline/rawjsonhistory/kimi-web`: a run of
 * length-prefixed JSON objects, no `data:` lines at all, where eventOffset 2 is
 * the message WE sent echoed back with `role: "user"` and the reply arrives
 * afterwards as `block.text` / `block.text.content` deltas.
 */
const ECHOED_USER_TEXT =
	"<manager>\nTO: deepseek\nYour message here.\n</manager>";

function frame(value: unknown): string {
	// The real stream separates frames with a 4-byte length prefix. Written
	// as escapes, not literal NULs: literal ones make git treat this whole
	// file as binary, so it would never show a reviewable diff again.
	return `\u0000\u0000\u0000\u0000${JSON.stringify(value)}`;
}

const STREAM = [
	frame({ heartbeat: {} }),
	frame({
		op: "set",
		mask: "chat.lastRequest",
		eventOffset: 1,
		chat: { id: "c1", lastRequest: { options: { model: "k2d6-chat" } } },
	}),
	frame({
		op: "set",
		mask: "message",
		eventOffset: 2,
		message: {
			id: "m1",
			role: "user",
			status: "MESSAGE_STATUS_COMPLETED",
			blocks: [{ messageId: "", text: { content: ECHOED_USER_TEXT } }],
		},
	}),
	frame({
		op: "set",
		mask: "message",
		eventOffset: 3,
		message: {
			id: "m2",
			role: "assistant",
			status: "MESSAGE_STATUS_GENERATING",
			blocks: [],
		},
	}),
	frame({
		op: "set",
		mask: "block.text",
		eventOffset: 5,
		block: { id: "1", text: { content: "I will " } },
	}),
	frame({
		op: "append",
		mask: "block.text.content",
		eventOffset: 6,
		block: { id: "1", text: { content: "check the code." } },
	}),
	frame({ op: "set", mask: "chat.name", eventOffset: 7, chat: { name: "x" } }),
].join("");

function collect(body: string): string {
	let text = "";
	consumeKimiSse(
		body,
		(chunk) => {
			text += chunk;
		},
		() => {},
		() => {},
	);
	return text;
}

describe("consumeKimiSse", () => {
	it("returns only the assistant's reply", () => {
		expect(collect(STREAM)).toBe("I will check the code.");
	});

	it("does not include the message we sent", () => {
		// The whole bug: our own prompt arrived glued to the front of every
		// reply, so the manager prompt's worked examples parsed as real blocks
		// and dispatched workers.
		expect(collect(STREAM)).not.toContain("TO: deepseek");
		expect(collect(STREAM)).not.toContain("Your message here.");
	});

	it("ignores bookkeeping frames that carry unrelated strings", () => {
		expect(collect(STREAM)).not.toContain("k2d6-chat");
	});

	it("keeps reading after a frame it cannot parse", () => {
		// The real failure: the length prefixes between frames are raw bytes, so
		// Chrome's text decoding turns them into U+FFFD. A mangled byte inside a
		// frame used to desync the scanner's in-string tracking and every later
		// frame was swallowed into one unreadable object -- a 500-frame reply came
		// back as 35 fragments, cut off mid-sentence.
		const withCorruption = [
			frame({ heartbeat: {} }),
			// A frame whose quoting is broken, exactly as a mangled byte leaves it.
			'\u0000\u0000\u0000\u0000{"op":"set", "mask":"chat.lastRequest", "chat":{"prompt":"unclosed \uFFFD}',
			frame({
				op: "set",
				mask: "block.text",
				eventOffset: 5,
				block: { id: "1", text: { content: "<manager>\nTO: deepseek\n" } },
			}),
			frame({
				op: "append",
				mask: "block.text.content",
				eventOffset: 6,
				block: { id: "1", text: { content: "Check the logs.\n" } },
			}),
			frame({
				op: "append",
				mask: "block.text.content",
				eventOffset: 7,
				block: { id: "1", text: { content: "</manager>" } },
			}),
		].join("");

		expect(collect(withCorruption)).toBe(
			"<manager>\nTO: deepseek\nCheck the logs.\n</manager>",
		);
	});

	it("replaces on set and adds on append", () => {
		// Treating every frame as an append doubles a block Kimi re-sends whole;
		// treating every frame as a replacement leaves only the last token.
		const stream = [
			frame({
				op: "set",
				mask: "block.text",
				eventOffset: 4,
				block: { id: "1", text: { content: "draft" } },
			}),
			frame({
				op: "set",
				mask: "block.text",
				eventOffset: 5,
				block: { id: "1", text: { content: "final" } },
			}),
			frame({
				op: "append",
				mask: "block.text.content",
				eventOffset: 6,
				block: { id: "1", text: { content: " answer" } },
			}),
		].join("");

		expect(collect(stream)).toBe("final answer");
	});

	it("keeps two blocks in the order they arrived", () => {
		const stream = [
			frame({
				op: "set",
				mask: "block.text",
				eventOffset: 4,
				block: { id: "1", text: { content: "first. " } },
			}),
			frame({
				op: "set",
				mask: "block.text",
				eventOffset: 5,
				block: { id: "2", text: { content: "second." } },
			}),
		].join("");

		expect(collect(stream)).toBe("first. second.");
	});

	it("still reads a plain SSE body", () => {
		// The other Kimi endpoint shape, which this parser also has to handle.
		const sse = [
			'data: {"choices":[{"delta":{"content":"hello "}}]}',
			'data: {"choices":[{"delta":{"content":"world"}}]}',
			"data: [DONE]",
		].join("\n");
		expect(collect(sse)).toBe("hello world");
	});
});
