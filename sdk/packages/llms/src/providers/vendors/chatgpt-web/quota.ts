/**
 * The message allowance ChatGPT web reports after each reply.
 *
 * A web session has no token budget worth showing — the thing that actually
 * stops a user is ChatGPT's own message cap. Every completion stream ends with
 * a `conversation_detail_metadata` event, and what it carries depends on where
 * in the cycle the account is:
 *
 *  - With allowance left, `limits_progress` counts down:
 *      {"feature_name":"reason","remaining":4,"reset_after":"2026-09-18T01:18:40Z"}
 *    `reason` is the entry that counts messages sent to the model; the rest
 *    (`deep_research`, `file_upload`, `image_gen`, ...) are features this CLI
 *    never uses.
 *
 *  - On the turn the cap is hit, `remaining` reaches 0 and `model_limits`
 *    appears, naming the metered model and when it frees up.
 *
 *  - On every turn after that, `limits_progress` and `model_limits` are both
 *    gone — the account is on the fallback model, which has no meter — and
 *    only `blocked_features` is left, each with the same account reset time.
 *
 * Reading `limits_progress` alone therefore showed a number for the few turns
 * before the cap and "—" for the whole exhausted stretch, which is exactly
 * when the reset time is the one thing worth knowing. So this walks all three,
 * and `mergeChatGPTMessageQuota` carries the last known answer forward.
 */

export interface ChatGPTQuotaEntry {
	featureName: string;
	remaining: number;
	resetAfter: string;
}

/** Everything one `conversation_detail_metadata` event says about limits. */
export interface ChatGPTQuotaSnapshot {
	entries: ChatGPTQuotaEntry[];
	modelLimits: { modelSlug?: string; resetsAfter?: string }[];
	blockedFeatures: { name: string; resetsAfter?: string }[];
}

export interface ChatGPTMessageQuota {
	remaining: number;
	/** ISO timestamp the allowance refills at, when ChatGPT sent one. */
	resetsAt?: string;
	/** Model the cap applies to, when ChatGPT named one. */
	limitedModel?: string;
}

export const CHATGPT_MESSAGE_QUOTA_FEATURE = "reason";

/**
 * Features whose reset time is the account's, not a side feature's.
 *
 * `send` means sending is blocked outright. The others are the two that ride
 * along on a free account's daily reset and carry the same timestamp, which
 * makes them a usable last resort once everything else is gone.
 */
const ACCOUNT_RESET_FEATURES = ["send", "file_upload", "image_gen"];

function validIso(value: string | undefined): string | undefined {
	return value && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

export function pickChatGPTMessageQuota(
	snapshot: ChatGPTQuotaSnapshot | undefined,
): ChatGPTMessageQuota | undefined {
	if (!snapshot) return undefined;

	const entry = snapshot.entries.find(
		(q) => q.featureName === CHATGPT_MESSAGE_QUOTA_FEATURE,
	);
	if (entry && Number.isFinite(entry.remaining)) {
		const resetsAt = validIso(entry.resetAfter);
		const limitedModel = snapshot.modelLimits.find(
			(m) => m.modelSlug,
		)?.modelSlug;
		return {
			remaining: Math.max(0, Math.floor(entry.remaining)),
			...(resetsAt ? { resetsAt } : {}),
			...(limitedModel ? { limitedModel } : {}),
		};
	}

	// No counter left. A named model limit still means "capped, here is when".
	const modelLimit = snapshot.modelLimits.find((m) => validIso(m.resetsAfter));
	if (modelLimit) {
		return {
			remaining: 0,
			resetsAt: validIso(modelLimit.resetsAfter),
			...(modelLimit.modelSlug ? { limitedModel: modelLimit.modelSlug } : {}),
		};
	}

	// Last resort: the account-wide reset time riding on a blocked feature.
	const blocked = snapshot.blockedFeatures.find(
		(f) => ACCOUNT_RESET_FEATURES.includes(f.name) && validIso(f.resetsAfter),
	);
	if (blocked) {
		return { remaining: 0, resetsAt: validIso(blocked.resetsAfter) };
	}

	return undefined;
}

/**
 * Carry the previous turn's answer forward when this turn reported nothing.
 *
 * ChatGPT simply stops sending limit metadata on some turns, and a status bar
 * that flips between a number and "—" turn by turn is worse than one that
 * holds the last thing it was told. A quota whose reset time has already
 * passed is dropped instead: the allowance has refilled and the old number is
 * a lie.
 */
export function mergeChatGPTMessageQuota(
	previous: ChatGPTMessageQuota | undefined,
	next: ChatGPTMessageQuota | undefined,
	now: Date = new Date(),
): ChatGPTMessageQuota | undefined {
	if (next) return next;
	if (!previous) return undefined;
	if (previous.resetsAt && Date.parse(previous.resetsAt) <= now.getTime()) {
		return undefined;
	}
	return previous;
}
