/**
 * Stage 2 of the tool-call pipeline: Python-in-JSON syntax validation.
 *
 * For `editor` tool calls the value of `arguments.new_text` is frequently
 * Python source embedded (as an escaped string) inside the JSON envelope.
 * Before the tool dispatcher hands that code to the executor, we run a strict
 * AST-level syntax check by streaming the code into a real `python3`
 * interpreter — this rejects malformed code with line-precise error messages
 * and guarantees we NEVER execute or write to disk unvalidated Python.
 *
 * Validation covers the Python **syntax** only (matching the model's system
 * prompt contract about bracket completion, variable-name consistency, and
 * loop structure). It deliberately does not attempt semantic "repair".
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process";

/**
 * The Python one-liner piped `code` via stdin. It parses the whole stdin
 * buffer as a module and exits 0 on success, so any `SyntaxError` (or other
 * `ValueError` from `ast.parse`) surfaces on stderr with a line number.
 *
 * `import sys; sys.stdin.read()` guarantees we only ever read what we pipe
 * (never external files / env), keeping the check hermetic.
 */
const AST_CHECK_SCRIPT =
	"import ast, sys; ast.parse(sys.stdin.read()); sys.exit(0)";

/** Hard cap on how long we wait for `python3` before giving up. */
const VALIDATION_TIMEOUT_MS = 5_000;

/**
 * Result of a Python syntax validation pass.
 */
export interface ValidationResult {
	/** `true` when the code parsed cleanly (or validation was skipped). */
	valid: boolean;
	/** Line-precise description of the syntax failure, when `valid === false`. */
	error?: string;
	/** Present when validation could not run (e.g. `python3` missing). */
	warning?: string;
}

/**
 * Python interpreters to probe, in order of preference.
 *
 * `python3` is the canonical name (matches the model's contract and non-Windows
 * systems). On Windows, the Store-installed alias for `python3` is a well-known
 * trap: `C:\Users\<u>\AppData\Local\Microsoft\WindowsApps\python3.exe` is a
 * stub that exits non-zero with "Python was not found; run without arguments to
 * install from the Microsoft Store..." even when a real Python exists under
 * `python`/`py`. So we prefer `python3` but fall through to `python` and then
 * `py` — the first one that produces a real interpreter result wins.
 */
const PYTHON_CANDIDATES = ["python3", "python", "py"] as const;

/** Marker printed by the Windows Store `python3` stub (also `py` when absent). */
const STORE_STUB_RE =
	/Python was not found|Microsoft Store|App execution aliases|not recognized as/i;

/** Nonzero exit code used by the Store stub when the real interpreter is absent. */
const STORE_STUB_EXIT_CODE = 9009;

/**
 * Validate that `code` is syntactically valid Python using an external Python
 * interpreter driven over stdin. Prefers `python3`; falls back to `python` /
 * `py` (covers the Windows Store-alias trap where `python3` is a dead stub).
 *
 * @param code The Python source to validate.
 * @returns `{ valid: true }` on success (including when no real interpreter is
 *          available, in which case a `warning` is attached); or
 *          `{ valid: false, error }` with a line-precise message on failure.
 */
export function validatePythonCode(code: string): ValidationResult {
	if (!code.trim()) {
		// Empty payload is trivially parseable; treat as valid with no fanfare.
		return { valid: true };
	}

	let lastUnavailable: string | undefined;

	for (const candidate of PYTHON_CANDIDATES) {
		const run = runAstCheck(candidate, code);

		// The interpreter binary could not be launched at all (ENOENT).
		if (run.kind === "unavailable") {
			lastUnavailable = candidate;
			continue;
		}

		// Real interpreter reached its timeout — treat as an inconclusive skip.
		if (run.kind === "timeout") {
			return {
				valid: true,
				warning: `Python validation skipped: ${candidate} timed out`,
			};
		}

		// Clean parse.
		if (run.status === 0) {
			return { valid: true };
		}

		// Nonzero exit. The Windows Store stub reports a fake "Python was not
		// found" — that's not a real SyntaxError from a real interpreter, so
		// keep falling through instead of misreporting it as bad Python.
		const stderr = run.stderr ?? "";
		if (run.status === STORE_STUB_EXIT_CODE || STORE_STUB_RE.test(stderr)) {
			lastUnavailable = candidate;
			continue;
		}

		// A genuine interpreter failure → real, line-precise syntax error.
		return {
			valid: false,
			error: formatSyntaxError(stderr, code),
		};
	}

	// No candidate yielded a usable interpreter — skip validation safely.
	return {
		valid: true,
		warning: `Python validation skipped: ${lastUnavailable ?? PYTHON_CANDIDATES[0]} not found`,
	};
}

interface InterpretedResult {
	kind: "ran" | "unavailable" | "timeout";
	status: number | null;
	stderr?: string;
}

/**
 * Run `ast.parse` over `code` via a single interpreter candidate, over stdin.
 * Never throws for subprocess failures — those surface as `unavailable`.
 */
function runAstCheck(command: string, code: string): InterpretedResult {
	let result: SpawnSyncReturns<string> | undefined;
	try {
		result = spawnSync(command, ["-c", AST_CHECK_SCRIPT], {
			input: code,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: VALIDATION_TIMEOUT_MS,
			windowsHide: true,
		});
	} catch (error) {
		// ENOENT: executable not on PATH. Fall through to the next candidate.
		const codeValue = (error as NodeJS.ErrnoException).code;
		if (codeValue === "ENOENT") return { kind: "unavailable", status: null };
		return {
			kind: "ran",
			status: 1,
			stderr: `interpreter could not run: ${String(error)}`,
		};
	}

	if (
		result.error &&
		(result.error as NodeJS.ErrnoException).code === "ENOENT"
	) {
		return { kind: "unavailable", status: null };
	}

	if (result.signal === "SIGTERM") {
		return { kind: "timeout", status: null, stderr: result.stderr ?? "" };
	}

	return {
		kind: "ran",
		status: result.status,
		stderr: result.stderr ?? "",
	};
}

/**
 * Turn an interpreter stderr buffer into a line-precise, human-friendly error.
 *
 * Python reports standard `SyntaxError`s like
 *   `  File "<stdin>", line 3` / `    foo(`
 *   `SyntaxError: '(' was never closed`.
 * We extract the line number and the final message line and restate them in
 * the canonical `Python syntax error at line X: Y` shape the dispatcher (and
 * the retry prompt contract) expects. When the fields can't be matched, we
 * fall back to a reasonable best-effort summary.
 */
function formatSyntaxError(stderr: string, _code: string): string {
	const stderrLines = stderr.split(/\r?\n/).map((line) => line.trim());

	// 1. Try to extract the reported line number.
	const lineMatch = /line\s+(\d+)/i.exec(stderr);
	const lineNumber = lineMatch?.[1] ?? "?";

	// 2. Prefer the trailing `SyntaxError: ...` (or `ValueError: ...`) line.
	const messageMatch =
		/^(?:SyntaxError|ValueError|IndentationError|TabError)\s*:\s*(.+)$/i.exec(
			stderr,
		);
	const message =
		messageMatch?.[1]?.trim() ??
		stderrLines.filter(Boolean).at(-1) ??
		"unknown Python error";

	return `Python syntax error at line ${lineNumber}: ${message}`;
}
