import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The three slots a slash command sets and a provider reads.
 *
 * All three used to live only on `globalThis`, which is per process — and the
 * provider that has to act on them normally runs in the hub daemon, not the TUI
 * process that ran the command. So each of these asserts the value survives a
 * fresh module graph with an empty `globalThis`, which is what the hub sees.
 *
 * `CLINE_DIR` is set before the modules are imported because each captures its
 * file path at import time.
 */
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cline-process-file-"));
process.env.CLINE_DIR = TEST_DIR;

afterAll(() => {
	fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

/** Import a module with no state carried over from the writer's process. */
async function inAFreshProcess<T>(loader: () => Promise<T>): Promise<T> {
	const host = globalThis as unknown as Record<string, unknown>;
	const saved = host.__clineToolPipeline__;
	host.__clineToolPipeline__ = undefined;
	try {
		return await loader();
	} finally {
		host.__clineToolPipeline__ = saved;
	}
}

beforeEach(() => {
	for (const name of [
		"chat-pins.json",
		"pending-paste.json",
		"continuation-note.json",
	]) {
		fs.rmSync(path.join(TEST_DIR, name), { force: true });
	}
});

describe("cross-process state", () => {
	it("carries a /findchat pin to a reader with no in-memory state", async () => {
		const { bindChatKey, getBoundChatKey, clearChatKeyBinding } = await import(
			"./chat-target"
		);
		bindChatKey("chatgpt-web", "b92d63df78076b1340c03089");

		const pinned = await inAFreshProcess(async () =>
			getBoundChatKey("chatgpt-web"),
		);
		expect(pinned).toBe("b92d63df78076b1340c03089");

		// Clearing has to cross the boundary too, or a hub-side session keeps
		// writing into a chat the CLI has already let go of.
		clearChatKeyBinding("chatgpt-web");
		expect(
			await inAFreshProcess(async () => getBoundChatKey("chatgpt-web")),
		).toBeUndefined();
	});

	it("carries a /paste reply to the provider that consumes it", async () => {
		const { setPendingInjectedReply, consumePendingInjectedReply } =
			await import("./injected-reply");
		setPendingInjectedReply("the copied reply", "chatgpt-web");

		// Tagged for another provider: left in place, not swallowed.
		expect(
			await inAFreshProcess(async () =>
				consumePendingInjectedReply("claude-web"),
			),
		).toBeUndefined();

		expect(
			await inAFreshProcess(async () =>
				consumePendingInjectedReply("chatgpt-web"),
			),
		).toBe("the copied reply");

		// One shot: the file goes with the slot.
		expect(
			await inAFreshProcess(async () =>
				consumePendingInjectedReply("chatgpt-web"),
			),
		).toBeUndefined();
	});

	it("carries the project's continuation note to the runtime", async () => {
		const {
			setContinuationNote,
			getContinuationNote,
			resetContinuationNote,
			DEFAULT_CONTINUATION_NOTE,
		} = await import("./continuation-note");
		setContinuationNote("Run the tests before finishing.");

		expect(await inAFreshProcess(async () => getContinuationNote())).toBe(
			"Run the tests before finishing.",
		);

		resetContinuationNote();
		expect(await inAFreshProcess(async () => getContinuationNote())).toBe(
			DEFAULT_CONTINUATION_NOTE,
		);
	});
});
