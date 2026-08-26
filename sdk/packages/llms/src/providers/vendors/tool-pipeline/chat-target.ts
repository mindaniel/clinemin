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
 */

/** chatKey of the most recent ordinary turn, per provider module. */
const lastActiveChatKeys = new Map<string, string>();

/** Set when the next call must reuse the last active chat instead of hashing. */
let reuseLastChat = false;

/** Record the chat an ordinary turn just used. */
export function recordActiveChatKey(providerId: string, chatKey: string): void {
	lastActiveChatKeys.set(providerId, chatKey);
}

/**
 * Route the next web-provider request into the chat the last ordinary turn
 * used, instead of deriving a chat from the request's own text.
 */
export function useLastChatForNextCall(): void {
	reuseLastChat = true;
}

/**
 * Resolve the chat key for a call. Returns the last active chat when the
 * override is armed (consuming it), otherwise `undefined` so the caller falls
 * back to hashing the prompt as usual.
 */
export function consumeChatKeyOverride(providerId: string): string | undefined {
	if (!reuseLastChat) {
		return undefined;
	}
	reuseLastChat = false;
	return lastActiveChatKeys.get(providerId);
}

/** Drop a pending override (e.g. compaction bailed before sending). */
export function clearChatKeyOverride(): void {
	reuseLastChat = false;
}
