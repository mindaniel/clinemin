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

/** Note used when a project has not customised one. */
export const DEFAULT_CONTINUATION_NOTE =
	"Use tool to continue the task or if finish, then tell 'finish'.";

let activeContinuationNote = DEFAULT_CONTINUATION_NOTE;

/** The note the runtime appends after each round of tool execution. */
export function getContinuationNote(): string {
	return activeContinuationNote;
}

/**
 * Set the active note. Empty/undefined restores the default, so callers can
 * pass a project's stored value straight through without pre-checking it.
 */
export function setContinuationNote(note: string | undefined): void {
	const trimmed = note?.trim();
	activeContinuationNote = trimmed ? trimmed : DEFAULT_CONTINUATION_NOTE;
}

/** Restore the built-in default. */
export function resetContinuationNote(): void {
	activeContinuationNote = DEFAULT_CONTINUATION_NOTE;
}

/**
 * True for text that is the runtime's synthetic continuation note — either the
 * currently active one or the built-in default (see the note on resumed
 * sessions above).
 */
export function isContinuationNoteText(text: string): boolean {
	const trimmed = text.trim();
	return (
		trimmed === activeContinuationNote || trimmed === DEFAULT_CONTINUATION_NOTE
	);
}
