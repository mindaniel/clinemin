/**
 * The "keep going" note appended after every round of tool execution.
 *
 * After the agent runtime executes a round of tool calls it pushes a synthetic
 * user message so the model has something to answer and doesn't just stop (see
 * `continuationMessage` in agents/src/agent-runtime.ts). That note is never
 * something the user typed, so:
 *
 *   - the web providers must not echo it back labeled "Previous user message"
 *     (it would read as a stale instruction to re-answer), and
 *   - the prompt trimmers must recognise it so they don't mistake it for the
 *     real current instruction and drop the turn's actual context.
 *
 * Both of those need to know its exact text, which is why the text lives here
 * rather than in the runtime: `@cline/agents` depends on `@cline/llms`, so this
 * module is the one place both sides can reach.
 *
 * The note is per project — a repo full of Terraform wants different marching
 * orders than a TypeScript app — so the CLI loads the project's note at startup
 * and `/note` rewrites it live. `DEFAULT_CONTINUATION_NOTE` is what you get
 * when a project has set nothing.
 *
 * ## Why recognition accepts the default too
 *
 * A session can be resumed after the note was changed, so a transcript may hold
 * notes written under an older setting. `isContinuationNoteText` therefore
 * matches the active note OR the built-in default, so old transcripts keep
 * being trimmed correctly instead of silently degrading.
 */

import { processGlobal } from "./process-global";

/** Note used when a project has not customised one. */
export const DEFAULT_CONTINUATION_NOTE =
	"Use tool to continue the task or if finish, then tell 'finish'.";

// Process-wide, not module-level: the CLI sets this from a different copy of
// `@cline/llms` than the agent runtime reads it from. See `process-global.ts`.
const state = () =>
	processGlobal("continuationNote", () => ({
		active: DEFAULT_CONTINUATION_NOTE,
	}));

/** The note the runtime appends after each round of tool execution. */
export function getContinuationNote(): string {
	return state().active;
}

/**
 * Set the active note. Empty/undefined restores the default, so callers can
 * pass a project's stored value straight through without pre-checking it.
 */
export function setContinuationNote(note: string | undefined): void {
	const trimmed = note?.trim();
	state().active = trimmed ? trimmed : DEFAULT_CONTINUATION_NOTE;
}

/** Restore the built-in default. */
export function resetContinuationNote(): void {
	state().active = DEFAULT_CONTINUATION_NOTE;
}

/**
 * Carrier text for the turn `/paste` starts.
 *
 * `/paste` queues a reply the user copied out of the browser and then needs a
 * turn for the provider to consume it in. The hub rejects an empty prompt, so
 * the turn carries this text — but the model never answers it (the queued reply
 * short-circuits the request), and it is not something the user typed. It lives
 * here beside the continuation note because both are synthetic user messages
 * the web providers must keep out of `Previous user message:`; without that, the
 * next turn of the tool loop sends "Continue with the reply provided above." to
 * the chat in place of the user's real instruction.
 *
 * The CLI `/paste` command imports this constant, so the two never drift.
 */
export const PASTE_CARRIER_PROMPT = "Continue with the reply provided above.";

/**
 * True for a user message the runtime wrote rather than the user: the
 * continuation note or the `/paste` carrier. Prompt builders use this to find
 * the last thing the user actually typed.
 */
export function isSyntheticUserText(text: string): boolean {
	const trimmed = text.trim();
	return isContinuationNoteText(trimmed) || trimmed === PASTE_CARRIER_PROMPT;
}

/**
 * True for text that is the runtime's synthetic continuation note — either the
 * currently active one or the built-in default (see the note on resumed
 * sessions above).
 */
export function isContinuationNoteText(text: string): boolean {
	const trimmed = text.trim();
	return trimmed === state().active || trimmed === DEFAULT_CONTINUATION_NOTE;
}
