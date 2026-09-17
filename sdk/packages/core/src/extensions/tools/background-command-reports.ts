/**
 * Delivery for `run_commands` calls made with `echo`.
 *
 * An echo command runs in the background: the tool call returns at once so the
 * turn can finish, and the command's output arrives later as a new message in
 * the same session. A tool has no handle on its session, so the runtime host
 * registers a reporter here and the tool hands its result to whichever host
 * owns the session.
 */

export interface BackgroundCommandReporter {
	/** Whether this reporter can deliver a message into the session. */
	owns(sessionId: string): boolean;
	deliver(sessionId: string, message: string): void;
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

export function reportBackgroundCommand(
	sessionId: string,
	message: string,
): boolean {
	for (const reporter of reporters) {
		try {
			if (!reporter.owns(sessionId)) continue;
			reporter.deliver(sessionId, message);
			return true;
		} catch {
			// A failing reporter must not stop the others.
		}
	}
	return false;
}
