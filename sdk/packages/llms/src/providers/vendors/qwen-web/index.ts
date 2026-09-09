/**
 * Qwen Web ("qwen-web") provider.
 *
 * Drives the real Qwen web client (chat.qwen.ai) through your installed Chrome
 * via the DevTools Protocol — no API key needed.
 *
 * ## Where things are
 *
 * This was one 1,718-line file. Nothing about it was wrong; it was just hard to
 * work in. The split is by what you would go looking for:
 *
 * | file               | what lives there                                    |
 * | ------------------ | --------------------------------------------------- |
 * | `config.ts`        | settings, defaults, the shared types                 |
 * | `browser.ts`       | connect to Chrome, CDP client                        |
 * | `send-script.ts`   | the JavaScript injected into the page (a string)     |
 * | `chat-registry.ts` | which Qwen chat a conversation belongs to            |
 * | `sse.ts`           | reading Qwen's response stream                       |
 * | `navigation.ts`    | moving the page to the right chat                    |
 * | `capture.ts`       | send one message, capture the response body          |
 * | `model.ts`         | build the prompt, run a turn, parse the reply        |
 *
 * The import path is unchanged: `./vendors/qwen-web` resolves here, so nothing
 * outside this folder had to move.
 *
 * Anything genuinely shared with the other web vendors lives one level up in
 * `../tool-pipeline/` — the CDP socket, the browser lock, the tool parsers. If
 * you are about to add something here that another vendor also needs, it
 * belongs there instead.
 */

export {
	chatKeyFromPrompt,
	deleteQwenChatSession,
	extractQwenSessionId,
	listQwenWebChats,
	lookupQwenChatSession,
	openQwenWebChat,
	recordQwenChatSession,
} from "./chat-registry";

export type { QwenWebChatEntry, QwenWebV2RuntimeConfig } from "./config";
export { resolveQwenWebV2Config } from "./config";

export {
	createQwenWebProvider,
	createQwenWebProviderFactory,
	createQwenWebProviderModule,
} from "./model";
