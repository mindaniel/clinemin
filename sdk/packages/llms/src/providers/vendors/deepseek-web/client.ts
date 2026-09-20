import {
	COMPLETION_URL,
	computeSendDelay,
	DEEPSEEK_API_BASE,
	DeepSeekRateLimitError,
	FAKE_HEADERS,
	type PowChallenge,
	resolveDeepSeekWebPacing,
	resolveModelOptions,
	sleep,
	waitWithAbort,
} from "./config";
import { generateFakeCookie, solveDeepSeekPow } from "./crypto";
import {
	consumeDeepSeekSse,
	describeEmptyDeepSeekStream,
	isRateLimitDiagnostic,
} from "./sse";

// ── Token exchange & session management ────────────────────────────────────

export function extractUserToken(apiKey: string | undefined): string {
	const raw = (apiKey ?? "").trim();
	if (!raw) return "";
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed?.value === "string") return parsed.value;
	} catch {
		// not JSON — use as-is
	}
	return raw;
}

async function acquireAccessToken(
	userToken: string,
	fetchImpl: typeof fetch,
	signal?: AbortSignal,
): Promise<string> {
	const resp = await fetchImpl(`${DEEPSEEK_API_BASE}/v0/users/current`, {
		headers: {
			Authorization: `Bearer ${userToken}`,
			...FAKE_HEADERS,
		},
		signal,
	});
	if (resp.status === 401 || resp.status === 403) {
		throw new Error(
			"DeepSeek userToken is invalid or expired — get a fresh one from localStorage (DevTools → Application → Local Storage → chat.deepseek.com → userToken)",
		);
	}
	if (!resp.ok) {
		throw new Error(`DeepSeek users/current HTTP ${resp.status}`);
	}
	const json = (await resp.json()) as {
		code?: number;
		msg?: string;
		data?: { biz_data?: { token?: string } };
		biz_data?: { token?: string };
	};
	if (json.code && json.code !== 0) {
		throw new Error(
			`DeepSeek rejected userToken: ${json.msg ?? `code ${json.code}`}`,
		);
	}
	const bizData = json?.data?.biz_data ?? json?.biz_data;
	if (!bizData?.token) {
		throw new Error("DeepSeek did not return an access token");
	}
	return bizData.token;
}

async function createSession(
	accessToken: string,
	fetchImpl: typeof fetch,
	signal?: AbortSignal,
): Promise<string> {
	const resp = await fetchImpl(`${DEEPSEEK_API_BASE}/v0/chat_session/create`, {
		method: "POST",
		headers: {
			...FAKE_HEADERS,
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
			Cookie: generateFakeCookie(),
		},
		body: JSON.stringify({}),
		signal,
	});
	if (!resp.ok) {
		throw new Error(`DeepSeek chat_session/create HTTP ${resp.status}`);
	}
	const json = (await resp.json()) as {
		data?: { biz_data?: { chat_session?: { id?: string } } };
		biz_data?: { chat_session?: { id?: string } };
	};
	const id =
		json?.data?.biz_data?.chat_session?.id ?? json?.biz_data?.chat_session?.id;
	if (!id) {
		throw new Error("DeepSeek did not return a chat session id");
	}
	return id;
}

