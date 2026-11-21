import type { GeminiUsage } from "./usage";

/**
 * Gemini's usage limit, read off the message it shows when the limit is hit.
 *
 * gemini.google.com has no usage readout to scrape, unlike Claude's session
 * percentage or ChatGPT's messages left. The one thing it does say is the
 * notice it answers with once a model's allowance is spent, which names when
 * it comes back ("... until Nov 16, 3:24 PM", "... resets at 15:24"). So that
 * time is kept until it passes and shown in the status bar beside the context
 * estimate.
 *
 * The wording is matched loosely because Google changes it; a notice whose
 * time cannot be read still reports the limit, with the reset time unknown.
 */

/** Longest reply that can be a limit notice rather than an answer about one. */
const MAX_NOTICE_CHARS = 600;

const LIMIT_RE =
	/(reached|hit) (your|the) [\w .-]{0,40}limit|limit (resets|will reset)|usage limit/i;

const MONTHS = [
	"jan",
	"feb",
	"mar",
	"apr",
	"may",
	"jun",
	"jul",
	"aug",
	"sep",
	"oct",
	"nov",
	"dec",
];

/**
 * "until|resets [on|at] [Mon D[,]] [at] H[:MM] [AM|PM]". The date part is
 * optional (a time alone means the next time it comes round).
 */
const RESET_RE =
	/(?:until|resets?|reset)\s+(?:on\s+|at\s+)?(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([AaPp])?\.?\s*[Mm]?\.?(?![\w:])/;

export interface GeminiLimit {
	/** When the limit lifts, ISO; absent when the notice gave no readable time. */
	resetsAt?: string;
}

/** The limit a reply announces, or undefined for an ordinary reply. */
export function readGeminiLimit(
	text: string,
	now = new Date(),
): GeminiLimit | undefined {
	const trimmed = text.trim();
	if (!trimmed || trimmed.length > MAX_NOTICE_CHARS) return undefined;
	if (!LIMIT_RE.test(trimmed)) return undefined;
	const m = RESET_RE.exec(trimmed);
	if (!m) return {};
	const [, monthWord, day, hourText, minuteText, meridiem] = m;
	let hour = Number(hourText);
	const minute = minuteText ? Number(minuteText) : 0;
	if (meridiem) {
		if (hour < 1 || hour > 12) return {};
		hour = (hour % 12) + (meridiem.toLowerCase() === "p" ? 12 : 0);
	} else if (!minuteText) {
		// A bare number with no colon and no AM/PM is not a time.
		return {};
	}
	if (hour > 23 || minute > 59) return {};

	const at = new Date(now);
	at.setSeconds(0, 0);
	at.setHours(hour, minute);
	if (monthWord && day) {
		const month = MONTHS.indexOf(monthWord.slice(0, 3).toLowerCase());
		if (month < 0) return {};
		at.setMonth(month, Number(day));
		// "Jan 2" read in late December is next year.
		if (at.getTime() < now.getTime() - 24 * 3600_000) {
			at.setFullYear(at.getFullYear() + 1);
		}
	} else if (at.getTime() <= now.getTime()) {
		at.setDate(at.getDate() + 1);
	}
	return { resetsAt: at.toISOString() };
}

/**
 * The last limit seen, kept until its reset time passes so the status bar
 * keeps saying so on the turns in between (Gemini answers them from another
 * model without repeating the notice).
 */
let lastLimit: GeminiLimit | undefined;

/** Note a reply's limit notice, if any, and return what the status bar shows. */
export function trackGeminiLimit(
	text: string,
	now = new Date(),
): GeminiLimit | undefined {
	const seen = readGeminiLimit(text, now);
	if (seen) {
		lastLimit = seen;
	} else if (
		// Past its reset, or a notice with no time: an ordinary reply ends it.
		!lastLimit?.resetsAt ||
		Date.parse(lastLimit.resetsAt) <= now.getTime()
	) {
		lastLimit = undefined;
	}
	return lastLimit;
}

/**
 * `providerMetadata` for the finish part. Sent on every turn, `false` included:
 * the status bar keeps the last status it was given, so without the `false` a
 * limit once shown would never clear.
 */
export function geminiLimitProviderMetadata(
	limit: GeminiLimit | undefined,
	quota?: GeminiUsage,
) {
	// The meter is the better source: it knows the limit is spent (100%) and
	// when it refills even when the notice gave no readable time.
	const spent = !!limit || (quota ? quota.binding.percent >= 100 : false);
	const resetsAt =
		limit?.resetsAt ?? (spent ? quota?.binding.resetsAt : undefined);
	return {
		providerMetadata: {
			"gemini-web": {
				limitReached: spent,
				...(resetsAt ? { limitResetsAt: resetsAt } : {}),
				...(quota
					? {
							sessionPercent: quota.binding.percent,
							...(quota.binding.resetsAt
								? { sessionResetsAt: quota.binding.resetsAt }
								: {}),
							...(quota.weekly ? { weeklyPercent: quota.weekly.percent } : {}),
						}
					: {}),
			},
		},
	};
}
