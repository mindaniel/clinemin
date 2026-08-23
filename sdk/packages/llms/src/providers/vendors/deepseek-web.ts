import type {
	LanguageModelV2,
	LanguageModelV2CallOptions,
	LanguageModelV2FinishReason,
	LanguageModelV2FunctionTool,
	LanguageModelV2Message,
	LanguageModelV2Prompt,
	LanguageModelV2StreamPart,
} from "@ai-sdk/provider";
import type {
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
} from "@cline/shared";
import { estimateTokens } from "@cline/shared";
import { ensureFetch } from "../http";
import type { ProviderFactoryResult } from "./types";

/**
 * DeepSeek Web ("deepseek-web") provider.
 *
 * chat.deepseek.com does not expose a public API. This provider drives the
 * same endpoints the web client uses, authenticating with the `userToken`
 * value a logged-in user can copy from DevTools → Application → Local
 * Storage → chat.deepseek.com → userToken.
 *
 * Flow (mirrors the OmniRoute `open-sse/executors/deepseek-web.ts` reference):
 *   1. Exchange `userToken` for a short-lived access token via
 *      `GET /api/v0/users/current`.
 *   2. Create a chat session via `POST /api/v0/chat_session/create`.
 *   3. Solve a proof-of-work challenge (`DeepSeekHashV1`) so the completion
 *      request is accepted.
 *   4. Stream a completion from `POST /api/v0/chat/completion` (SSE), parsing
 *      DeepSeek's `p`/`v`/`o` event envelope.
 *
 * The web endpoint has no native `tools[]` field, so tool definitions are
 * serialized into a strict `<tool>{json}</tool>` prompt contract and the
 * model's reply is parsed back into tool calls (same contract OmniRoute
 * uses).
 */

const DEEPSEEK_WEB_BASE = "https://chat.deepseek.com";
const DEEPSEEK_API_BASE = `${DEEPSEEK_WEB_BASE}/api`;
const COMPLETION_URL = `${DEEPSEEK_API_BASE}/v0/chat/completion`;

// Fingerprint headers the chat.deepseek.com web client (v2.0.0) sends on every
// /api/v0/* request. Sending a stale client version is itself a bot-detection
// signal, so these must match the current build.
const FAKE_HEADERS: Record<string, string> = {
	Accept: "*/*",
	"Accept-Encoding": "gzip, deflate, br, zstd",
	"Accept-Language": "en-US,en;q=0.9",
	Origin: DEEPSEEK_WEB_BASE,
	Referer: `${DEEPSEEK_WEB_BASE}/`,
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
	"X-Client-Bundle-Id": "com.deepseek.chat",
	"X-Client-Locale": "en-US",
	"X-Client-Platform": "web",
	"X-Client-Version": "2.0.0",
};

interface PowChallenge {
	algorithm: string;
	challenge: string;
	salt: string;
	signature: string;
	difficulty: number;
	expire_at: number;
	expire_after: number;
	target_path: string;
}

// ── Keccak-256 / SHA3-256 (transcribed from OmniRoute's verified solver) ───
//
// DeepSeek's `DeepSeekHashV1` is SHA3-256 with the Keccak-f[1600] permutation
// running only rounds 1..23 (round 0 is skipped). The functions below are
// transcribed verbatim from the working reference (open-sse/lib/deepseek-pow-solver.cjs).

/** Copy one 64-bit lane (two Uint32 words) from `src` to `dst`. */
function copyLane(
	src: Uint32Array,
	srcLane: number,
	dst: Uint32Array,
	dstLane: number,
): void {
	dst[2 * dstLane] = src[2 * srcLane];
	dst[2 * dstLane + 1] = src[2 * srcLane + 1];
}

/**
 * Chi step (χ). Reference `y`:
 * ```
 * y = t => { let {A: e, C: r} = t;
 *   for (let t = 0; t < 25; t += 5) {
 *     for (let n = 0; n < 5; n++) copy(e, t+n)(r, n);
 *     for (let n = 0; n < 5; n++) {
 *       let i = (t+n)*2, o = (n+1)%5*2, f = (n+2)%5*2;
 *       e[i]   ^= ~r[o] & r[f];
 *       e[i+1] ^= ~r[o+1] & r[f+1];
 *     }
 *   }
 * };
 * ```
 */
function chi(state: Uint32Array, tmp: Uint32Array): void {
	for (let y = 0; y < 25; y += 5) {
		for (let x = 0; x < 5; x++) copyLane(state, y + x, tmp, x);
		for (let x = 0; x < 5; x++) {
			const i = (y + x) * 2;
			const o = ((x + 1) % 5) * 2;
			const f = ((x + 2) % 5) * 2;
			state[i] ^= ~tmp[o] & tmp[f];
			state[i + 1] ^= ~tmp[o + 1] & tmp[f + 1];
		}
	}
}

/**
 * Round constants, transcribed from reference `d` (24 entries × [lo, hi]
 * Uint32 pairs). The reference iota XORs pair `round` into state[0..1].
 */
const ROUND_CONSTANTS: readonly number[] = [
	0, 1, 0, 32898, 0x80000000, 32906, 0x80000000, 0x80008000, 0, 32907, 0,
	0x80000001, 0x80000000, 0x80008081, 0x80000000, 32777, 0, 138, 0, 136, 0,
	0x80008009, 0, 0x8000000a, 0, 0x8000808b, 0x80000000, 139, 0x80000000, 32905,
	0x80000000, 32771, 0x80000000, 32770, 0x80000000, 128, 0, 32778, 0x80000000,
	0x8000000a, 0x80000000, 0x80008081, 0x80000000, 32896, 0, 0x80000001,
	0x80000000, 0x80008008,
];

/**
 * Rho+Pi step. Reference `E` (with `v` = pi table, `w` = rho offsets):
 * ```
 * E = t => { let {A: e, C: r, W: n} = t, i = 0;
 *   copy(e, i+1)(n, i);
 *   let o = 0, f = 0, u = 0, s = 32;
 *   for (; i < 24; i++) {
 *     let t = v[i], a = w[i];
 *     copy(e, t)(r, 0);
 *     o = n[0]; f = n[1]; s = 32 - a;
 *     n[u = a<32 ? 0 : 1] = o<<a | f>>>s;
 *     n[(u+1)%2] = f<<a | o>>>s;
 *     copy(n, 0)(e, t);
 *     copy(r, 0)(n, 0);
 *   }
 * };
 * ```
 */
