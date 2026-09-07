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

/**
 * Append a single turn's raw and parsed response to a per‑conversation log file.
 * Logs are stored under ~/.cline/rawjsonhistory/<provider>/<chatKey>.log.
 * The file is JSON lines – each line is one turn.
 */
export function logConversationTurn(
	provider: string,
	chatKey: string,
	rawBody: string,
	parsed: ParsedResponse,
): void {
	try {
		const logDir = path.join(
			os.homedir(),
			".cline",
			"rawjsonhistory",
			provider,
		);
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
