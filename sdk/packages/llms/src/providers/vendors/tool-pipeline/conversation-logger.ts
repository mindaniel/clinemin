import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ParsedResponse {
	text: string;
	toolCalls?: { name: string; arguments: Record<string, unknown> }[];
	usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
	finishReason?: string;
	// additional fields may be present per provider
	[key: string]: unknown;
}

const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The hub is long-lived, so prune at most once a day per process. */
const PRUNE_INTERVAL_MS = DAY_MS;
let lastPruneAt = 0;

export function rawLogRoot(): string {
	return path.join(os.homedir(), ".cline", "rawjsonhistory");
}

/**
 * Days to keep raw logs, from `CLINE_RAW_LOG_RETENTION_DAYS` (default 30).
 * `0` turns raw logging off entirely.
 */
export function rawLogRetentionDays(): number {
	const raw = process.env.CLINE_RAW_LOG_RETENTION_DAYS?.trim();
	if (!raw) return DEFAULT_RETENTION_DAYS;
	const days = Number(raw);
	return Number.isFinite(days) && days >= 0 ? days : DEFAULT_RETENTION_DAYS;
}

/**
 * Delete log files not written to in `retentionDays`, and any provider folder
 * left empty. Returns how many files were removed. Never throws.
 */
export function pruneRawLogs(
	retentionDays = rawLogRetentionDays(),
	root = rawLogRoot(),
	now = Date.now(),
): number {
	let removed = 0;
	const cutoff = now - retentionDays * DAY_MS;
	let providers: fs.Dirent[];
	try {
		providers = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const provider of providers) {
		if (!provider.isDirectory()) continue;
		const dir = path.join(root, provider.name);
		try {
			for (const name of fs.readdirSync(dir)) {
				if (!name.endsWith(".log")) continue;
				const file = path.join(dir, name);
				try {
					if (fs.statSync(file).mtimeMs < cutoff) {
						fs.rmSync(file, { force: true });
						removed++;
					}
				} catch {
					// Skip files that vanish or cannot be read.
				}
			}
			if (fs.readdirSync(dir).length === 0) {
				fs.rmdirSync(dir);
			}
		} catch {
			// Best effort: a locked folder is retried on the next prune.
		}
	}
	return removed;
}

function maybePrune(retentionDays: number): void {
	const now = Date.now();
	if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
	lastPruneAt = now;
	pruneRawLogs(retentionDays, rawLogRoot(), now);
}

/**
 * Append a single turn's raw and parsed response to a per‑conversation log file.
 * Logs are stored under ~/.cline/rawjsonhistory/<provider>/<chatKey>.log.
 * The file is JSON lines – each line is one turn. Files untouched for
 * `CLINE_RAW_LOG_RETENTION_DAYS` (default 30) are deleted automatically.
 */
export function logConversationTurn(
	provider: string,
	chatKey: string,
	rawBody: string,
	parsed: ParsedResponse,
): void {
	try {
		const retentionDays = rawLogRetentionDays();
		if (retentionDays === 0) return;
		maybePrune(retentionDays);
		const logDir = path.join(rawLogRoot(), provider);
		if (!fs.existsSync(logDir)) {
			fs.mkdirSync(logDir, { recursive: true });
		}
		const logFile = path.join(logDir, `${chatKey}.log`);
		const entry = { timestamp: new Date().toISOString(), raw: rawBody, parsed };
		fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
	} catch (err) {
		// Logging must never break the main flow.
		console.error(`[conversation-logger] failed to write log: ${err}`);
	}
}