const RHO_PI_TABLE: readonly number[] = [
	10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22,
	9, 6, 1,
];
const RHO_ROT: readonly number[] = [
	1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39,
	61, 20, 44,
];

function rhoPi(state: Uint32Array, c: Uint32Array, w: Uint32Array): void {
	copyLane(state, 1, w, 0);
	for (let i = 0; i < 24; i++) {
		const t = RHO_PI_TABLE[i];
		const a = RHO_ROT[i];
		copyLane(state, t, c, 0);
		const o = w[0];
		const f = w[1];
		const s = 32 - a;
		const u = a < 32 ? 0 : 1;
		w[u] = (o << a) | (f >>> s);
		w[(u + 1) % 2] = (f << a) | (o >>> s);
		copyLane(w, 0, state, t);
		copyLane(c, 0, w, 0);
	}
}

/**
 * Theta step (θ). Reference `B`:
 * ```
 * B = t => { let {A: e, C: r, D: n, W: i} = t;
 *   for (let t = 0; t < 5; t++) {
 *     let n = 2*t, i = (t+5)*2, o = (t+10)*2, f = (t+15)*2, u = (t+20)*2;
 *     r[n] = e[n]^e[i]^e[o]^e[f]^e[u];
 *     r[n+1] = e[n+1]^e[i+1]^e[o+1]^e[f+1]^e[u+1];
 *   }
 *   for (let t = 0; t < 5; t++) {
 *     copy(r, (t+1)%5)(i, 0);
 *     o = i[0]; f = i[1];
 *     i[0] = o<<1 | f>>>31;
 *     i[1] = f<<1 | o>>>31;
 *     n[2*t] = r[(t+4)%5*2] ^ i[0];
 *     n[2*t+1] = r[(t+4)%5*2+1] ^ i[1];
 *     for (let r = 0; r < 25; r += 5) {
 *       e[(r+t)*2] ^= n[2*t];
 *       e[(r+t)*2+1] ^= n[2*t+1];
 *     }
 *   }
 * };
 * ```
 */
function theta(
	state: Uint32Array,
	c: Uint32Array,
	d: Uint32Array,
	w: Uint32Array,
): void {
	for (let x = 0; x < 5; x++) {
		const n = 2 * x;
		const i = (x + 5) * 2;
		const o = (x + 10) * 2;
		const f = (x + 15) * 2;
		const u = (x + 20) * 2;
		c[n] = state[n] ^ state[i] ^ state[o] ^ state[f] ^ state[u];
		c[n + 1] =
			state[n + 1] ^ state[i + 1] ^ state[o + 1] ^ state[f + 1] ^ state[u + 1];
	}
	for (let x = 0; x < 5; x++) {
		copyLane(c, (x + 1) % 5, w, 0);
		const o = w[0];
		const f = w[1];
		w[0] = (o << 1) | (f >>> 31);
		w[1] = (f << 1) | (o >>> 31);
		d[2 * x] = c[((x + 4) % 5) * 2] ^ w[0];
		d[2 * x + 1] = c[((x + 4) % 5) * 2 + 1] ^ w[1];
		for (let y = 0; y < 25; y += 5) {
			state[(y + x) * 2] ^= d[2 * x];
			state[(y + x) * 2 + 1] ^= d[2 * x + 1];
		}
	}
}

/**
 * Iota step (Î¹). Reference `b`:
 * ```
 * b = t => { let {A: e, I: r} = t, n = 2*r; e[0] ^= d[n], e[1] ^= d[n+1]; };
 * ```
 */
function iota(state: Uint32Array, round: number): void {
	const n = 2 * round;
	state[0] ^= ROUND_CONSTANTS[n];
	state[1] ^= ROUND_CONSTANTS[n + 1];
}

/**
 * Absorb step. Reference `I`:
 * ```
 * I = (t, e) => { for (let r = 0; r < t.length; r += 8) {
 *   let n = r/4;
 *   e[n]   ^= t[r+7]<<24 | t[r+6]<<16 | t[r+5]<<8 | t[r+4];
 *   e[n+1] ^= t[r+3]<<24 | t[r+2]<<16 | t[r+1]<<8 | t[r];
 * } return e; };
 * ```
 */
function absorbBlockBytes(block: Uint8Array, state: Uint32Array): void {
	for (let r = 0; r < block.length; r += 8) {
		const n = r / 4;
		state[n] ^=
			(block[r + 7] << 24) |
			(block[r + 6] << 16) |
			(block[r + 5] << 8) |
			block[r + 4];
		state[n + 1] ^=
			(block[r + 3] << 24) |
			(block[r + 2] << 16) |
			(block[r + 1] << 8) |
			block[r];
	}
}

/**
 * Squeeze step. Reference `A`:
 * ```
 * A = (t, e) => { for (let r = 0; r < e.length; r += 8) {
 *   let n = r/4;
 *   e[r]   = t[n+1];
 *   e[r+1] = t[n+1] >>> 8;
 *   e[r+2] = t[n+1] >>> 16;
 *   e[r+3] = t[n+1] >>> 24;
 *   e[r+4] = t[n];
 *   e[r+5] = t[n] >>> 8;
 *   e[r+6] = t[n] >>> 16;
 *   e[r+7] = t[n] >>> 24;
 * } return e; };
 * ```
 */
function squeezeBlockBytes(state: Uint32Array, out: Uint8Array): void {
	for (let r = 0; r < out.length; r += 8) {
		const n = r / 4;
		out[r] = state[n + 1];
		out[r + 1] = state[n + 1] >>> 8;
		out[r + 2] = state[n + 1] >>> 16;
		out[r + 3] = state[n + 1] >>> 24;
		out[r + 4] = state[n];
		out[r + 5] = state[n] >>> 8;
		out[r + 6] = state[n] >>> 16;
		out[r + 7] = state[n] >>> 24;
	}
}

