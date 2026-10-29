/**
 * `team_handover`: a manager out of room passes the job to another manager.
 *
 * A manager usually runs on a web chat with a much smaller context and a usage
 * limit, so a long job outlives it. The roster's `managers` list names who can
 * take over. The manager writes a `<handover>` block (see
 * `tool-pipeline/manager-block.ts`), which becomes this call; the host starts
 * a fresh manager session on that manager's provider, on the same team, with
 * the handover as its first message, and this manager's run ends.
 *
 * Starting the session is the host's job (it owns session creation), so the
 * tool only validates the target and hands the rest to `startSuccessor`.
 */

import {
	type AgentTool,
	createTool,
	MANAGER_HANDOVER_TOOL,
	validateWithZod,
	zodToJsonSchema,
} from "@cline/shared";
import { z } from "zod";
import { listHandoverManagers } from "./team-roster-config";

const HandoverInputSchema = z.object({
	to: z.string().min(1).describe("Name of the manager taking over"),
	summary: z
		.string()
		.min(1)
		.describe(
			"Everything the next manager needs: goal, what is done and verified, what is left, who holds what",
		),
});

type HandoverInput = z.infer<typeof HandoverInputSchema>;

export interface HandoverTarget {
	agentId: string;
	profile?: string;
	providerId?: string;
	modelId?: string;
}

export interface CreateHandoverToolOptions {
	workspaceRoot?: string;
	/** This manager's own roster name, when a handover started it. */
	self?: string;
	/** Start the successor session; resolves to its session id. */
	startSuccessor: (target: HandoverTarget, summary: string) => Promise<string>;
}

/**
 * The handover tool, or undefined when the roster names no other manager —
 * a tool with nobody to hand to would only invite a call that must fail.
 */
export function createHandoverTool(
	options: CreateHandoverToolOptions,
): AgentTool | undefined {
	const initial = listHandoverManagers(options);
	if (initial.length === 0) {
		return undefined;
	}
	return createTool<HandoverInput, { endsTurn: true; message: string }>({
		name: MANAGER_HANDOVER_TOOL,
		description:
			"Hand the whole job to another manager when your context is nearly full. " +
			"Starts that manager with your summary as its first message; your part ends.",
		inputSchema: zodToJsonSchema(HandoverInputSchema),
		execute: async (input) => {
			const { to, summary } = validateWithZod(HandoverInputSchema, input);
			// Read the roster again: it may have been edited since the session
			// started, and a stale list would start the wrong account.
			const managers = listHandoverManagers(options);
			const target = managers.find((manager) => manager.agentId === to);
			if (!target) {
				throw new Error(
					`There is no manager called "${to}". Managers you can hand over to: ${
						managers.map((manager) => manager.agentId).join(", ") || "(none)"
					}.`,
				);
			}
			const sessionId = await options.startSuccessor(target, summary);
			// `endsTurn`: nothing is left for this manager to do, and calling the
			// model again would only have it start work its successor now owns.
			return {
				endsTurn: true,
				message: `Handed over to ${to} (session ${sessionId}). Your part is done; send nothing more.`,
			};
		},
	}) as AgentTool;
}
