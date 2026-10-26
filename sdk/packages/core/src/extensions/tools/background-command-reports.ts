/**
 * Delivery for `run_commands` calls made with `echo`.
 *
 * An echo command runs in the background: the tool call returns at once so the
 * turn can finish, and the command's output arrives later as a new message in
 * the same session. A tool has no handle on its session, so the runtime host
 * registers a reporter here and the tool hands its result to whichever host
 * owns the session.
 */

export interface BackgroundReportOptions {
	/**
	 * Wait for a turn of its own: delivered only when the session is idle and
	 * nothing else is queued, one report per turn, so several arriving at once
	 * are answered one after another instead of racing to start a turn.
	 */
	queue?: boolean;
}

export interface BackgroundCommandReporter {
	/** Whether this reporter can deliver a message into the session. */
	owns(sessionId: string): boolean;
	deliver(
		sessionId: string,
		message: string,
		options?: BackgroundReportOptions,
	): void;
	/**
	 * Whether a message delivered after the current turn would be acted on.
	 * An unattended run ends with its turn, so a reply arriving later has no
	 * one to read it. Omitted means yes.
	 */
	takesLaterTurns?(sessionId: string): boolean;
}

const reporters = new Set<BackgroundCommandReporter>();

export function registerBackgroundCommandReporter(
	reporter: BackgroundCommandReporter,
): () => void {
	reporters.add(reporter);
	return () => {
		reporters.delete(reporter);
	};
}

/**
 * True when a finished echo command in this session has somewhere to go. A
 * session no host owns (a teammate's inner run, a bare SDK agent) runs the
 * command in the foreground instead of losing its output.
 */
export function canReportBackgroundCommand(sessionId: string): boolean {
	for (const reporter of reporters) {
		if (reporter.owns(sessionId)) return true;
	}
	return false;
}

/**
 * True when a message delivered after this turn ends would start a new turn
 * that someone sees — what a delegation needs before it lets the lead stop
 * waiting for the reply.
 */
export function canReportBackgroundCommandLater(sessionId: string): boolean {
	for (const reporter of reporters) {
		if (reporter.owns(sessionId)) {
			return reporter.takesLaterTurns?.(sessionId) ?? true;
		}
	}
	return false;
}

export function reportBackgroundCommand(
	sessionId: string,
	message: string,
	options?: BackgroundReportOptions,
): boolean {
	for (const reporter of reporters) {
		try {
			if (!reporter.owns(sessionId)) continue;
			reporter.deliver(sessionId, message, options);
			return true;
		} catch {
			// A failing reporter must not stop the others.
		}
	}
	return false;
}
