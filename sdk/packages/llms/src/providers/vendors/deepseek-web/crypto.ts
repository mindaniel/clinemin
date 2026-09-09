import type { PowChallenge } from "./config";

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

export function generateFakeCookie(): string {
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