/** Keccak-f[1600] permutation. Reference `keccak` runs rounds 1..23 (23 rounds). */
function permute(state: Uint32Array): void {
	const c = new Uint32Array(10);
	const d = new Uint32Array(10);
	const w = new Uint32Array(2);
	for (let round = 1; round < 24; round++) {
		theta(state, c, d, w);
		rhoPi(state, c, w);
		chi(state, c);
		iota(state, round);
	}
	c.fill(0);
	d.fill(0);
	w.fill(0);
}

const SHA3_OUTPUT_BYTES = 32;

/** Keccak sponge. Reference `U` class. */
class KeccakSponge {
	private readonly rate: number;
	private readonly padding: number;
	private readonly outputLen: number;
	private readonly state = new Uint32Array(50);
	private readonly queue: Uint8Array;
	private queueOffset = 0;

	constructor(capacityBits: number, padding: number, outputLen: number) {
		this.rate = 200 - capacityBits / 4;
		this.padding = padding;
		this.outputLen = outputLen;
		this.queue = new Uint8Array(this.rate);
	}

	absorb(data: Uint8Array): this {
		for (let i = 0; i < data.length; i++) {
			this.queue[this.queueOffset] = data[i];
			this.queueOffset += 1;
			if (this.queueOffset >= this.rate) {
				absorbBlockBytes(this.queue, this.state);
				permute(this.state);
				this.queueOffset = 0;
			}
		}
		return this;
	}

	squeeze(): Uint8Array {
		const out = new Uint8Array(this.outputLen);
		const queue = new Uint8Array(this.queue.length);
		const state = new Uint32Array(this.state.length);
		this.queue.forEach((v, i) => {
			queue[i] = v;
		});
		for (let i = 0; i < this.state.length; i++) state[i] = this.state[i];
		queue.fill(0, this.queueOffset);
		queue[this.queueOffset] |= this.padding;
		queue[this.rate - 1] |= 0x80;
		absorbBlockBytes(queue, state);
		for (let i = 0; i < out.length; i += this.rate) {
			permute(state);
			squeezeBlockBytes(state, out.subarray(i, i + this.rate));
		}
		return out;
	}
}

/** SHA3-256 hex digest (DeepSeekHashV1: 23-round Keccak-f, SHA3 padding). */
export function sha3_256Hex(input: string): string {
	const sponge = new KeccakSponge(256, 0x06, SHA3_OUTPUT_BYTES);
	sponge.absorb(new TextEncoder().encode(input));
	return Buffer.from(sponge.squeeze()).toString("hex");
}

// ── Proof-of-work (DeepSeekHashV1) ─────────────────────────────────────────

/**
 * Solve DeepSeek's `DeepSeekHashV1` challenge. The server publishes a
 * `{salt, expire_at, challenge, difficulty, ...}` challenge and requires a
 * nonce `n` such that `sha3_256(salt_expireAt_n) === challenge`. The answer is
 * a base64 envelope the completion request sends in `X-Ds-Pow-Response`.
 */
export function solveDeepSeekPow(challenge: PowChallenge): string {
	const prefix = `${challenge.salt}_${challenge.expire_at}_`;
	for (let nonce = 0; nonce < challenge.difficulty; nonce++) {
		if (sha3_256Hex(`${prefix}${nonce}`) === challenge.challenge) {
			return Buffer.from(
				JSON.stringify({
					algorithm: challenge.algorithm,
					challenge: challenge.challenge,
					salt: challenge.salt,
					answer: nonce,
					signature: challenge.signature,
					target_path: challenge.target_path,
				}),
			).toString("base64");
		}
	}
	throw new Error("DeepSeek PoW solver failed: no nonce matched the challenge");
}

function generateFakeCookie(): string {
	const ts = Date.now();
	const hex = (n: number): string =>
		Array.from({ length: n }, () =>
			Math.floor(Math.random() * 16).toString(16),
		).join("");
	const uid = (): string =>
		"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
			const r = (Math.random() * 16) | 0;
			return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
		});
	return `intercom-HWWAFSESTIME=${ts}; HWWAFSESID=${hex(18)}; Hm_lvt_${uid()}=${Math.floor(ts / 1000)}; _frid=${uid()}`;
}

// ── Token exchange & session management ────────────────────────────────────

