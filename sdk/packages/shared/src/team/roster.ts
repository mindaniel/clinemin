/**
 * Declarative team rosters.
 *
 * A roster names the workers a team runs with and, for each one, which provider
 * and model it talks to. It exists because the alternative — asking the lead to
 * spawn every worker by hand at the start of each session — makes the shape of
 * the team a property of one conversation. That is fragile in exactly the case
 * teams are for: a long job, resumed across sessions, where "worker B is on
 * DeepSeek and worker C is on Qwen" has to survive a restart.
 *
 * Parsing is deliberately strict. A typo in `providerId` that silently falls
 * back to the lead's provider would be invisible until the bill or the output
 * looked wrong, so an unknown key or a missing field fails loudly at load.
 */

import { z } from "zod";

export const TEAM_ROSTER_FILENAME = "team.json";

export const TeamRosterWorkerSchema = z
	.object({
		agentId: z
			.string()
			.min(1)
			.regex(
				/^[a-zA-Z0-9._-]+$/,
				"agentId may only contain letters, digits, dot, underscore and hyphen",
			)
			.describe("Identifier the lead addresses this worker by"),
		tools: z
			.array(z.string().min(1))
			.optional()
			.describe(
				"Tool names this worker may use. Omit to give it every tool the session has.",
			),
		rolePrompt: z
			.string()
			.min(1)
			.describe("System prompt describing what this worker is for"),
		providerId: z
			.string()
			.min(1)
			.optional()
			.describe("Provider for this worker. Omit to inherit the lead's."),
		modelId: z
			.string()
			.min(1)
			.optional()
			.describe("Model for this worker. Omit to inherit the lead's."),
		maxIterations: z.number().int().positive().optional(),
	})
	.strict();

export const TeamRosterSchema = z
	.object({
		version: z.literal(1),
		teamName: z.string().min(1).optional(),
		workers: z.array(TeamRosterWorkerSchema),
	})
	.strict()
	.superRefine((roster, ctx) => {
		const seen = new Set<string>();
		for (const [index, worker] of roster.workers.entries()) {
			if (seen.has(worker.agentId)) {
				ctx.addIssue({
					code: "custom",
					path: ["workers", index, "agentId"],
					message: `Duplicate agentId "${worker.agentId}"`,
				});
			}
			seen.add(worker.agentId);
		}
	});

export type TeamRosterWorker = z.infer<typeof TeamRosterWorkerSchema>;
export type TeamRoster = z.infer<typeof TeamRosterSchema>;

export type ParseTeamRosterResult =
	| { ok: true; roster: TeamRoster }
	| { ok: false; error: string };

/**
 * Parse roster JSON text.
 *
 * Returns a result rather than throwing: a bad roster should surface to the
 * user as a message about their config file, not as a runtime crash that
 * takes the whole session with it.
 */
export function parseTeamRoster(text: string): ParseTeamRosterResult {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			error: `${TEAM_ROSTER_FILENAME} is not valid JSON: ${message}`,
		};
	}

	const parsed = TeamRosterSchema.safeParse(raw);
	if (!parsed.success) {
		return { ok: false, error: z.prettifyError(parsed.error) };
	}
	return { ok: true, roster: parsed.data };
}
