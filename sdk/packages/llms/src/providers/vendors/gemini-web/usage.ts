/**
 * Gemini's usage meter, read from the endpoint behind its Settings > Usage
 * page. That page calls a persisted GraphQL query that returns one pool per
 * window ("GXU_FIVE_HOURLY", "GXU_WEEKLY"), each with `percentageUsed` and
 * `gxu.windowRefreshesAt`. Read after every turn from inside the logged-in
 * page, so the status bar shows how much of the limit is left and when it
 * refills, instead of only finding out from the "you've reached your limit"
 * notice (see limit.ts, which still covers the case this read fails).
 *
 * The query is identified by `query_signature`, a hash of the query text. A
 * Gemini release can change it; the read then fails quietly and the status
 * bar falls back to the token estimate alone.
 */

const QUERY_SIGNATURE = "2/yL2v1aYbA346hkaeglNZmTMJfO37mMT1xFprjCS/Pj4=";
const VARIABLES = {
	g1Request: {
		entrypoints: [
			"GEMINI_USAGE_SETTINGS_UPGRADE_BANNER",
			"GEMINI_USAGE_SETTINGS_AI_CREDITS_UPSELL_CARD",
			"GEMINI_USAGE_SETTINGS_UPGRADE_AND_CREDITS_BANNER",
		],
	},
	workspaceRequest: {
		recommendationsForSurfaceRequests: [
			{
				recommendationSurface: {
					rpOnramp: "GEMINI_CHAT_USAGE_LIMITS_UPSELL",
					version: "1",
				},
				maxRecommendationCount: 1,
			},
		],
	},
};

export const GEMINI_USAGE_URL =
	"https://gemini.google.com/_/BardChatUi/graphql/schemas/GEMINI_WEB_GRAPHQL/executeQuery" +
	`?query_signature=${encodeURIComponent(QUERY_SIGNATURE)}` +
	`&variables=${encodeURIComponent(JSON.stringify(VARIABLES))}`;

/**
 * `percentageUsed` comes back as a fraction (0.5 = half the window spent).
 * If Gemini's Usage page shows a figure 100x off from the status bar, flip
 * this to 1.
 */
const PERCENT_SCALE = 100;

/** Runs in the page; resolves to the response text, or "" on any failure. */
export const READ_GEMINI_USAGE_SCRIPT = `(async () => {
  try {
    const r = await fetch(${JSON.stringify(GEMINI_USAGE_URL)}, {
      method: "GET", credentials: "include", headers: { accept: "application/json" } });
    return r.ok ? await r.text() : "";
  } catch (e) { return ""; }
})()`;

export interface GeminiUsagePool {
	percent: number;
	resetsAt?: string;
}

export interface GeminiUsage {
	fiveHour?: GeminiUsagePool;
	weekly?: GeminiUsagePool;
	/** The pool that runs out first: the fuller one, the 5-hour one on a tie. */
	binding: GeminiUsagePool;
}

function findPools(node: unknown, depth = 0): unknown[] | undefined {
	if (!node || typeof node !== "object" || depth > 12) return undefined;
	if (Array.isArray(node)) {
		for (const item of node) {
			const found = findPools(item, depth + 1);
			if (found) return found;
		}
		return undefined;
	}
	const record = node as Record<string, unknown>;
	const usageInfo = record.getUsageInfo as { pools?: unknown } | undefined;
	if (usageInfo && Array.isArray(usageInfo.pools)) return usageInfo.pools;
	for (const value of Object.values(record)) {
		const found = findPools(value, depth + 1);
		if (found) return found;
	}
	return undefined;
}

/** Parse the endpoint's body (a JSON array of deferred parts, or one object). */
export function parseGeminiUsage(body: string): GeminiUsage | undefined {
	if (!body) return undefined;
	let json: unknown;
	try {
		json = JSON.parse(body.replace(/^\)\]\}'\s*/, ""));
	} catch {
		return undefined;
	}
	const pools = findPools(json);
	if (!pools) return undefined;
	const read = (type: string): GeminiUsagePool | undefined => {
		const pool = pools.find(
			(p) => (p as { poolType?: unknown })?.poolType === type,
		) as
			| { percentageUsed?: unknown; gxu?: { windowRefreshesAt?: unknown } }
			| undefined;
		if (
			typeof pool?.percentageUsed !== "number" ||
			!Number.isFinite(pool.percentageUsed)
		) {
			return undefined;
		}
		const at = pool.gxu?.windowRefreshesAt;
		const resetsAt =
			typeof at === "string" && !Number.isNaN(Date.parse(at))
				? new Date(at).toISOString()
				: undefined;
		return {
			percent: Math.max(0, Math.min(pool.percentageUsed * PERCENT_SCALE, 100)),
			...(resetsAt ? { resetsAt } : {}),
		};
	};
	const fiveHour = read("GXU_FIVE_HOURLY");
	const weekly = read("GXU_WEEKLY");
	const binding =
		fiveHour && weekly
			? weekly.percent > fiveHour.percent
				? weekly
				: fiveHour
			: (fiveHour ?? weekly);
	if (!binding) return undefined;
	return {
		...(fiveHour ? { fiveHour } : {}),
		...(weekly ? { weekly } : {}),
		binding,
	};
}
