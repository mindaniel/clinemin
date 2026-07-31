import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type {
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
} from "@cline/shared";
import { wrapLanguageModel } from "ai";
import { ensureFetch, resolveApiKey } from "../http";
import { splitToolImagesMiddleware } from "../middleware/split-tool-images";
import { ensureLlamaCppRunning } from "./llamacpp-runtime";
import type { ProviderFactoryResult } from "./types";

const LLAMACPP_DEFAULT_BASE_URL = "http://localhost:8080/v1";

type FetchInput = Parameters<typeof fetch>[0];
type FetchWithOptionalPreconnect = typeof fetch & {
	preconnect?: (...args: unknown[]) => unknown;
};

function readAzureApiVersion(
	config: GatewayResolvedProviderConfig,
): string | undefined {
	const apiVersion = config.options?.apiVersion;
	if (typeof apiVersion !== "string") {
		return undefined;
	}
	const trimmed = apiVersion.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function shouldAddAzureApiVersion(url: URL): boolean {
	return (
		url.pathname.startsWith("/openai/deployments/") &&
		!url.searchParams.has("api-version")
	);
}

function withAzureApiVersion(
	input: FetchInput,
	apiVersion: string,
): FetchInput {
	let url: URL;
	try {
		url = new URL(input instanceof Request ? input.url : input.toString());
	} catch {
		return input;
	}
	if (!shouldAddAzureApiVersion(url)) {
		return input;
	}
	url.searchParams.set("api-version", apiVersion);
	if (input instanceof Request) {
		return new Request(url.toString(), input);
	}
	return (typeof input === "string" ? url.toString() : url) as FetchInput;
}

function createAzureApiVersionFetch(
	config: GatewayResolvedProviderConfig,
): typeof fetch | undefined {
	const apiVersion = readAzureApiVersion(config);
	if (!apiVersion) {
		return config.fetch;
	}
	const baseFetch = config.fetch ?? globalThis.fetch;
	if (!baseFetch) {
		return config.fetch;
	}
	const azureFetch = ((input, init) =>
		baseFetch(withAzureApiVersion(input, apiVersion), init)) as typeof fetch;
	const baseFetchWithPreconnect = baseFetch as FetchWithOptionalPreconnect;
	(azureFetch as FetchWithOptionalPreconnect).preconnect =
		typeof baseFetchWithPreconnect.preconnect === "function"
			? baseFetchWithPreconnect.preconnect.bind(baseFetch)
			: () => undefined;
	return azureFetch;
}

type ResponseErrorHandler = (response: Response) => Promise<void> | void;

function readResponseErrorHandler(
	config: GatewayResolvedProviderConfig,
): ResponseErrorHandler | undefined {
	const handler = config.options?.onResponseError;
	return typeof handler === "function"
		? (handler as ResponseErrorHandler)
		: undefined;
}

function createResponseErrorFetch(input: {
	fetch: typeof fetch;
	onResponseError: ResponseErrorHandler;
}): typeof fetch {
	const responseErrorFetch = (async (requestInput, init) => {
		const response = await input.fetch(requestInput, init);

		await input.onResponseError(response);

		return response;
	}) as typeof fetch;

	const baseFetchWithPreconnect = input.fetch as FetchWithOptionalPreconnect;
	(responseErrorFetch as FetchWithOptionalPreconnect).preconnect =
		typeof baseFetchWithPreconnect.preconnect === "function"
			? baseFetchWithPreconnect.preconnect.bind(input.fetch)
			: () => undefined;
	return responseErrorFetch;
}

export async function createOpenAICompatibleProviderModule(
	config: GatewayResolvedProviderConfig,
	context: GatewayProviderContext,
): Promise<ProviderFactoryResult> {
	// llama.cpp is the one openai-compatible vendor Cline can fully manage
	// itself: no daemon to start by hand like Ollama/LM Studio. Ensure the
	// local llama-server is up (downloading the binary/model on first run)
	// before handing off to the generic openai-compatible client below.
	// "llamacpp-<name>" ids are user-created profiles (multiple servers running
	// concurrently on different ports, see the setup wizard) — same handling.
	if (context.provider.id === "llamacpp" || context.provider.id.startsWith("llamacpp-")) {
		const baseURL = config.baseUrl?.trim() || LLAMACPP_DEFAULT_BASE_URL;
		// context.model.id is the provider's saved "model" setting — for llamacpp
		// that's the .gguf path picked in the TUI setup wizard, not a catalog id.
		// contextWindow likewise doubles as llama-server's `-c` flag (see
		// ensureLlamaCppRunning's overrides).
		const result = await ensureLlamaCppRunning(baseURL, (message) => context.logger?.log(message), {
			modelPath: context.model.id,
			contextWindow: context.model.contextWindow,
		});
		if (!result.ok) {
			throw new Error(`llama.cpp: ${result.error ?? "failed to start local server"}`);
		}
	}

	// Don't preflight-check for a missing API key. If credentials are
	// missing or wrong, the provider's own response (e.g. 401) is the
	// authoritative error and is surfaced to the user as-is. This keeps
	// `llms` unopinionated about which providers do or don't need a key.
	const apiKey = await resolveApiKey(config);
	const fetch = createAzureApiVersionFetch(config);
	const onResponseError = readResponseErrorHandler(config);
	const providerFetch = onResponseError
		? createResponseErrorFetch({
				fetch: ensureFetch(fetch),
				onResponseError,
			})
		: fetch;
	const provider = createOpenAICompatible({
		name: context.provider.id,
		apiKey,
		...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
		...(config.headers ? { headers: config.headers } : {}),
		...(providerFetch ? { fetch: providerFetch } : {}),
		includeUsage: true,
	} as never);
	return {
		// Wrap each constructed model with `splitToolImagesMiddleware` so
		// `role:"tool"` messages whose `output.type === 'content'` carries
		// image-data parts get split into a placeholder text + a synthetic
		// `role:"user"` message carrying the images. The OpenAI Chat
		// Completions wire format does NOT support multimodal tool messages
		// (the `@ai-sdk/openai-compatible` chat-messages converter
		// `JSON.stringify`s the parts array, losing image bytes). The
		// middleware operates on the typed `LanguageModelV3Prompt` BEFORE
		// the converter runs, so the converter sees only text-only tool
		// messages with adjacent multimodal user messages — the wire
		// pattern that classic Cline used in production for years (see
		// `convertToOpenAiMessages` in `src/core/api/transform/openai-format.ts`
		// on origin/main).
		model: (modelId) =>
			wrapLanguageModel({
				model: provider(modelId) as LanguageModelV3,
				middleware: splitToolImagesMiddleware,
			}),
	};
}