async function deleteSession(
	accessToken: string,
	sessionId: string,
	fetchImpl: typeof fetch,
): Promise<void> {
	try {
		await fetchImpl(`${DEEPSEEK_API_BASE}/v0/chat_session/delete`, {
			method: "POST",
			headers: {
				...FAKE_HEADERS,
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify({ chat_session_id: sessionId }),
		});
	} catch {
		// best-effort cleanup
	}
}

async function getPowChallenge(
	accessToken: string,
	fetchImpl: typeof fetch,
	signal?: AbortSignal,
): Promise<PowChallenge> {
	const resp = await fetchImpl(
		`${DEEPSEEK_API_BASE}/v0/chat/create_pow_challenge`,
		{
			method: "POST",
			headers: {
				...FAKE_HEADERS,
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify({ target_path: "/api/v0/chat/completion" }),
			signal,
		},
	);
	if (!resp.ok) {
		throw new Error(`DeepSeek create_pow_challenge HTTP ${resp.status}`);
	}
	const json = (await resp.json()) as {
		data?: { biz_data?: { challenge?: PowChallenge } };
		biz_data?: { challenge?: PowChallenge };
	};
	const challenge =
		json?.data?.biz_data?.challenge ?? json?.biz_data?.challenge;
	if (!challenge?.challenge) {
		throw new Error("DeepSeek did not return a PoW challenge");
	}
	return challenge;
}

/**
 * One paced send. A throttle raises `DeepSeekRateLimitError`, which
 * `runCompletion` catches and retries after a wait — see below.
 */
async function attemptCompletion(input: {
	userToken: string;
	modelId: string;
	prompt: string;
	fetchImpl: typeof fetch;
	signal?: AbortSignal;
	onText?: (text: string) => void;
	onReasoning?: (text: string) => void;
	/**
	 * `true` when this turn carries tools — the fastest back-to-back pattern in
	 * an agent run, and the one DeepSeek throttles. Adds the extra pacing delay.
	 */
	isToolTurn?: boolean;
	/** Injectable for tests; defaults to the real timer. */
	sleepImpl?: (ms: number) => Promise<void>;
}): Promise<{
	text: string;
	reasoning: string;
	accumulatedTokenUsage?: number;
}> {
	const { modelType, thinkingEnabled } = resolveModelOptions(input.modelId);

	// Before anything reaches the network, not just before the completion POST:
	// the token exchange, session create and PoW fetch are three more requests
	// to the same origin, so pacing after them still machine-guns chat.deepseek.
	const delay = computeSendDelay(resolveDeepSeekWebPacing(), {
		isToolTurn: input.isToolTurn === true,
	});
	await (input.sleepImpl ?? sleep)(delay);
	if (input.signal?.aborted) {
		throw new DOMException("Aborted", "AbortError");
	}

	const accessToken = await acquireAccessToken(
		input.userToken,
		input.fetchImpl,
		input.signal,
	);
	const sessionId = await createSession(
		accessToken,
		input.fetchImpl,
		input.signal,
	);
	const powChallenge = await getPowChallenge(
		accessToken,
		input.fetchImpl,
		input.signal,
	);
	const powAnswer = solveDeepSeekPow(powChallenge);

	try {
		const resp = await input.fetchImpl(COMPLETION_URL, {
			method: "POST",
			headers: {
				...FAKE_HEADERS,
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
				"X-Ds-Pow-Response": powAnswer,
				"X-Client-Timezone-Offset": String(
					new Date().getTimezoneOffset() * -60,
				),
				Cookie: generateFakeCookie(),
			},
			body: JSON.stringify({
				chat_session_id: sessionId,
				parent_message_id: null,
				model_type: modelType,
				prompt: input.prompt,
				ref_file_ids: [],
				thinking_enabled: thinkingEnabled,
				search_enabled: false,
				preempt: false,
			}),
			signal: input.signal,
		});

		if (!resp.ok || !resp.body) {
			const status = resp.status;
			const message =
				status === 401 || status === 403
					? "DeepSeek token expired — get a fresh userToken from localStorage."
					: status === 429
						? "DeepSeek rate limited. Wait and retry."
						: `DeepSeek API error (${status})`;
			throw new Error(message);
		}

		const result = await consumeDeepSeekSse(
			resp.body,
			input.onText,
			input.onReasoning,
			thinkingEnabled,
		);
		// A stream that carried a server-side error but no fragments reaches the
		// runtime as a message with zero content parts, which it reports as the
		// opaque "Model returned empty response". Say what the stream actually
		// contained instead.
		if (!result.text.trim() && !result.reasoning.trim()) {
			// A throttle is the one empty-stream cause with a specific remedy, so
			// say what to turn up rather than printing the raw hint JSON.
			if (isRateLimitDiagnostic(result.diagnostics)) {
				throw new DeepSeekRateLimitError(
					'DeepSeek throttled the request: "Messages too frequent. Try again later."',
				);
			}
			throw new Error(describeEmptyDeepSeekStream(result.diagnostics));
		}
		return result;
	} finally {
		await deleteSession(accessToken, sessionId, input.fetchImpl).catch(
			() => {},
		);
	}
}

/**
 * Send, and if DeepSeek throttles ("Messages too frequent"), wait and send the
 * identical prompt again instead of failing the task. The throttle window is a
 * server-side cooldown, so waiting it out is the whole remedy — there is
 * nothing about the request to change. Each retry is itself paced, and the
 * wait is abort-aware so Escape still ends the turn immediately.
 *
 * Defaults: 3 retries, 60s apart. `DEEPSEEK_WEB_RATE_LIMIT_MAX_RETRIES=0`
 * restores the old fail-fast behavior.
 */
export async function runCompletion(input: {
	userToken: string;
	modelId: string;
	prompt: string;
	fetchImpl: typeof fetch;
	signal?: AbortSignal;
	onText?: (text: string) => void;
	onReasoning?: (text: string) => void;
	isToolTurn?: boolean;
	sleepImpl?: (ms: number) => Promise<void>;
	/** Called before each throttle wait, so the UI can say why it is idle. */
	onRateLimitRetry?: (info: {
		attempt: number;
		maxRetries: number;
		waitMs: number;
	}) => void;
}): Promise<{
	text: string;
	reasoning: string;
	accumulatedTokenUsage?: number;
}> {
	const { rateLimitRetryDelayMs, rateLimitMaxRetries } =
		resolveDeepSeekWebPacing();

	for (let attempt = 0; ; attempt++) {
		try {
			return await attemptCompletion(input);
		} catch (error) {
			if (
				!(error instanceof DeepSeekRateLimitError) ||
				attempt >= rateLimitMaxRetries
			) {
				// Out of retries: restate the error with what to turn up, since
				// waiting alone was not enough for this account's send rate.
				if (error instanceof DeepSeekRateLimitError) {
					throw new DeepSeekRateLimitError(
						`${error.message} Still throttled after ${attempt} retr${
							attempt === 1 ? "y" : "ies"
						} ${Math.round(rateLimitRetryDelayMs / 1000)}s apart. Raise ` +
							"DEEPSEEK_WEB_MIN_SEND_DELAY_MS / DEEPSEEK_WEB_MAX_SEND_DELAY_MS " +
							"(or minSendDelayMs / maxSendDelayMs in " +
							"~/.cline/deepseek-web/config.json) to slow sending further.",
					);
				}
				throw error;
			}
			input.onRateLimitRetry?.({
				attempt: attempt + 1,
				maxRetries: rateLimitMaxRetries,
				waitMs: rateLimitRetryDelayMs,
			});
			await waitWithAbort(
				rateLimitRetryDelayMs,
				input.signal,
				input.sleepImpl ?? sleep,
			);
		}
	}
}
