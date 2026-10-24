import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "@cline/shared";
import { ensureHookLogDir } from "@cline/shared/storage";
import type { TeamEvent } from "../../extensions/tools/team";

/**
 * A plain-text timeline of one manager session, for debugging manager/worker
 * runs: which workers started on which provider and model, what the manager
 * asked, every tool call and result on both sides, what each one said back,
 * and every error.
 *
 * The same run is otherwise spread over session folders and SQLite. This file
 * is written as things happen, so a run that hangs or crashes still leaves
 * its trail, and it reads top to bottom.
 *
 * One file per root session: `<data dir>/logs/team/<sessionId>.log`.
 * `CLINE_TEAM_LOG=off` turns it off.
 */

const TEXT_LIMIT = 4000;
const TOOL_INPUT_LIMIT = 2000;
const TOOL_OUTPUT_LIMIT = 3000;

function enabled(): boolean {
	return process.env.CLINE_TEAM_LOG?.trim().toLowerCase() !== "off";
}

export function teamDebugLogPath(rootSessionId: string): string {
	return join(ensureHookLogDir(), "team", `${rootSessionId}.log`);
}

function clip(text: string, limit: number): string {
	return text.length > limit
		? `${text.slice(0, limit)}… [${text.length - limit} more chars]`
		: text;
}

function show(value: unknown, limit: number): string {
	if (value === undefined) return "";
	if (typeof value === "string") return clip(value, limit);
	try {
		return clip(JSON.stringify(value), limit);
	} catch {
		return clip(String(value), limit);
	}
}

/** Continuation lines are indented so each entry still starts at column 0. */
function indent(text: string): string {
	return text.replace(/\n/g, "\n    ");
}

function write(rootSessionId: string, line: string): void {
	if (!enabled()) return;
	try {
		const path = teamDebugLogPath(rootSessionId);
		mkdirSync(join(path, ".."), { recursive: true });
		appendFileSync(
			path,
			`${new Date().toISOString()} ${indent(line)}\n`,
			"utf8",
		);
	} catch {
		// A debug log must never break the run it is recording.
	}
}

/** One agent event (a worker's or the manager's) as a log line, or undefined to skip it. */
export function formatAgentEvent(
	agentId: string,
	event: AgentEvent,
): string | undefined {
	switch (event.type) {
		case "content_start":
			return event.contentType === "tool"
				? `${agentId} TOOL ${event.toolName ?? "?"} ${show(event.input, TOOL_INPUT_LIMIT)}`
				: undefined;
		case "content_end":
			if (event.contentType === "tool") {
				const took =
					event.durationMs === undefined ? "" : ` (${event.durationMs}ms)`;
				return event.error
					? `${agentId} TOOL FAILED ${event.toolName ?? "?"}${took}: ${clip(event.error, TOOL_OUTPUT_LIMIT)}`
					: `${agentId} RESULT ${event.toolName ?? "?"}${took}:\n${show(event.output, TOOL_OUTPUT_LIMIT)}`;
			}
			if (event.contentType === "text" && event.text?.trim()) {
				return `${agentId} SAYS:\n${clip(event.text.trim(), TEXT_LIMIT)}`;
			}
			return undefined;
		case "notice":
			return `${agentId} NOTICE (${event.reason ?? event.noticeType}): ${event.message}`;
		case "error":
			return `${agentId} ERROR${event.recoverable ? " (recoverable)" : ""} at iteration ${event.iteration}: ${event.error?.message ?? String(event.error)}`;
		case "done":
			return `${agentId} STOPPED: ${event.reason} after ${event.iterations} iteration(s)`;
		default:
			return undefined;
	}
}

export function formatTeamEvent(event: TeamEvent): string | undefined {
	switch (event.type) {
		case "teammate_spawned": {
			const t = event.teammate;
			return `SPAWN ${event.agentId} provider=${t.providerId ?? "(lead's)"} model=${t.modelId ?? "(default)"} tools=${t.tools ? `[${t.tools.join(", ")}]` : "all"}`;
		}
		case "teammate_shutdown":
			return `SHUTDOWN ${event.agentId}${event.reason ? `: ${event.reason}` : ""}`;
		case "task_start":
			return `TASK -> ${event.agentId}:\n${clip(event.message, TEXT_LIMIT)}`;
		case "task_end":
			return event.error
				? `TASK FAILED ${event.agentId}: ${event.error.message}`
				: `TASK DONE ${event.agentId}:\n${clip(event.result?.text?.trim() ?? "", TEXT_LIMIT)}`;
		case "agent_event":
			return formatAgentEvent(event.agentId, event.event);
		case "team_message": {
			const m = event.message;
			return `MESSAGE ${m.fromAgentId} -> ${m.toAgentId}${m.subject ? ` [${m.subject}]` : ""}:\n${clip(m.body, TEXT_LIMIT)}`;
		}
		case "run_failed":
			return `RUN FAILED ${event.run.agentId}: ${event.run.error ?? ""}`;
		case "run_cancelled":
		case "run_interrupted":
			return `RUN ${event.type === "run_cancelled" ? "CANCELLED" : "INTERRUPTED"} ${event.run.agentId}${event.reason ? `: ${event.reason}` : ""}`;
		default:
			return undefined;
	}
}

export function logTeamEvent(rootSessionId: string, event: TeamEvent): void {
	const line = formatTeamEvent(event);
	if (line) write(rootSessionId, line);
}

/** The manager's own events, logged under the name "manager". */
export function logLeadEvent(rootSessionId: string, event: AgentEvent): void {
	const line = formatAgentEvent("manager", event);
	if (line) write(rootSessionId, line);
}
