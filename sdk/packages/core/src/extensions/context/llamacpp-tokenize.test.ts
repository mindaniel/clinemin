import { describe, expect, it, vi } from "vitest";
import {
	countTokensViaLlamaCppTokenize,
	isLocalBaseUrl,
	llamaCppServerBaseUrl,
} from "./llamacpp-tokenize";

const tokenizeResponse = (tokens: unknown[]) =>
	new Response(JSON.stringify({ tokens }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});

describe("isLocalBaseUrl", () => {
	it("accepts loopback hosts", () => {
		expect(isLocalBaseUrl("http://127.0.0.1:8080")).toBe(true);
		expect(isLocalBaseUrl("http://localhost:8080")).toBe(true);
		expect(isLocalBaseUrl("http://localhost:8080/v1")).toBe(true);
		expect(isLocalBaseUrl("http://[::1]:8080")).toBe(true);
	});

	it("rejects remote hosts and junk", () => {
		expect(isLocalBaseUrl("https://api.deepseek.com")).toBe(false);
		expect(isLocalBaseUrl("https://localhost:8080")).toBe(true); // https loopback is still local
		expect(isLocalBaseUrl(undefined)).toBe(false);
		expect(isLocalBaseUrl("not a url")).toBe(false);
		expect(isLocalBaseUrl("")).toBe(false);
	});
});

describe("llamaCppServerBaseUrl", () => {
	it("strips the /v1 suffix and trailing slashes", () => {
		expect(llamaCppServerBaseUrl("http://127.0.0.1:8080/v1")).toBe(
			"http://127.0.0.1:8080",
		);
		expect(llamaCppServerBaseUrl("http://127.0.0.1:8080/v1/")).toBe(
			"http://127.0.0.1:8080",
		);
		expect(llamaCppServerBaseUrl("http://127.0.0.1:8080")).toBe(
			"http://127.0.0.1:8080",
		);
	});
});

describe("countTokensViaLlamaCppTokenize", () => {
	it("returns the token count from a local server", async () => {
		const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
			tokenizeResponse([1, 2, 3, 4, 5]),
		);
		const count = await countTokensViaLlamaCppTokenize({
			serializedPayload: "hello world",
			baseUrl: "http://127.0.0.1:8080/v1",
			fetchImpl: fetchMock as unknown as typeof fetch,
		});
		expect(count).toBe(5);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("http://127.0.0.1:8080/tokenize");
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body as string)).toEqual({ content: "hello world" });
	});

	it("returns undefined without calling fetch for remote hosts", async () => {
		const fetchMock = vi.fn();
		const count = await countTokensViaLlamaCppTokenize({
			serializedPayload: "hello",
			baseUrl: "https://api.deepseek.com/v1",
			fetchImpl: fetchMock as unknown as typeof fetch,
		});
		expect(count).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns undefined for non-OK responses", async () => {
		const fetchMock = vi.fn(async () => new Response("nope", { status: 404 }));
		const count = await countTokensViaLlamaCppTokenize({
			serializedPayload: "hello",
			baseUrl: "http://127.0.0.1:8080",
			fetchImpl: fetchMock as unknown as typeof fetch,
		});
		expect(count).toBeUndefined();
	});

	it("returns undefined for malformed bodies", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ content_length: 5 }), { status: 200 }),
		);
		const count = await countTokensViaLlamaCppTokenize({
			serializedPayload: "hello",
			baseUrl: "http://127.0.0.1:8080",
			fetchImpl: fetchMock as unknown as typeof fetch,
		});
		expect(count).toBeUndefined();
	});

	it("returns undefined when fetch rejects", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("connection refused");
		});
		const count = await countTokensViaLlamaCppTokenize({
			serializedPayload: "hello",
			baseUrl: "http://127.0.0.1:8080",
			fetchImpl: fetchMock as unknown as typeof fetch,
		});
		expect(count).toBeUndefined();
	});

	it("falls back when no baseUrl is provided", async () => {
		const fetchMock = vi.fn();
		const count = await countTokensViaLlamaCppTokenize({
			serializedPayload: "hello",
			fetchImpl: fetchMock as unknown as typeof fetch,
		});
		expect(count).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
