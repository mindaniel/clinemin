/**
 * Copilot Web ("copilot-web") provider.
 *
 * Drives the real Copilot web client (copilot.com/chat) through your installed Chrome
 * via the DevTools Protocol — no API key needed.
 *
 * ## Where things are
 *
 * Built from grok-web's layout; the send and capture are Copilot's own
 * (see capture.ts). The split is by what you would go looking for:
 *
 * | file               | what lives there                                    |
 * | ------------------ | --------------------------------------------------- |
 * | `config.ts`        | settings, defaults, the shared types                 |
 * | `browser.ts`       | connect to Chrome, CDP client                        |
 * | `chat-registry.ts` | which Copilot chat a conversation belongs to            |
 * | `navigation.ts`    | moving the page to the right chat                    |
 * | `capture.ts`       | send one message, capture the response body          |
 * | `model.ts`         | build the prompt, run a turn, parse the reply        |
 *
 * The import path is unchanged: `./vendors/copilot-web` resolves here, so nothing
 * outside this folder had to move.
 *
 * Anything genuinely shared with the other web vendors lives one level up in
 * `../tool-pipeline/` — the CDP socket, the browser lock, the tool parsers. If
 * you are about to add something here that another vendor also needs, it
 * belongs there instead.
 */

export {
	chatKeyFromPrompt,
	deleteCopilotChatSession,
	extractCopilotSessionId,
	getCopilotRateLimitInfo,
	listCopilotWebChats,
	lookupCopilotChatSession,
	openCopilotWebChat,
	recordCopilotChatSession,
} from "./chat-registry";

export type {
	CopilotRateLimitInfo,
	CopilotWebChatEntry,
	CopilotWebV2RuntimeConfig,
} from "./config";
export { resolveCopilotWebV2Config } from "./config";

export {
	createCopilotWebProvider,
	createCopilotWebProviderFactory,
	createCopilotWebProviderModule,
} from "./model";