function extractUserToken(apiKey: string | undefined): string {
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

// ── Prompt building (the web endpoint only accepts a flat `prompt` string) ──

const DEFAULT_AUTO_HISTORY_WINDOW = 20;

/** Loose view over any LanguageModelV2 content part for text extraction. */
type PromptPart = {
	type?: string;
	text?: unknown;
	toolName?: unknown;
	toolCallId?: unknown;
	// Legacy (AI SDK v1) tool-result shape.
	result?: unknown;
	// AI SDK v2 tool-result shape: { type, value } | { type: "content", value: ... }.
	output?: unknown;
};

function toPromptParts(message: LanguageModelV2Message): PromptPart[] {
	if (Array.isArray(message.content)) {
		return message.content as unknown as PromptPart[];
	}
	return [{ type: "text", text: String(message.content ?? "") }];
}

/**
 * Convert an AI SDK v2 tool-result `output` into a plain string so the model
 * can see the tool's result. v2 uses `output` (not v1's `result`) with one of
 * several shapes:
 *   - { type: "text",        value: string }
 *   - { type: "json",        value: JSONValue }
 *   - { type: "error-text",  value: string }
 *   - { type: "error-json",  value: JSONValue }
 *   - { type: "content",     value: Array<{ type: "text", text } | { type: "media", ... }> }
 * Without this, the web provider silently swallowed every tool result (the
 * model kept asking "did you actually create it?" because it never saw the
 * command output).
 */
function toolResultOutputText(output: unknown): string {
	if (output == null) return "";
	if (typeof output === "string") return output;

	const out = output as {
		type?: string;
		value?: unknown;
	};

	if (out.type === "text" || out.type === "error-text") {
		return typeof out.value === "string" ? out.value : String(out.value ?? "");
	}

	if (out.type === "json" || out.type === "error-json") {
		return typeof out.value === "string"
			? out.value
			: JSON.stringify(out.value);
	}

	if (out.type === "content") {
		const items = out.value as Array<{
			type?: string;
			text?: string;
			data?: string;
			mediaType?: string;
		}>;
		if (Array.isArray(items)) {
			return items
				.map((item) => {
					if (item.type === "text" && typeof item.text === "string") {
						return item.text;
					}
					if (item.type === "media") {
						const mime =
							typeof item.mediaType === "string" ? ` [${item.mediaType}]` : "";
						const body = typeof item.data === "string" ? item.data : "";
						return `[media${mime}]${body ? ` ${body}` : ""}`;
					}
					return "";
				})
				.filter((t) => t.length > 0)
				.join("\n");
		}
	}

	return JSON.stringify(output);
}

function promptPartText(part: PromptPart): string {
	if (typeof part.text === "string" && part.text.length > 0) return part.text;
	if (part.type === "tool-result") {
		// v2 shape takes precedence; fall back to the legacy `result` field.
		if (part.output !== undefined) return toolResultOutputText(part.output);
		if (part.result !== undefined) {
			return typeof part.result === "string"
				? part.result
				: JSON.stringify(part.result);
		}
	}
	return "";
}

/**
 * Serialize the AI SDK prompt into DeepSeek's flat `prompt` string. For
 * multi-turn conversations a bounded rolling window of recent turns is stitched
 * in so the agent keeps context across turns.
 */
export interface MessagesToPromptOptions {
	/** Number of most-recent turns to fold into the flat prompt (default: global). */
	historyWindow?: number;
	/**
	 * Label prefix for prior user messages. Defaults to "User". v2 uses
	 * "Previous user message" so the model reads it as context, not a fresh
	 * instruction, and doesn't re-answer it.
	 */
	userLabel?: string;
	/** Label prefix for trailing tool results. Defaults to "Tool result". */
	toolResultLabel?: string;
}

export function messagesToPrompt(
	messages: LanguageModelV2Message[],
	historyWindowOrOptions: number | MessagesToPromptOptions = DEFAULT_AUTO_HISTORY_WINDOW,
): string {
	const options: MessagesToPromptOptions =
		typeof historyWindowOrOptions === "number"
			? { historyWindow: historyWindowOrOptions }
			: historyWindowOrOptions;
	const historyWindow = options.historyWindow ?? DEFAULT_AUTO_HISTORY_WINDOW;
	const userLabel = options.userLabel ?? "User";
	const toolResultLabel = options.toolResultLabel ?? "Tool result";
	const systemParts: string[] = [];
	const conversation: Array<{ role: string; text: string }> = [];
	let lastUserContent = "";

	for (const message of messages) {
		const parts = toPromptParts(message);
		const text = parts
			.map((part) =>
				part.type === "text" || part.type === "tool-result"
					? promptPartText(part)
					: "",
			)
			.join("\n")
			.trim();

		if (message.role === "system") {
			if (text) systemParts.push(text);
		} else if (message.role === "user" || message.role === "assistant") {
			if (text) conversation.push({ role: message.role, text });
			if (message.role === "user") lastUserContent = text;
		} else if (message.role === "tool") {
			// Tool results have no native slot in the flat-prompt format; fold
			// them in as plain text so the model keeps seeing the output.
			if (text) {
				const toolResult = parts.find((p) => p.type === "tool-result");
				const toolName =
					typeof toolResult?.toolName === "string"
						? toolResult.toolName
						: "tool";
				conversation.push({ role: "tool", text: `(${toolName}) ${text}` });
			}
		}
	}

	const outputParts: string[] = [];
	if (systemParts.length > 0) outputParts.push(systemParts.join("\n\n"));

	const effectiveWindow =
		conversation.length > 1 ? historyWindow : 0;
	if (effectiveWindow > 0 && conversation.length > 1) {
		const recent = conversation.slice(-effectiveWindow);
		outputParts.push(
			recent
				.map((turn) =>
					turn.role === "assistant"
						? `Assistant: ${turn.text}`
						: turn.role === "tool"
							? `${toolResultLabel}: ${turn.text}`
							: `${userLabel}: ${turn.text}`,
				)
				.join("\n\n"),
		);
	} else if (lastUserContent) {
		outputParts.push(lastUserContent);
	}

	return outputParts.join("\n\n").replace(/!\[.*?\]\(.*?\)/g, "");
}

/**
 * Serialize AI SDK function tools into DeepSeek's strict `<tool>{json}</tool>`
 * prompt contract so the model can request tool calls despite the web endpoint
 * having no native `tools[]` field.
 */
export function serializeDeepSeekToolPrompt(
	tools: LanguageModelV2FunctionTool[],
): string {
	if (!tools.length) return "";
	const lines: string[] = [];
	for (const tool of tools) {
		const desc = tool.description ?? "";
		const params = tool.inputSchema ? JSON.stringify(tool.inputSchema) : "";
		lines.push(
			`- ${tool.name}${desc ? `: ${desc}` : ""}${params ? `\n  parameters: ${params}` : ""}`,
		);
	}
	return [
		"You can call tools. To call a tool, output ONLY this exact block (no markdown fence):",
		'<tool>{"name": "<tool_name>", "arguments": { ... }}</tool>',
		"Rules:",
		"- Use exactly <tool>...</tool>. Do NOT use <tool:name>, <tool_call>, <name>, <parameter>, id=/name= attributes, or code fences.",
		'- "name" must be one of the tools below; "arguments" must be a JSON object.',
		"- When a tool is needed, emit the <tool> block instead of only describing the plan.",
		"- Emit one <tool> block per call; you may put several blocks back to back.",
		"- If no tool is needed, just answer normally without any <tool> block.",
		"",
		"Available tools:",
		...lines,
	].join("\n");
}

// ── DeepSeek SSE parsing ───────────────────────────────────────────────────

interface SseFragment {
	content?: string;
	type?: string;
}

interface DeepSeekCompletionEvent {
	p?: string;
	v?: unknown;
}

/**
 * Read the DeepSeek completion SSE stream, invoking `onText` / `onReasoning`
 * with content fragments as they arrive. Returns the fully buffered text,
 * reasoning, and the latest `accumulated_token_usage` the server reported
 * (the model's own cumulative context-token count for this conversation).
 *
 * `initialThinking` mirrors the reference client's behavior: reasoning models
 * treat un-tagged content as thinking until the first ANSWER/RESPONSE fragment
 * flips the path.
 */
export async function consumeDeepSeekSse(
	body: ReadableStream<Uint8Array>,
	onText?: (text: string) => void,
	onReasoning?: (text: string) => void,
	initialThinking = false,
): Promise<{
	text: string;
	reasoning: string;
	accumulatedTokenUsage?: number;
}> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let text = "";
	let reasoning = "";
	let thinking = initialThinking;
	let accumulatedTokenUsage: number | undefined;

	// DeepSeek reports the cumulative context-token count in several shapes:
	//   - inside the `response` envelope: { response: { accumulated_token_usage: N } }
	//   - a path update:                 { p: "accumulated_token_usage", v: N }
	//   - a batched update:              { p: "response", o: "BATCH", v: [{ p: "accumulated_token_usage", v: N }] }
	// Capture whichever appears last.
	const captureAccumulatedTokens = (candidate: unknown): void => {
		if (typeof candidate !== "number" || !Number.isFinite(candidate)) return;
		if (candidate >= 0) accumulatedTokenUsage = candidate;
	};

	const cleanFragment = (raw: string): string =>
		raw
			.replace(/FINISHED/g, "")
			.replace(/^(SEARCH|WEB_SEARCH|SEARCHING)\s*/i, "");

	const handleFragment = (fragment: SseFragment): void => {
		const type = String(fragment?.type ?? "").toUpperCase();
		if (type === "THINK") thinking = true;
		else if (type === "ANSWER" || type === "RESPONSE") thinking = false;
		if (
			typeof fragment?.content !== "string" ||
			fragment.content.length === 0
		) {
			return;
		}
		const cleaned = cleanFragment(fragment.content);
		if (!cleaned) return;
		if (thinking) {
			reasoning += cleaned;
			onReasoning?.(cleaned);
		} else {
			text += cleaned;
			onText?.(cleaned);
		}
	};

	const handleEvent = (event: DeepSeekCompletionEvent): void => {
		const p = event.p;
		const v = event.v;
		if (v && typeof v === "object" && (v as { response?: unknown }).response) {
			const response = (v as { response?: unknown }).response as {
				thinking_enabled?: boolean;
				fragments?: SseFragment[];
				accumulated_token_usage?: number;
			};
			if (response.thinking_enabled === true) thinking = true;
			else if (response.thinking_enabled === false) thinking = false;
			captureAccumulatedTokens(response.accumulated_token_usage);
			if (Array.isArray(response.fragments)) {
				for (const fragment of response.fragments) handleFragment(fragment);
			}
		}
		if (p === "response/fragments") {
			if (Array.isArray(v)) {
				for (const fragment of v as SseFragment[]) handleFragment(fragment);
			} else if (v && typeof v === "object") {
				handleFragment(v as SseFragment);
			}
		}
		// Path updates: { p: "<path>", v: <value> } and BATCH updates:
		// { p: ..., o: "BATCH", v: [{ p: <path>, v: <value> }, ...] }.
		if (p === "accumulated_token_usage") {
			captureAccumulatedTokens(v);
		}
		if (Array.isArray(v)) {
			for (const entry of v as unknown[]) {
				const rec = entry as { p?: string; v?: unknown };
				if (rec?.p === "accumulated_token_usage") {
					captureAccumulatedTokens(rec.v);
				}
			}
		}
		if (typeof v === "string" && v.length > 0) {
			const cleaned = cleanFragment(v);
			if (!cleaned) return;
			if (thinking) {
				reasoning += cleaned;
				onReasoning?.(cleaned);
			} else {
				text += cleaned;
				onText?.(cleaned);
			}
		}
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith("data:")) continue;
				const payload = trimmed.replace(/^data:\s*/, "").trim();
				if (!payload || payload === "[DONE]") continue;
				try {
					handleEvent(JSON.parse(payload) as DeepSeekCompletionEvent);
				} catch {
					// ignore malformed lines
				}
			}
		}
	} finally {
		reader.releaseLock();
	}

	return { text, reasoning, accumulatedTokenUsage };
}

