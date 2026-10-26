import { spawn, spawnSync } from "node:child_process";

/**
 * Open a cline subcommand in a new terminal, beside the one cline runs in.
 *
 * Used for `cline watch`: a worker's live activity belongs in a window of its
 * own, not in the manager's chat. On Windows this is a new Windows Terminal
 * tab (falling back to a console window); elsewhere there is no one obvious
 * terminal to drive, so the caller gets the command to run by hand.
 */

/** This same cline, as a command line: runtime, its flags, the entry script. */
export function clineCommandLine(args: string[]): string[] {
	return [
		process.execPath,
		...process.execArgv,
		...(process.argv[1] ? [process.argv[1]] : []),
		...args,
	];
}

export function formatCommandLine(parts: string[]): string {
	return parts.map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ");
}

let windowsTerminalAvailable: boolean | undefined;

function hasWindowsTerminal(): boolean {
	if (windowsTerminalAvailable === undefined) {
		const probe = spawnSync("where", ["wt"], { stdio: "ignore" });
		windowsTerminalAvailable = probe.status === 0;
	}
	return windowsTerminalAvailable;
}

export type OpenTerminalResult =
	| { ok: true }
	| { ok: false; error: string; command: string };

export function openInNewTerminal(
	title: string,
	args: string[],
): OpenTerminalResult {
	const [command, ...rest] = clineCommandLine(args);
	const commandLine = formatCommandLine(clineCommandLine(args));
	if (!command) {
		return {
			ok: false,
			error: "cannot tell how cline was started",
			command: "",
		};
	}
	if (process.platform !== "win32") {
		return {
			ok: false,
			error: "opening a terminal is only automatic on Windows",
			command: commandLine,
		};
	}
	try {
		const child = hasWindowsTerminal()
			? // `-w 0`: a tab in the current Windows Terminal window.
				spawn(
					"wt",
					[
						"-w",
						"0",
						"nt",
						"--title",
						title,
						"-d",
						process.cwd(),
						command,
						...rest,
					],
					{ detached: true, stdio: "ignore" },
				)
			: spawn("cmd.exe", ["/c", "start", title, command, ...rest], {
					cwd: process.cwd(),
					detached: true,
					stdio: "ignore",
				});
		child.on("error", () => undefined);
		child.unref();
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
			command: commandLine,
		};
	}
}
