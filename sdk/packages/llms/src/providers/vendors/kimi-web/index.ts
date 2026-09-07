/**
 * Kimi Web ("kimi-web") provider.
 *
 * Drives the real Kimi web client (www.kimi.ai) through your installed Chrome
 * via the DevTools Protocol — no API key needed.
 *
 * ## Where things are
 *
 * This was one 1,915-line file. Nothing about it was wrong; it was just hard to
 * work in — finding the SSE parser meant scrolling past the send script, and a
 * search for "timeout" hit four unrelated concerns. The split is by what you
 * would go looking for:
 *
 * | file               | what lives there                                    |
 * | ------------------ | --------------------------------------------------- |
 * | `config.ts`        | settings, defaults, the shared types                 |
 * | `browser.ts`       | connect to Chrome, wait for the composer             |
 * | `send-script.ts`   | the JavaScript injected into the page (a string)     |
 * | `chat-registry.ts` | which Kimi chat a conversation belongs to            |
 * | `sse.ts`           | reading Kimi's response stream                       |
 * | `navigation.ts`    | moving the page to the right chat                    |
 * | `capture.ts`       | send one message, capture the response body          |
 * | `model.ts`         | build the prompt, run a turn, parse the reply        |
 *
 * The import path is unchanged: `./vendors/kimi-web` resolves here, so nothing
 * outside this folder had to move.
 *
 * Anything genuinely shared with the other web vendors lives one level up in
 * `../tool-pipeline/` — the CDP socket, the browser lock, the tool parsers. If
 * you are about to add something here that another vendor also needs, it
 * belongs there instead.
 */

export {
	chatKeyFromPrompt,
	deleteKimiChatSession,
	extractKimiSessionId,
	listKimiWebChats,
	lookupKimiChatSession,
	openKimiWebChat,
	recordKimiChatSession,
} from "./chat-registry";
export type { KimiWebChatEntry, KimiWebV2RuntimeConfig } from "./config";
export { resolveKimiWebV2Config } from "./config";
export {
	createKimiWebProvider,
	createKimiWebProviderFactory,
	createKimiWebProviderModule,
} from "./model";
export { consumeKimiSse } from "./sse";
