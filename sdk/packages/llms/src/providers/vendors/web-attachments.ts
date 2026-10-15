/**
 * Which web chat providers send long text as an attachment.
 *
 * A web chat is stateful: each turn types only the new message into the same
 * browser chat, so a large tool result does not get re-sent on every later
 * request the way it does with an API provider. Once the provider also pastes
 * long text as an attached file, the reasons for the tight tool-output caps
 * (quadratic re-send cost, a composer that chokes on huge typed text) are
 * gone, and the runtime can let file reads and command output through whole.
 */

import { resolveChatGPTWebV2Config } from "./chatgpt-web/config";
import { resolveDeepSeekWebV2Config } from "./deepseek-web-v2/config";

/** True when `providerId` is a web chat that will attach long text as a file. */
export function webChatAttachesLongText(providerId: string): boolean {
	try {
		if (providerId === "deepseek-web-v2") {
			return resolveDeepSeekWebV2Config().pasteAsFileChars > 0;
		}
		if (providerId === "chatgpt-web") {
			return resolveChatGPTWebV2Config().pasteAsFileChars > 0;
		}
	} catch {
		// An unreadable provider config means the default: no attachments.
	}
	return false;
}