// ── Tool-call parsing ──────────────────────────────────────────────────────

interface ParsedToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

/**
 * Normalize common tool-name mistakes the DeepSeek web model makes into their
 * real names. `_codebase` (for `search_codebase`) and similar are frequent
 * enough that recovering them recovers the actual search instead of silently
 * dropping the call. Keys are matched case-insensitively (after trim).
 */
const TOOL_NAME_ALIASES: Record<string, string> = {
	_codebase: "search_codebase",
	codebase: "search_codebase",
	search: "search_codebase",
	searchcodebase: "search_codebase",
	search_code: "search_codebase",
	bash: "run_commands",
	shell: "run_commands",
	command: "run_commands",
	cmd: "run_commands",
	execute: "run_commands",
	execute_command: "run_commands",
	exec_command: "run_commands",
	run: "run_commands",
	runcommand: "run_commands",
	run_command: "run_commands",
	commands: "run_commands",
	terminal: "run_commands",
	read: "read_files",
	readfile: "read_files",
	read_files: "read_files", // identity, harmless
	"file-read": "read_files",
	file_read: "read_files",
	view: "read_files",
	fetch: "fetch_web_content",
	fetch_web: "fetch_web_content",
	"web-fetch": "fetch_web_content",
	web_fetch: "fetch_web_content",
	"http-get": "fetch_web_content",
	http_get: "fetch_web_content",
	write: "editor",
	write_file: "editor",
	edit: "editor",
	edit_file: "editor",
	"edit-file": "editor",
	edits: "editor",
	write_file_from_contents: "editor",
	update: "editor",
	patch: "editor",
	apply_patch: "editor",
	create_file: "editor",
	replace: "editor",
	grep: "search_codebase",
	glob: "search_codebase",
	file_search: "search_codebase",
	search_files: "search_codebase",
	list_code_definition_names: "search_codebase",
	spawn: "spawn_agent",
	spawn_agent_tool: "spawn_agent",
	skill: "skills",
	ask_user: "ask_question",
	question: "ask_question",
};

