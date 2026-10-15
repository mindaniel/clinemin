import { webChatAttachesLongText } from "@cline/llms";
import {
	DEFAULT_TOOL_OUTPUT_LIMITS,
	type ToolOutputLimits,
	WEB_ATTACH_TOOL_OUTPUT_LIMITS,
} from "../../extensions/tools/executors/output-limits";

/**
 * Tool-output caps for a session on `providerId`: wide for a web chat that
 * attaches long text as a file, the defaults for everything else.
 */
export function resolveToolOutputLimits(providerId: string): ToolOutputLimits {
	return webChatAttachesLongText(providerId)
		? WEB_ATTACH_TOOL_OUTPUT_LIMITS
		: DEFAULT_TOOL_OUTPUT_LIMITS;
}
