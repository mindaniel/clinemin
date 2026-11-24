import { webChatAttachesLongText } from "@cline/llms";
import {
	DEFAULT_TOOL_OUTPUT_LIMITS,
	LOCAL_MODEL_TOOL_OUTPUT_LIMITS,
	type ToolOutputLimits,
	WEB_ATTACH_TOOL_OUTPUT_LIMITS,
} from "../../extensions/tools/executors/output-limits";

const LOCAL_MODEL_PROVIDER = /^(?:llamacpp(?:-.+)?|ollama|lmstudio)$/;

/**
 * Tool-output caps for a session on `providerId`: whole results for a model on
 * this machine, wide for a web chat that attaches long text as a file, the
 * defaults for everything else.
 */
export function resolveToolOutputLimits(providerId: string): ToolOutputLimits {
	if (LOCAL_MODEL_PROVIDER.test(providerId)) {
		return LOCAL_MODEL_TOOL_OUTPUT_LIMITS;
	}
	return webChatAttachesLongText(providerId)
		? WEB_ATTACH_TOOL_OUTPUT_LIMITS
		: DEFAULT_TOOL_OUTPUT_LIMITS;
}