export function normalizeToolName(name: string): string {
	const key = name.trim().toLowerCase();
	return TOOL_NAME_ALIASES[key] ?? key;
}

/**
 * Parse `<tool>{json}</tool>` blocks from the model's reply into tool calls,
 * and strip them from the visible text. Handles the canonical shape
 * `{"name": "x", "arguments": {...}}` plus common DeepSeek variants
 * (`<tool:name>`, `{"type": "x", "params": {...}}`, XML children).
 *
 * Tolerant of noisy model output: allows a space in the tags (`< tool>`,
 * `</tool >`), ignores markdown bullets/asterisks immediately around a block,
 * repairs common broken JSON (trailing commas, single quotes, stray leading
 * text), and normalizes common tool-name mistakes (`_codebase` →
 * `search_codebase`, `bash` → `run_commands`, etc.).
 */
export function parseDeepSeekToolCalls(
	content: string,
	toolNames: string[],
): { cleanedContent: string; toolCalls: ParsedToolCall[] } {
	// Alias-aware accepted names so near-miss model output still executes.
	const accepted = new Set(toolNames.map(normalizeToolName));
	const toolCalls: ParsedToolCall[] = [];
	const cleanedParts: string[] = [];
	let cursor = 0;
	// `\s*` around `tool` tolerates `< tool>` / `</tool >`; marker handling lets
	// only ACTUAL blocks match (not stray `<tool` inside prose).
	const tagPattern =
		/(?:\*|-)??\s*<\s*tool(?::([\w-]+))?([^>]*)>\s*([\s\S]*?)\s*<\s*\/\s*tool(?::[\w-]+)?\s*>/gi;
	let match: RegExpExecArray | null;

	while ((match = tagPattern.exec(content)) !== null) {
		const full = match[0];
		const tagName = match[1] ?? "";
		const attrs = (match[2] ?? "").trim();
		let inner = (match[3] ?? "").trim();
		const matchIndex = match.index;
		// The leading `\*`/`-` bullet (if any) was consumed by the match; the tag
		// itself is stripped while surrounding prose stays as visible text.
		cleanedParts.push(content.slice(cursor, matchIndex));
		cursor = matchIndex + full.length;

		// Extract the tool name from tag suffix, id/name attributes, XML, or the
		// JSON body.
		const nameMatch = /(?:id|name)\s*=\s*["']([^"']+)["']/i.exec(attrs);
		let name = tagName || nameMatch?.[1] || "";

		// <tool><name>x</name><arguments>{...}</arguments></tool>
		const xmlName = /<name>([^<]+)<\/name>/i.exec(inner);
		const xmlArgs = /<arguments>([\s\S]*?)<\/arguments>/i.exec(inner);
		if (xmlName) name = xmlName[1].trim();
		if (xmlArgs) inner = xmlArgs[1].trim();

		const jsonText = inner;
		let args: unknown;

		try {
			const parsed = parseRepairedToolJson(jsonText) as
				| Record<string, unknown>
				| undefined;
			if (parsed) {
				const record = parsed as Record<string, unknown>;
				args = record.arguments ?? record.params;
				if (!name) name = typeof record.name === "string" ? record.name : "";
				if (!name) name = typeof record.type === "string" ? record.type : "";
				if (args === undefined && typeof record.arguments_json === "string") {
					try {
						args = JSON.parse(record.arguments_json);
					} catch {
						args = undefined;
					}
				}
				// <tool:name>{...args...}</tool:name> — bare JSON body is args.
				if (
					args === undefined &&
					name &&
					record.name === undefined &&
					record.type === undefined &&
					record.arguments_json === undefined
				) {
					args = record;
				}
			}
		} catch {
			args = undefined;
		}

		const normalizedName = normalizeToolName(name);
		if (!name || !accepted.has(normalizedName)) {
			// Unknown tool name — keep the raw block as visible text so the
			// user sees what was said instead of it disappearing silently.
			cleanedParts.push(full);
			continue;
		}
		toolCalls.push({
			name: normalizedName,
			arguments:
				args && typeof args === "object" && !Array.isArray(args)
					? (args as Record<string, unknown>)
					: {},
		});
	}
	cleanedParts.push(content.slice(cursor));

	return { cleanedContent: cleanedParts.join("").trim(), toolCalls };
}

/**
 * Catch tool calls the strict paired-tag regex in `parseDeepSeekToolCalls`
 * misses because the model emitted a "wrong" (but still recognizable) shape:
 * a bare `<tool name="...">`, an unbalanced `<tool>...</tool>`, or any
 * `<tool...>`-prefixed block whose closing tag is absent/malformed.
 *
 * This is a best-effort recovery: it extracts a candidate name (from a
 * `name`/`type` attribute or from a JSON body) and parses any trailing JSON
 * object as the argument map. If the result doesn't normalize to a known tool,
 * it returns an empty list so the caller falls through to its other handling.
 */
export function parseLooseDeepSeekToolCalls(
content: string,
toolNames: string[],
): ParsedToolCall[] {
const accepted = new Set(toolNames.map(normalizeToolName));
const toolCalls: ParsedToolCall[] = [];

const openTagRe = /<\s*tool[\w:-]*\b([^>]*)>/gi;
let match: RegExpExecArray | null;
while ((match = openTagRe.exec(content)) !== null) {
const attrs = (match[1] ?? "").trim();
const afterTag = content.slice(match.index + match[0].length);

let name =
/(?:id|name)\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? "";

let args: Record<string, unknown> = {};
const bodyText = extractBalancedJsonValue(afterTag) ?? afterTag;
const parsed = parseRepairedToolJson(bodyText);
if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
const record = parsed as Record<string, unknown>;
if (!name) {
name =
typeof record.name === "string"
? record.name
: typeof record.type === "string"
? record.type
: "";
}
const candidate =
record.arguments ?? record.params ?? record.arguments_json ?? record;
if (
candidate &&
typeof candidate === "object" &&
!Array.isArray(candidate)
) {
args = candidate as Record<string, unknown>;
}
}

const normalizedName = normalizeToolName(name);
if (!normalizedName || !accepted.has(normalizedName)) continue;

if (toolCalls.some((c) => c.name === normalizedName)) continue;

toolCalls.push({ name: normalizedName, arguments: args });
}

