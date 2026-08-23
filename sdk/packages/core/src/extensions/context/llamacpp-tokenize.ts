/**
 * Exact token counting for the fork's llama.cpp provider.
 *
 * The CLI auto-manages a local `llama-server` (see
 * `@cline/llms/src/providers/vendors/llamacpp-runtime.ts`). llama.cpp's raw
 * server exposes a `POST /tokenize` endpoint that tokenizes text with the
 * *actually loaded model's* tokenizer — so the returned token count is exact
 * for the model in use, unlike the `chars/N` heuristic.
 *
 * We only call it for loopback base URLs (data-shape detection, no
 * provider-id string matching): a cloud OpenAI-compatible API would 404 on
 * `/tokenize`, so non-local servers fall straight through to the heuristic.
 * Any failure (timeout, non-OK, malformed body) also falls back — the exact
 * counter is a precision improvement, never a correctness dependency.
 */

// `URL.hostname` keeps the brackets for IPv6 (`[::1]`), so accept both forms.
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLocalBaseUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl) {
		return false;
	}
	try {
		return LOCAL_HOSTNAMES.has(new URL(baseUrl).hostname);
	} catch {
		return false;
	}
}

/**
 * llama.cpp serves its raw endpoints (`/tokenize`) on the server root, not
 * under the OpenAI-compatible `/v1` prefix that provider base URLs usually
 * carry. Strip `/v1` and trailing slashes to reach it.
 */
export function llamaCppServerBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/v1\/?$/i, "").replace(/\/+$/, "");
}

export interface CountTokensViaLlamaCppTokenizeInput {
	/** The exact text to tokenize (use `serializeRequestInputForEstimate`). */
	serializedPayload: string;
	/** Provider base URL; must be loopback or `undefined` is returned. */
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

export async function countTokensViaLlamaCppTokenize(
	input: CountTokensViaLlamaCppTokenizeInput,
): Promise<number | undefined> {
	const { baseUrl, serializedPayload, timeoutMs = 3_000 } = input;
	if (!baseUrl || !isLocalBaseUrl(baseUrl)) {
		return undefined;
	}
	const fetchImpl = input.fetchImpl ?? globalThis.fetch;
	try {
		const response = await fetchImpl(
			`${llamaCppServerBaseUrl(baseUrl)}/tokenize`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: serializedPayload }),
				signal: AbortSignal.timeout(timeoutMs),
			},
		);
		if (!response.ok) {
			return undefined;
		}
		const body = (await response.json()) as { tokens?: unknown };
		return Array.isArray(body.tokens) ? body.tokens.length : undefined;
	} catch {
		return undefined;
	}
}
