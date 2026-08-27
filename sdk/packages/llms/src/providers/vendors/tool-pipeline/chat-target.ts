/**
 * Chat routing override for the browser-driven web providers.
 *
 * These providers normally pick which web chat to send to by hashing the
 * conversation's first user message (`chatKeyFromPrompt`): same first message,
 * same key, same chat. That works for ordinary turns, where the prompt really
 * is the ongoing conversation.
 *
 * Compaction is the exception. It sends a standalone "summarize what we've
 * discussed" request, whose text hashes to a key of its own — so the provider
 * would open a fresh, empty chat and the model would answer that it has no
 * history to summarize, which is the opposite of what compaction needs. Trying
 * to make the hash line up (by prepending the original first message) is
 * fragile: any drift between the stored message and the one actually sent
 * silently misroutes the request.
 *
 * So instead of matching by hash, compaction says explicitly: send the next
 * request to whatever chat the last real turn used.
 *
 * ## The whole /compact hand-off, end to end
 *
 * Three stages, each in a different package. All three must work or the
 * summary is silently lost — which is what made this fiddly to debug.
 *
 *  1. ASK THE OLD CHAT (core -> llms)
 *     `runStatefulWebChatCompaction` (core/extensions/context/agentic-compaction.ts)
 *     calls `generateSummary({ reuseActiveChat: true })`, which arms
 *     `useLastChatForNextCall()` here. The provider then sends the summarize
 *     request into the chat that holds the real history instead of deriving a
 *     chat from the request's own text. Without this the request opens an empty
 *     chat and the model answers "there's nothing to summarize".
 *
 *  2. KEEP THE SUMMARY (cli)
 *     The summary comes back as a `compaction_summary` message ("Context
 *     summary: ..."), stored in a `SessionCompactionState` and applied by
 *     restarting the session. The restart MUST pass the full canonical
 *     transcript: `projectSessionCompactionState` refuses to project unless at
 *     least `source_message_count` source messages are present, and a failed
 *     projection drops the summary without an error. See the restart call in
 *     apps/cli/src/runtime/interactive/session-runtime.ts.
 *
 *  3. SEED THE NEW CHAT (llms)
 *     The summary is now the conversation's first user message, so the chat key
 *     changes and the next turn opens a fresh web chat. `buildPrompt` is called
 *     with `preserveCompactionContext = isNewChat`, which keeps that leading
 *     summary in the prompt (`buildLeanConversation` drops it on later turns,
 *     since by then the web chat holds it server-side).
 *
 * Auto-compaction runs the same three stages; it just triggers on a token
 * threshold rather than on the `/compact` command.
 *
 * ## Adding another web provider
 *
 * Wire the provider into stages 1 and 3 (stage 2 is provider-agnostic):
 *
 *   - Add its id to `isStatefulWebChatProvider`
 *     (core/extensions/context/compaction-shared.ts) so compaction takes this
 *     path at all rather than the generic transcript-replay one.
 *   - In its completion function, replace the bare `chatKeyFromPrompt(...)`
 *     with the override-aware pair, passing its own provider id:
 *
 *         const routedChatKey = consumeChatKeyOverride("<provider-id>");
 *         const chatKey = routedChatKey ?? chatKeyFromPrompt(options.prompt);
 *         if (!routedChatKey) recordActiveChatKey("<provider-id>", chatKey);
 *
 *   - Make sure its prompt builder keeps the leading `Context summary:` message
 *     when it is opening a fresh chat (deepseek-web-v2's
 *     `buildLeanConversation` is the reference implementation; qwen-web reuses
 *     it directly).
 *
 * Keys are tracked per provider id, so two web providers used in one session
 * never route into each other's chats.
 *
 * ## Sticky `/findchat` bindings
 *
 * The hash works as long as the CLI conversation and the web chat were created
 * together. Resuming an old CLI session from `/history` and wanting it to talk
 * to a specific existing web chat is the case it cannot express — so `/findchat`
 * pins the pair explicitly: `bindChatKey(providerId, chatKey)` makes every
 * subsequent turn of this CLI session go to that chat, hash ignored.
 *
 * The binding is one-to-one. Binding a web chat that another CLI session
 * already claimed takes it over; the CLI side (apps/cli/src/utils/chat-binding.ts)
 * drops the loser's record so two sessions never write into one chat.
 *
 * Compaction deliberately moves the conversation into a FRESH web chat, so a
 * binding must not survive it — the CLI clears it as part of the compaction
 * restart. Re-run `/findchat` afterwards to pin the new session to a chat.
 */

