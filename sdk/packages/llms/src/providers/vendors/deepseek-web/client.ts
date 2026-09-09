import {
	COMPLETION_URL,
	DEEPSEEK_API_BASE,
	FAKE_HEADERS,
	type PowChallenge,
	resolveModelOptions,
} from "./config";
import { generateFakeCookie, solveDeepSeekPow } from "./crypto";
import { consumeDeepSeekSse } from "./sse";

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

export async function runCompletion(input: {
	userToken: string;
	modelId: string;
	prompt: string;
	fetchImpl: typeof fetch;
	signal?: AbortSignal;
	onText?: (text: string) => void;
	onReasoning?: (text: string) => void;
}): Promise<{
	text: string;
	reasoning: string;
	accumulatedTokenUsage?: number;
}> {
	const { modelType, thinkingEnabled } = resolveModelOptions(input.modelId);
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

		return await consumeDeepSeekSse(
			resp.body,
			input.onText,
			input.onReasoning,
			thinkingEnabled,
		);
	} finally {
		await deleteSession(accessToken, sessionId, input.fetchImpl).catch(
			() => {},
		);
	}
}
