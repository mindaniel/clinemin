/**
 * Finite or infinite shell-command timeout, toggled with the TUI's Tab key.
 *
 * Finite (the default): every run_commands call is stopped after its timeout
 * (120s unless the call asks for more). Infinite: no call is stopped, so a
 * long build or job runs to the end and the model gets its real output
 * instead of a timeout it then polls around. Esc still aborts the turn.
 *
 * Kept in a state file because commands run in the hub process while the
 * toggle lives in the TUI (see `process-file.ts`); the tool reads it on every
 * call, so a switch applies to the next command.
 */

import { clineStateFile, readStateFile, writeStateFile } from "./process-file";

const PREFERENCE_FILE = "command-timeout.json";

interface PreferenceState {
	infinite?: unknown;
}

/** Whether shell commands currently run with no time limit. */
export function readInfiniteCommandTimeout(): boolean {
	const state = readStateFile<PreferenceState>(clineStateFile(PREFERENCE_FILE));
	return state?.infinite === true;
}

export function writeInfiniteCommandTimeout(infinite: boolean): void {
	writeStateFile(clineStateFile(PREFERENCE_FILE), { infinite });
}