return toolCalls;
}

/**
 * Extract the first balanced top-level JSON value (`{...}` or `[...]`) from a
 * string, tracking braces/brackets and strings so nested objects are handled.
 * Returns `null` if no balanced value is found. Used to strip trailing junk
 * (e.g. a stray `</tool>`) that would otherwise break the JSON repair parser.
 */
function extractBalancedJsonValue(text: string): string | null {
	const start = text.search(/[\[{]/);
	if (start === -1) return null;
	const openChar = text[start];
	const closeChar = openChar === "{" ? "}" : "]";
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === openChar) depth++;
		else if (ch === closeChar) {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

/**
 * Parse the JSON body of a `<tool>` block, repairing common malformed output
 * the web model emits. Returns the parsed object, or `undefined` if it cannot
 * be recovered (in which case the block is treated as plain visible text).
 *
 * Safety: a block that is ALREADY valid JSON is returned verbatim — repair is
 * only attempted on genuinely-broken input, and the single-quote converter is
 * quote-aware so it never rewrites single quotes that live inside an already
 * double-quoted JSON string (e.g. a PowerShell command containing `'name'`).
 */
export function parseRepairedToolJson(raw: string): unknown {
	let text = raw.trim();
	if (!text) return undefined;

	// Pull the first balanced top-level JSON object if the block has prose.
	if (!/^[\s]*[{[]/.test(text)) {
		const objStart = text.indexOf("{");
		if (objStart === -1) return undefined;
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let i = objStart; i < text.length; i++) {
			const ch = text[i];
			if (inString) {
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') inString = true;
			else if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					text = text.slice(objStart, i + 1);
					break;
				}
			}
		}
	}

	// Fast path: already-valid JSON must pass through untouched.
	try {
		return JSON.parse(text);
	} catch {
		// fall through to repair
	}

	// Repair pass (only reached when plain JSON.parse failed above):
	//  - strip surrounding code-fence markers,
	//  - drop trailing commas,
	//  - fix invalid single-backslash escapes (the model often emits Windows
	//    paths like `C:\Users` inside a JSON string, where `\U` is an illegal
	//    escape and must become `\\U`),
	//  - convert single-quoted strings — skipping any quotes inside double-quoted
	//    JSON strings — so genuinely-broken input recovers without mangling
	//    values that legitimately contain single quotes (e.g. `'path'`).
	const repairedFinal = repairQuotesAndEscapes(
		text
			.replace(/^\s*```(?:json)?\s*/i, "")
			.replace(/\s*```\s*$/i, "")
			.replace(/,\s*([}\]])/g, "$1"),
	);
	try {
		return JSON.parse(repairedFinal);
	} catch {
		return undefined;
	}
}

/**
 * Convert single-quoted strings to JSON double-quoted strings, skipping any
 * single quotes that appear inside an already double-quoted JSON string value
 * (which are literal characters and must be preserved), AND repair invalid
 * single-backslash escapes inside double-quoted strings (e.g. `\U` from a
 * Windows path `C:\Users` → `\\U`) so the JSON parses.
 */
function repairQuotesAndEscapes(text: string): string {
	let out = "";
	let inDouble = false;
	let inSingle = false;
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (inDouble) {
			if (ch === "\\") {
				const next = text[i + 1];
				// Valid JSON escapes stay as-is; a backslash followed by anything
				// else is an illegal escape (common in Windows paths) — double it.
				if (
					next === '"' ||
					next === "\\" ||
					next === "/" ||
					next === "b" ||
					next === "f" ||
					next === "n" ||
					next === "r" ||
					next === "t" ||
					next === "u"
				) {
					out += `\\${next ?? ""}`;
					i += 2;
				} else if (next === undefined) {
					out += "\\\\";
					i += 1;
				} else {
					out += "\\\\" + next;
					i += 2;
				}
				continue;
			}
			out += ch;
			if (ch === '"') inDouble = false;
			i++;
			continue;
		}
		if (inSingle) {
			if (ch === "\\") {
				const next = text[i + 1];
				out += `\\${next ?? "\\\\"}`;
				i += 2;
				continue;
			}
			if (ch === "'") {
				out += '"';
				inSingle = false;
			} else {
				out += ch;
			}
			i++;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			out += ch;
		} else if (ch === "'") {
			inSingle = true;
			out += '"';
		} else {
			out += ch;
		}
		i++;
	}
	return out;
}

// ── Completion request ─────────────────────────────────────────────────────

export function resolveModelOptions(modelId: string): {
	modelType: string;
	thinkingEnabled: boolean;
} {
	const m = modelId.toLowerCase();
	const modelType =
		m.includes("pro") || m.includes("expert") ? "expert" : "default";
	const thinkingEnabled =
		m.includes("r1") ||
		m.includes("think") ||
		m.includes("reason") ||
		m.includes("deepthink");
	return { modelType, thinkingEnabled };
}

