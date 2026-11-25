import * as fs from "node:fs";
import * as path from "node:path";
import { readGeminiLimit } from "../gemini-web/limit";

/**
 * Copilot's daily allowance, counted here because the page does not show it.
 *
 * The chat hub reports a per-chat count (600 messages) on every reply, but
 * the binding cap is a daily one that only appears once it is spent, as the
 * reply "You've reached your daily limit. Get more usage now or check back at
 * 12:00 AM." On the free plan it ran out after about 14 messages and 90k
 * tokens in, so it looks like a cost quota, not a message count. So each send
 * is counted (messages and estimated tokens) per local day, and the limit
 * notice is kept with its reset time until that passes.
 *
 * The file sits beside the profile's chat registry, so each browser profile
 * (each Microsoft account) has its own count, and survives a hub restart.
 */

export interface CopilotDayUsage {
	/** Local date, YYYY-MM-DD. */
	day: string;
	messages: number;
	tokensIn: number;
	tokensOut: number;
	/** When the daily limit was hit, ISO, and how far the day had got. */
	limitHitAt?: string;
	limitHitAfter?: { messages: number; tokensIn: number };
	/** When the limit lifts, ISO. */
	limitResetsAt?: string;
}

interface UsageFile {
	today?: CopilotDayUsage;
	/** Earlier days, newest last, for seeing what a day's cap came to. */
	history?: CopilotDayUsage[];
}

const HISTORY_DAYS = 30;

function localDay(now: Date): string {
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

export function usageFileFor(chatsFile: string): string {
	return path.join(path.dirname(chatsFile), "usage.json");
}

function load(file: string): UsageFile {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as UsageFile;
	} catch {
		return {};
	}
}

function save(file: string, data: UsageFile): void {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(data, null, 2));
	} catch {
		// A count that cannot be saved is not worth failing a turn over.
	}
}

/** Today's record, rolling yesterday's into the history. */
function current(data: UsageFile, now: Date): CopilotDayUsage {
	const day = localDay(now);
	const t = data.today;
	if (t && t.day === day) return t;
	if (t) {
		data.history = [...(data.history ?? []), t].slice(-HISTORY_DAYS);
	}
	// A limit hit late yesterday may still hold past midnight (its own reset
	// time says when), so carry it over until it passes.
	const carried =
		t?.limitResetsAt && Date.parse(t.limitResetsAt) > now.getTime()
			? { limitHitAt: t.limitHitAt, limitResetsAt: t.limitResetsAt }
			: {};
	data.today = { day, messages: 0, tokensIn: 0, tokensOut: 0, ...carried };
	return data.today;
}

/**
 * Note one sent message and its reply. A reply that is the daily-limit notice
 * records the limit (and does not count as a message, since nothing was
 * answered). Returns the day as it now stands.
 */
export function recordCopilotTurn(
	file: string,
	turn: { tokensIn: number; tokensOut: number; replyText: string },
	now = new Date(),
): CopilotDayUsage {
	const data = load(file);
	const today = current(data, now);
	const limit = readCopilotLimit(turn.replyText, now);
	if (limit) {
		today.limitHitAt = now.toISOString();
		today.limitHitAfter = {
			messages: today.messages,
			tokensIn: today.tokensIn,
		};
		if (limit.resetsAt) today.limitResetsAt = limit.resetsAt;
		else delete today.limitResetsAt;
	} else {
		today.messages++;
		today.tokensIn += Math.max(0, Math.round(turn.tokensIn));
		today.tokensOut += Math.max(0, Math.round(turn.tokensOut));
		// An answer means the limit has lifted, whatever the clock says.
		delete today.limitHitAt;
		delete today.limitResetsAt;
	}
	save(file, data);
	return today;
}

/** Today's usage without recording anything (rolls the day over if needed). */
export function readCopilotUsage(
	file: string,
	now = new Date(),
): CopilotDayUsage {
	const data = load(file);
	const before = data.today?.day;
	const today = current(data, now);
	if (today.day !== before) save(file, data);
	return today;
}

/** Whether the day's limit is in force now. */
export function copilotLimitActive(
	usage: CopilotDayUsage,
	now = new Date(),
): boolean {
	if (!usage.limitHitAt) return false;
	if (!usage.limitResetsAt) return true;
	return Date.parse(usage.limitResetsAt) > now.getTime();
}

/**
 * The limit a reply announces ("You've reached your daily limit ... check back
 * at 12:00 AM"), or undefined for an ordinary reply. The wording is matched
 * loosely, as Gemini's is.
 */
export function readCopilotLimit(
	text: string,
	now = new Date(),
): { resetsAt?: string } | undefined {
	return readGeminiLimit(text, now);
}
