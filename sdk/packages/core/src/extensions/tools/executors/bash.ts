/**
 * Bash Executor
 *
 * Built-in implementation for running shell commands using Node.js spawn.
 */

import { spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
	type AgentToolContext,
	getDefaultShell,
	getShellArgs,
	getShellKind,
} from "@cline/shared";
import { TimeoutError } from "../helpers";
import type { ShellExecutor } from "../types";
import {
	MAX_COMMAND_OUTPUT_CHARS,
	truncateCommandOutput,
} from "./output-limits";

export class CommandExitError extends Error {
	constructor(
		readonly exitCode: number,
		readonly output: string,
	) {
		super(`Command exited with code ${exitCode}`);
		this.name = "CommandExitError";
	}
}

/**
 * Options for the shell executor
 */
export interface ShellExecutorOptions {
	/**
	 * Shell to use for execution
	 * @default "/bin/bash" on Unix, "powershell" on Windows
	 */
	shell?: string;

	/**
	 * Timeout for command execution in milliseconds
	 * @default 60000 (60 seconds)
	 */
	timeoutMs?: number;

	/**
	 * Maximum output kept, in characters. Output beyond this is
	 * middle-truncated: the head and tail are preserved and the middle is
	 * elided, since build and test failures usually live at the end of the
	 * output.
	 * @default 48_000 — see MAX_COMMAND_OUTPUT_CHARS in output-limits.ts
	 */
	maxOutputChars?: number;

	/**
	 * @deprecated Misnamed — the limit was always enforced in characters,
	 * not bytes. Use {@link maxOutputChars}; this alias is honored when
	 * maxOutputChars is not set.
	 */
	maxOutputBytes?: number;

	/**
	 * Environment variables to add/override
	 */
	env?: Record<string, string>;

	/**
	 * Whether to combine stdout and stderr
	 * @default true
	 */
	combineOutput?: boolean;
}

interface SpawnConfig {
	executable: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
}

/**
 * Collects stream output with bounded memory: the first half of the budget
 * is kept verbatim, the rest rolls so the latest output always survives.
 */
function createRollingCollector(maxChars: number) {
	const headLimit = Math.ceil(maxChars / 2);
	const tailLimit = Math.max(1, maxChars - headLimit);
	// StringDecoder keeps multibyte UTF-8 sequences split across stream
	// chunks intact instead of corrupting them at chunk boundaries.
	const decoder = new StringDecoder("utf8");
	let head = "";
	let tail = "";
	let totalChars = 0;

	const appendText = (text: string): void => {
		if (!text) return;
		totalChars += text.length;
		const headRoom = headLimit - head.length;
		if (headRoom > 0) {
			head += text.slice(0, headRoom);
			tail = (tail + text.slice(headRoom)).slice(-tailLimit);
			return;
		}
		tail = (tail + text).slice(-tailLimit);
	};

	return {
		append(data: Buffer): void {
			appendText(decoder.write(data));
		},
		snapshot() {
			// Flush bytes the decoder buffered for an incomplete multibyte
			// sequence at end-of-stream; otherwise the final characters of
			// non-ASCII output are silently dropped.
			appendText(decoder.end());
			return {
				text: head + tail,
				totalChars,
				dropped: totalChars > head.length + tail.length,
			};
		},
	};
}

