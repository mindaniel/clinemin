import { type ChildProcess, spawn } from "node:child_process";

/**
 * `/awake` — keep the computer from sleeping while Cline runs.
 *
 * The OS tool that holds the wake lock runs as a child process and watches
 * this process's PID, so the lock is released even when Cline is killed
 * without running its exit handlers. Turning it off kills the child.
 */

let holder: ChildProcess | undefined;
let exitHookInstalled = false;

function windowsScript(pid: number): string {
	// ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED. The state is
	// held by this thread, so the loop keeps the thread alive and re-asserts
	// it; it ends as soon as the Cline process is gone.
	return [
		"$sig = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
		"$k = Add-Type -MemberDefinition $sig -Name KeepAwake -Namespace Cline -PassThru",
		`while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) {`,
		"  [void]$k::SetThreadExecutionState([uint32]'0x80000003')",
		"  Start-Sleep -Seconds 30",
		"}",
	].join("\n");
}

function spawnHolder(): ChildProcess {
	const pid = process.pid;
	if (process.platform === "win32") {
		return spawn(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				windowsScript(pid),
			],
			{ stdio: "ignore", windowsHide: true },
		);
	}
	if (process.platform === "darwin") {
		return spawn("caffeinate", ["-dimsu", "-w", String(pid)], {
			stdio: "ignore",
		});
	}
	return spawn(
		"systemd-inhibit",
		[
			"--what=idle:sleep",
			"--who=cline",
			"--why=cline /awake",
			"tail",
			`--pid=${pid}`,
			"-f",
			"/dev/null",
		],
		{ stdio: "ignore" },
	);
}

export function isKeepAwakeOn(): boolean {
	return holder !== undefined;
}

/**
 * Starts the wake lock. Resolves with an error message when the helper could
 * not be started (e.g. `systemd-inhibit` missing), otherwise undefined.
 */
export async function startKeepAwake(): Promise<string | undefined> {
	if (holder) return undefined;
	const child = spawnHolder();
	const failure = await new Promise<string | undefined>((resolve) => {
		child.once("error", (error) => resolve(error.message));
		child.once("spawn", () => resolve(undefined));
	});
	if (failure) return failure;
	holder = child;
	child.once("exit", () => {
		if (holder === child) holder = undefined;
	});
	if (!exitHookInstalled) {
		exitHookInstalled = true;
		process.once("exit", stopKeepAwake);
	}
	return undefined;
}

export function stopKeepAwake(): void {
	const child = holder;
	holder = undefined;
	if (child && child.exitCode === null) {
		child.kill();
	}
}
