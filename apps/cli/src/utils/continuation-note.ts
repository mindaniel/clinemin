import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_CONTINUATION_NOTE } from "@cline/llms";

/**
 * Per-project storage for the post-tool continuation note.
 *
 * The agent runtime appends a short "keep going" note after every round of tool
 * execution so the model has something to answer instead of stalling. The
 * default is generic, but what a project actually wants there varies — so the
 * note is stored per project and applied at startup.
 *
 * Notes live in `<cline dir>/notes.json`, keyed by the project's absolute path,
 * rather than in a file inside the project itself: nothing is added to the
 * user's repo and nothing needs to be gitignored.
 *
 *     { "C:\\Users\\me\\code\\app": "Keep going. Run the tests before finishing." }
 *
 * The active note itself lives in `@cline/llms`
 * (`tool-pipeline/continuation-note.ts`) because both the runtime that emits it
 * and the web providers that must recognise it need to reach the same value.
 */

interface NotesFile {
	[projectPath: string]: string;
}

function clineDir(): string {
	// Same resolution the rest of the CLI uses (see commands/config.ts).
	return process.env.CLINE_DIR?.trim() || join(homedir(), ".cline");
}

function notesFilePath(): string {
	return join(clineDir(), "notes.json");
}

/** Absolute, normalised key for a project directory. */
function projectKey(cwd: string): string {
	return resolve(cwd);
}

function readNotesFile(): NotesFile {
	const file = notesFilePath();
	if (!existsSync(file)) {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}
		const notes: NotesFile = {};
		for (const [key, value] of Object.entries(parsed as object)) {
			if (typeof value === "string") {
				notes[key] = value;
			}
		}
		return notes;
	} catch {
		// A corrupt notes file must not stop the CLI from starting; the project
		// simply falls back to the default note.
		return {};
	}
}

function writeNotesFile(notes: NotesFile): void {
	const file = notesFilePath();
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(notes, null, "\t")}\n`, "utf8");
}

/** The project's stored note, or undefined when it has never set one. */
export function readProjectContinuationNote(cwd: string): string | undefined {
	const stored = readNotesFile()[projectKey(cwd)];
	const trimmed = stored?.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * Store the project's note. Passing undefined (or blank) removes the entry, so
 * the project falls back to `DEFAULT_CONTINUATION_NOTE`.
 */
export function writeProjectContinuationNote(
	cwd: string,
	note: string | undefined,
): void {
	const notes = readNotesFile();
	const key = projectKey(cwd);
	const trimmed = note?.trim();
	if (trimmed) {
		notes[key] = trimmed;
	} else {
		delete notes[key];
	}
	writeNotesFile(notes);
}

export { DEFAULT_CONTINUATION_NOTE };