function spawnAndCollect(
	config: SpawnConfig,
	context: AgentToolContext,
	timeoutMs: number,
	maxOutputChars: number,
	combineOutput: boolean,
): Promise<string> {
	if (context.signal?.aborted) {
		return Promise.reject(new Error("Command was aborted"));
	}
	return new Promise((resolve, reject) => {
		const isWindows = process.platform === "win32";

		const child = spawn(config.executable, config.args, {
			cwd: config.cwd,
			env: { ...process.env, ...config.env },
			stdio: ["pipe", "pipe", "pipe"],
			detached: !isWindows,
			// Prevent a console window from flashing on Windows when the
			// parent process has no console (or a different console).
			// No-op on non-Windows platforms.
			windowsHide: true,
		});
		const childPid = child.pid;

		const stdout = createRollingCollector(maxOutputChars);
		const stderr = createRollingCollector(maxOutputChars);
		let killed = false;
		let settled = false;

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			fn();
		};

		const killProcessTree = async (): Promise<void> => {
			if (!childPid) return;
			if (isWindows) {
				await new Promise<void>((done) => {
					let finished = false;
					let killer: ReturnType<typeof spawn>;
					const finish = () => {
						if (finished) return;
						finished = true;
						clearTimeout(watchdog);
						done();
					};
					try {
						killer = spawn(
							"taskkill.exe",
							["/PID", String(childPid), "/T", "/F"],
							{ stdio: "ignore", shell: false, windowsHide: true },
						);
					} catch {
						child.kill();
						done();
						return;
					}
					const watchdog = setTimeout(() => {
						killer.kill();
						child.kill();
						finish();
					}, 5_000);
					killer.once("error", () => {
						child.kill();
						finish();
					});
					killer.once("close", (code) => {
						if (code !== 0) child.kill();
						finish();
					});
				});
				return;
			}
			try {
				process.kill(-childPid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};

		let timeout: NodeJS.Timeout | undefined;
		const abortHandler = () => killAndReject(new Error("Command was aborted"));
		const cleanup = () => {
			clearTimeout(timeout);
			context.signal?.removeEventListener("abort", abortHandler);
		};
		const killAndReject = (error: Error) => {
			if (killed || settled) return;
			killed = true;
			cleanup();
			void killProcessTree().finally(() => settle(() => reject(error)));
		};

		// Infinity is a foreground run with no limit. setTimeout would clamp it
		// to ~1ms and kill the command at once, so set no timer at all.
		if (Number.isFinite(timeoutMs)) {
			timeout = setTimeout(
				() =>
					killAndReject(
						new TimeoutError(
							`Command timed out after ${timeoutMs}ms`,
							timeoutMs,
						),
					),
				timeoutMs,
			);
		}

		if (context.signal) {
			context.signal.addEventListener("abort", abortHandler, { once: true });
			if (context.signal.aborted) abortHandler();
		}

		child.stdout?.on("data", (data: Buffer) => {
			stdout.append(data);
		});

		child.stderr?.on("data", (data: Buffer) => {
			stderr.append(data);
		});

		child.on("close", (code) => {
			cleanup();
			if (killed) return;

			const out = stdout.snapshot();
			const err = stderr.snapshot();

			if (code !== 0) {
				const exitCode = code ?? 1;
				let failureOutput = combineOutput
					? out.text + (err.text ? `\n[stderr]\n${err.text}` : "")
					: out.text;
				const dropped = out.dropped || (combineOutput && err.dropped);
				const totalChars = combineOutput
					? out.totalChars + err.totalChars
					: out.totalChars;
				if (dropped || failureOutput.length > maxOutputChars) {
					failureOutput = truncateCommandOutput(failureOutput, {
						maxChars: maxOutputChars,
						totalChars,
					});
				}
				const result =
					failureOutput.length > 0
						? `[Command exited with code ${exitCode}]\n${failureOutput}`
						: `[Command exited with code ${exitCode}]`;
				settle(() => reject(new CommandExitError(exitCode, result)));
			} else {
				let output = combineOutput
					? out.text + (err.text ? `\n[stderr]\n${err.text}` : "")
					: out.text;
				const dropped = out.dropped || (combineOutput && err.dropped);
				if (dropped || output.length > maxOutputChars) {
					const totalChars = combineOutput
						? out.totalChars + err.totalChars
						: out.totalChars;
					output = truncateCommandOutput(output, {
						maxChars: maxOutputChars,
						totalChars,
					});
				}
				settle(() => resolve(output));
			}
		});

		child.on("error", (error) => {
			cleanup();
			if (killed) return;
			settle(() =>
				reject(new Error(`Failed to execute command: ${error.message}`)),
			);
		});
	});
}

/** Quote a value as a PowerShell single-quoted string literal. */
function psLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

/** Decode a file written by PowerShell 5.1 (UTF-16 LE) or 7 (UTF-8). */
function readShellOutputFile(path: string): string {
	if (!existsSync(path)) return "";
	const bytes = readFileSync(path);
	if (bytes[0] === 0xff && bytes[1] === 0xfe) {
		return bytes.subarray(2).toString("utf16le");
	}
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		return bytes.subarray(3).toString("utf8");
	}
	return bytes.toString("utf8");
}

/**
 * A foreground run the user chose on Windows: open the command in its own
 * console window so it can be watched live. Its output is also teed to a
 * file, which is returned when the command finishes. The window then stays
 * open until the user presses Enter.
 */
