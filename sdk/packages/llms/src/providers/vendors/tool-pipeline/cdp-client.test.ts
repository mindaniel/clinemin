import { afterEach, describe, expect, it, vi } from "vitest";
import { CDP_CALL_TIMEOUT_MS, CdpClient } from "./cdp-client";

/**
 * A stand-in for the browser socket.
 *
 * Six vendors are about to share this class, so the parts worth pinning are the
 * ones a vendor would silently lose if the extraction went wrong: request/reply
 * correlation by id, event fan-out, and the per-call timeout that only
 * chatgpt-web had before.
 */
class FakeSocket {
	static last: FakeSocket | undefined;
	readyState = 1;
	sent: any[] = [];
	private handlers = new Map<string, ((event: any) => void)[]>();

	constructor(public url: string) {
		FakeSocket.last = this;
	}

	addEventListener(type: string, handler: (event: any) => void): void {
		const list = this.handlers.get(type) ?? [];
		list.push(handler);
		this.handlers.set(type, list);
	}

	send(payload: string): void {
		this.sent.push(JSON.parse(payload));
	}

	close(): void {
		this.readyState = 3;
	}

	/** Push a frame from "Chrome" to the client. */
	deliver(message: unknown): void {
		for (const handler of this.handlers.get("message") ?? []) {
			handler({ data: JSON.stringify(message) });
		}
	}

	fire(type: string): void {
		for (const handler of this.handlers.get(type) ?? []) {
			handler({});
		}
	}
}

const originalWebSocket = globalThis.WebSocket;

function connect(): { client: CdpClient; socket: FakeSocket } {
	(globalThis as any).WebSocket = FakeSocket;
	(FakeSocket as any).OPEN = 1;
	const client = new CdpClient("ws://localhost/devtools", "kimi-web");
	const socket = FakeSocket.last;
	if (!socket) {
		throw new Error("socket was never constructed");
	}
	return { client, socket };
}

afterEach(() => {
	(globalThis as any).WebSocket = originalWebSocket;
	vi.useRealTimers();
});

describe("CdpClient", () => {
	it("resolves a call with the result carrying its id", async () => {
		const { client, socket } = connect();
		const pending = client.send("Runtime.evaluate", { expression: "1" });
		expect(socket.sent[0]).toMatchObject({
			id: 1,
			method: "Runtime.evaluate",
			params: { expression: "1" },
		});
		socket.deliver({ id: 1, result: { value: 42 } });
		await expect(pending).resolves.toEqual({ value: 42 });
	});

	it("rejects with the message Chrome sent back", async () => {
		const { client, socket } = connect();
		const pending = client.send("Page.navigate");
		socket.deliver({ id: 1, error: { message: "no such target" } });
		await expect(pending).rejects.toThrow("no such target");
	});

	it("keeps two calls apart", async () => {
		const { client, socket } = connect();
		const first = client.send("A");
		const second = client.send("B");
		// Answered out of order, which is normal for CDP.
		socket.deliver({ id: 2, result: "second" });
		socket.deliver({ id: 1, result: "first" });
		await expect(first).resolves.toBe("first");
		await expect(second).resolves.toBe("second");
	});

	it("passes a sessionId through only when there is one", async () => {
		const { client, socket } = connect();
		client.send("A", {}, "session-1");
		client.send("B");
		expect(socket.sent[0].sessionId).toBe("session-1");
		expect("sessionId" in socket.sent[1]).toBe(false);
	});

	it("delivers events to every listener and stops after off()", () => {
		const { client, socket } = connect();
		const first = vi.fn();
		const second = vi.fn();
		client.on("Network.responseReceived", first);
		client.on("Network.responseReceived", second);
		socket.deliver({
			method: "Network.responseReceived",
			params: { requestId: "r1" },
			sessionId: "s1",
		});
		expect(first).toHaveBeenCalledWith({ requestId: "r1" }, "s1");
		expect(second).toHaveBeenCalledTimes(1);

		client.off("Network.responseReceived", first);
		socket.deliver({ method: "Network.responseReceived", params: {} });
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(2);
	});

	it("does not let one throwing listener stop the others", () => {
		const { client, socket } = connect();
		const good = vi.fn();
		client.on("X", () => {
			throw new Error("boom");
		});
		client.on("X", good);
		socket.deliver({ method: "X", params: {} });
		expect(good).toHaveBeenCalledTimes(1);
	});

	it("survives a frame that is not JSON", () => {
		const { client, socket } = connect();
		const seen = vi.fn();
		client.on("X", seen);
		for (const handler of (socket as any).handlers.get("message") ?? []) {
			handler({ data: "not json" });
		}
		expect(seen).not.toHaveBeenCalled();
	});

	it("times out a call that is never answered", async () => {
		vi.useFakeTimers();
		const { client } = connect();
		const pending = client.send("Runtime.evaluate", {}, undefined, 50);
		const assertion = expect(pending).rejects.toThrow(
			"CDP timeout: Runtime.evaluate",
		);
		await vi.advanceTimersByTimeAsync(60);
		await assertion;
	});

	it("defaults to the timeout the other five vendors hardcoded", async () => {
		// The extraction took chatgpt-web's parameterised version. Its default has
		// to stay 30000 or the other five silently change behaviour.
		expect(CDP_CALL_TIMEOUT_MS).toBe(30000);
		vi.useFakeTimers();
		const { client } = connect();
		const pending = client.send("Runtime.evaluate");
		const assertion = expect(pending).rejects.toThrow("CDP timeout");
		await vi.advanceTimersByTimeAsync(CDP_CALL_TIMEOUT_MS + 10);
		await assertion;
	});

	it("reports whether the socket is open", () => {
		const { client, socket } = connect();
		expect(client.isOpen()).toBe(true);
		socket.close();
		expect(client.isOpen()).toBe(false);
	});

	it("waitOpen resolves on open and rejects on error", async () => {
		const { client, socket } = connect();
		const opened = client.waitOpen();
		socket.fire("open");
		await expect(opened).resolves.toBeUndefined();

		const second = connect();
		const failing = second.client.waitOpen();
		second.socket.fire("error");
		await expect(failing).rejects.toThrow("CDP websocket error");
	});
});