import { processGlobal } from "./process-global";

// Process-wide so every copy of `@cline/llms` in the process shares one view of
// which chat is active; see `process-global.ts`.
const state = () =>
	processGlobal("chatTarget", () => ({
		/** chatKey of the most recent ordinary turn, per provider id. */
		lastActiveChatKeys: new Map<string, string>(),
		/** Set when the next call must reuse the last chat instead of hashing. */
		reuseLastChat: false,
		/** Sticky `/findchat` binding, per provider id. */
		boundChatKeys: new Map<string, string>(),
	}));

/** Record the chat an ordinary turn just used. */
export function recordActiveChatKey(providerId: string, chatKey: string): void {
	state().lastActiveChatKeys.set(providerId, chatKey);
}

/**
 * Route the next web-provider request into the chat the last ordinary turn
 * used, instead of deriving a chat from the request's own text.
 */
export function useLastChatForNextCall(): void {
	state().reuseLastChat = true;
}

/**
 * Resolve the chat key for a call. Returns the last active chat when the
 * override is armed (consuming it), otherwise `undefined` so the caller falls
 * back to hashing the prompt as usual.
 */
export function consumeChatKeyOverride(providerId: string): string | undefined {
	const slot = state();
	if (!slot.reuseLastChat) {
		return undefined;
	}
	slot.reuseLastChat = false;
	return slot.lastActiveChatKeys.get(providerId);
}

/** Drop a pending override (e.g. compaction bailed before sending). */
export function clearChatKeyOverride(): void {
	state().reuseLastChat = false;
}

/**
 * Pin this CLI session's turns to one web chat, ignoring the prompt hash (see
 * "Sticky `/findchat` bindings" above). Replaces any existing binding for the
 * provider.
 */
export function bindChatKey(providerId: string, chatKey: string): void {
	state().boundChatKeys.set(providerId, chatKey);
}

/** Drop the sticky binding, returning the provider to hash-derived routing. */
export function clearChatKeyBinding(providerId: string): void {
	state().boundChatKeys.delete(providerId);
}

/** The provider's sticky binding, if `/findchat` set one. */
export function getBoundChatKey(providerId: string): string | undefined {
	return state().boundChatKeys.get(providerId);
}

/**
 * The single entry point a provider uses to decide which web chat a call goes
 * to. Precedence, highest first:
 *
 *  1. The one-shot compaction override (`useLastChatForNextCall`), which must
 *     win so a summarize request reaches the chat holding the real history.
 *  2. A sticky `/findchat` binding for this CLI session.
 *  3. `deriveFromPrompt()` — the usual hash of the conversation's first user
 *     message.
 *
 * Also records the resolved key as the provider's last active chat, EXCEPT when
 * it came from the one-shot override: a compaction request is not an ordinary
 * turn, and letting it overwrite the last-active key would leave the next
 * compaction pointing at itself.
 */
export function resolveChatKey(
	providerId: string,
	deriveFromPrompt: () => string,
): string {
	const routed = consumeChatKeyOverride(providerId);
	if (routed) {
		return routed;
	}
	const chatKey = getBoundChatKey(providerId) ?? deriveFromPrompt();
	recordActiveChatKey(providerId, chatKey);
	return chatKey;
}