async function runCompletion(input: {
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

function buildPrompt(
	prompt: LanguageModelV2Prompt,
	_tools: LanguageModelV2FunctionTool[] | undefined,
): string {
	// The runtime-composed system prompt (sdk/packages/shared/src/prompt/system.ts)
	// already carries the `<tool>` calling protocol and the available tool list,
	// so no extra tool-contract block is prepended — the chat shows exactly the
	// system prompt + conversation.
	return messagesToPrompt(prompt);
}

function finishReasonFor(
	text: string,
	toolCalls: ParsedToolCall[],
): LanguageModelV2FinishReason {
	return toolCalls.length > 0 ? "tool-calls" : text ? "stop" : "unknown";
}

export interface DeepSeekWebUsageEstimate {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
}

/**
 * Estimate token usage from the exact flat `prompt` string sent to
 * chat.deepseek.com and the buffered reply (`text` + `reasoning`).
 *
 * The web endpoint does not report token counts, so this uses the repo-wide
 * heuristic (`estimateTokens` = chars / 3, conservative) so the context bar,
 * per-turn metrics and session totals show real numbers instead of zeros.
 */
export function estimateDeepSeekWebUsage(
	prompt: string,
	output: string,
): DeepSeekWebUsageEstimate {
	const inputTokens = estimateTokens(prompt.length);
	const outputTokens = estimateTokens(output.length);
	return {
		inputTokens,
		outputTokens,
		totalTokens: inputTokens + outputTokens,
	};
}

// ── LanguageModelV2 adapter ────────────────────────────────────────────────

function createDeepSeekWebModel(
	modelId: string,
	config: GatewayResolvedProviderConfig,
	fetchImpl: typeof fetch,
): LanguageModelV2 {
	const userToken = extractUserToken(config.apiKey);

	const doCompletion = async (
		options: LanguageModelV2CallOptions,
		onText?: (text: string) => void,
		onReasoning?: (text: string) => void,
	): Promise<{
		text: string;
		reasoning: string;
		toolCalls: ParsedToolCall[];
		usage: DeepSeekWebUsageEstimate;
	}> => {
		if (!userToken) {
			throw new Error(
				"Missing userToken — paste the value from DevTools → Application → Local Storage → chat.deepseek.com → userToken",
			);
		}
		const functionTools = (options.tools ?? []).filter(
			(tool): tool is LanguageModelV2FunctionTool => tool.type === "function",
		);
		const prompt = buildPrompt(options.prompt, functionTools);
		const { text, reasoning, accumulatedTokenUsage } = await runCompletion({
			userToken,
			modelId,
			prompt,
			fetchImpl,
			signal: options.abortSignal,
			onText,
			onReasoning,
		});
		// Prefer DeepSeek's cumulative context-token count when reported;
		// otherwise fall back to the chars/3 estimate.
		const estimated = estimateDeepSeekWebUsage(prompt, `${text}${reasoning}`);
		const usage: DeepSeekWebUsageEstimate =
			accumulatedTokenUsage !== undefined
				? {
						inputTokens: accumulatedTokenUsage,
						outputTokens: estimated.outputTokens,
						totalTokens: accumulatedTokenUsage + estimated.outputTokens,
					}
				: estimated;

		if (functionTools.length > 0) {
			const { cleanedContent, toolCalls } = parseDeepSeekToolCalls(
				text,
				functionTools.map((t) => t.name),
			);
			return { text: cleanedContent, reasoning, toolCalls, usage };
		}
		return { text, reasoning, toolCalls: [], usage };
	};

	return {
		specificationVersion: "v2",
		provider: "deepseek-web",
		modelId,
		supportedUrls: {},
		doGenerate: async (options) => {
			const { text, reasoning, toolCalls, usage } = await doCompletion(options);
			const content: Array<
				| { type: "text"; text: string }
				| { type: "reasoning"; text: string }
				| {
						type: "tool-call";
						toolCallId: string;
						toolName: string;
						input: string;
				  }
			> = [];
			if (reasoning) content.push({ type: "reasoning", text: reasoning });
			if (text) content.push({ type: "text", text });
			for (let i = 0; i < toolCalls.length; i++) {
				content.push({
					type: "tool-call",
					toolCallId: `call-${Date.now()}-${i}`,
					toolName: toolCalls[i].name,
					input: JSON.stringify(toolCalls[i].arguments),
				});
			}
			return {
				content,
				finishReason: finishReasonFor(text, toolCalls),
				usage: {
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					totalTokens: usage.totalTokens,
				},
				warnings: [],
			};
		},
		doStream: async (options) => {
			const id = `deepseek-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const textChunks: string[] = [];
			const reasoningChunks: string[] = [];
			const functionTools = (options.tools ?? []).filter(
				(tool): tool is LanguageModelV2FunctionTool => tool.type === "function",
			);

			// The web endpoint has no per-token tool streaming; buffer the reply
			// so `<tool>` blocks can be parsed and stripped before emitting.
			const completion = await doCompletion(
				options,
				(t) => textChunks.push(t),
				(r) => reasoningChunks.push(r),
			);

			const reasoningText = reasoningChunks.join("");
			const rawText = textChunks.join("");
			const { cleanedContent, toolCalls } =
				functionTools.length > 0
					? parseDeepSeekToolCalls(
							rawText,
							functionTools.map((t) => t.name),
						)
					: { cleanedContent: rawText, toolCalls: [] };

			const parts: LanguageModelV2StreamPart[] = [
				{ type: "stream-start", warnings: [] },
				{ type: "response-metadata", id },
			];
			if (reasoningText) {
				parts.push({ type: "reasoning-start", id });
				parts.push({ type: "reasoning-delta", id, delta: reasoningText });
				parts.push({ type: "reasoning-end", id });
			}
			if (cleanedContent) {
				parts.push({ type: "text-start", id });
				parts.push({ type: "text-delta", id, delta: cleanedContent });
				parts.push({ type: "text-end", id });
			}
			for (let i = 0; i < toolCalls.length; i++) {
				const input = JSON.stringify(toolCalls[i].arguments);
				parts.push({
					type: "tool-input-start",
					id,
					toolName: toolCalls[i].name,
				});
				parts.push({ type: "tool-input-delta", id, delta: input });
				parts.push({ type: "tool-input-end", id });
				parts.push({
					type: "tool-call",
					toolCallId: `call-${Date.now()}-${i}`,
					toolName: toolCalls[i].name,
					input,
				});
			}
			parts.push({
				type: "finish",
				finishReason: finishReasonFor(cleanedContent, toolCalls),
				usage: {
					inputTokens: completion.usage.inputTokens,
					outputTokens: completion.usage.outputTokens,
					totalTokens: completion.usage.totalTokens,
				},
			});

			let index = 0;
			const stream = new ReadableStream<LanguageModelV2StreamPart>({
				pull(controller) {
					if (index < parts.length) {
						controller.enqueue(parts[index++]);
						return;
					}
					controller.close();
				},
				cancel() {
					index = parts.length;
				},
			});

			return { stream, warnings: [] };
		},
	};
}

export function createDeepSeekWebProviderModule(
	config: GatewayResolvedProviderConfig,
	_context: GatewayProviderContext,
): ProviderFactoryResult {
	const fetchImpl = ensureFetch(config.fetch);
	return {
		model: (modelId) => createDeepSeekWebModel(modelId, config, fetchImpl),
	};
}