function runInVisibleWindow(
	command: string,
	shell: string,
	cwd: string,
	context: AgentToolContext,
	maxOutputChars: number,
): Promise<string> {
	if (context.signal?.aborted) {
		return Promise.reject(new Error("Command was aborted"));
	}
	const dir = mkdtempSync(join(tmpdir(), "cline-fg-"));
	const scriptPath = join(dir, "run.ps1");
	const outPath = join(dir, "out.txt");
	const donePath = join(dir, "done.txt");
	const title = command.split(/\r?\n/)[0]?.slice(0, 80) ?? "";
	const script = [
		"$ErrorActionPreference = 'Continue'",
		`try { $Host.UI.RawUI.WindowTitle = 'cline: ' + ${psLiteral(title)} } catch {}`,
		`Set-Location -LiteralPath ${psLiteral(cwd)}`,
		`Write-Host ('PS ' + (Get-Location).Path + '> ' + ${psLiteral(command)}) -ForegroundColor Cyan`,
		"$global:LASTEXITCODE = 0",
		"$__clineCode = 0",
		"try {",
		"& {",
		command,
		"} 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { $_ } } |",
		// Out-Host draws each result now. Left to implicit output, PowerShell
		// 5.1 holds tables back and the Read-Host below keeps them hidden.
		`  Tee-Object -FilePath ${psLiteral(outPath)} | Out-Host`,
		"if ($LASTEXITCODE) { $__clineCode = $LASTEXITCODE }",
		"} catch {",
		"$__clineCode = 1",
		"Write-Host $_ -ForegroundColor Red",
		`$_ | Out-String | Out-File -LiteralPath ${psLiteral(outPath)} -Append`,
		"}",
		`Set-Content -LiteralPath ${psLiteral(donePath)} -Value $__clineCode -Encoding ASCII`,
		"Write-Host ''",
		'Write-Host "[exit $__clineCode] Output sent to cline. Press Enter to close this window." -ForegroundColor Yellow',
		"[void](Read-Host)",
	].join("\r\n");
	// BOM so Windows PowerShell 5.1 reads non-ASCII commands as UTF-8.
	writeFileSync(scriptPath, `﻿${script}`, "utf8");

	return new Promise((resolve, reject) => {
		// `start` gives the command its own visible console even when cline's
		// hub runs without one. `/wait` keeps cmd alive until the window
		// closes, so its exit means the user closed the window.
		const child = spawn(
			"cmd.exe",
			[
				`/d /s /c "start "cline command" /wait "${shell}" -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}""`,
			],
			{
				cwd,
				stdio: "ignore",
				windowsHide: true,
				windowsVerbatimArguments: true,
			},
		);
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearInterval(poll);
			context.signal?.removeEventListener("abort", onAbort);
			child.unref();
			fn();
		};
		const collect = (): string => {
			const text = readShellOutputFile(outPath)
				.replaceAll("\r\n", "\n")
				.replace(/^\s*\n/, "")
				.trimEnd();
			return text.length > maxOutputChars
				? truncateCommandOutput(text, {
						maxChars: maxOutputChars,
						totalChars: text.length,
					})
				: text;
		};
		const cleanup = () => {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// The window may still hold a file; the OS temp dir is fine.
			}
		};
		const onAbort = () =>
			finish(() => {
				if (child.pid) {
					spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
						stdio: "ignore",
						windowsHide: true,
					}).once("error", () => child.kill());
				}
				cleanup();
				reject(new Error("Command was aborted"));
			});
		const poll = setInterval(() => {
			if (!existsSync(donePath)) return;
			finish(() => {
				const exitCode =
					Number.parseInt(readFileSync(donePath, "utf8").trim(), 10) || 0;
				const output = collect();
				cleanup();
				if (exitCode !== 0) {
					reject(
						new CommandExitError(
							exitCode,
							output
								? `[Command exited with code ${exitCode}]\n${output}`
								: `[Command exited with code ${exitCode}]`,
						),
					);
				} else {
					resolve(output);
				}
			});
		}, 300);
		child.on("exit", () => {
			// The done file may land just before the window closes.
			if (existsSync(donePath)) return;
			finish(() => {
				const output = collect();
				cleanup();
				const note = "[Command window was closed before the command finished]";
				reject(new CommandExitError(1, output ? `${note}\n${output}` : note));
			});
		});
		child.on("error", (error) =>
			finish(() => {
				cleanup();
				reject(new Error(`Failed to open command window: ${error.message}`));
			}),
		);
		context.signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * A per-call timeout set by `run_commands` (`timeout_seconds`). Read by key
 * rather than importing the constant, to keep this executor free of the tool
 * definitions module.
 */
function readCommandTimeoutOverride(
	context: AgentToolContext,
): number | undefined {
	if (context.metadata?.commandNoTimeout === true) {
		return Number.POSITIVE_INFINITY;
	}
	const value = context.metadata?.commandTimeoutMs;
	return typeof value === "number" && value > 0 ? value : undefined;
}

/**
 * Create a shell executor using Node.js spawn
 *
 * @example
 * ```typescript
 * const shell = createShellExecutor({
 *   timeoutMs: 60000, // 1 minute timeout
 *   shell: "/bin/zsh",
 * })
 *
 * const output = await shell("ls -la", "/path/to/project", context)
 * ```
 */
export function createShellExecutor(
	options: ShellExecutorOptions = {},
): ShellExecutor {
	const {
		shell = getDefaultShell(process.platform),
		timeoutMs = 120_000,
		env = {},
		combineOutput = true,
	} = options;
	const maxOutputChars =
		options.maxOutputChars ??
		options.maxOutputBytes ??
		MAX_COMMAND_OUTPUT_CHARS;

	return (command, cwd, context) => {
		if (
			process.platform === "win32" &&
			typeof command === "string" &&
			context.metadata?.commandNoTimeout === true &&
			getShellKind(shell) === "powershell"
		) {
			return runInVisibleWindow(command, shell, cwd, context, maxOutputChars);
		}
		const isStructured = typeof command !== "string";
		return spawnAndCollect(
			{
				executable: isStructured ? command.command : shell,
				args: isStructured
					? (command.args ?? [])
					: getShellArgs(shell, command),
				cwd,
				env,
			},
			context,
			readCommandTimeoutOverride(context) ?? timeoutMs,
			maxOutputChars,
			combineOutput,
		);
	};
}
