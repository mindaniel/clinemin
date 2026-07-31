import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Runs as the root "postinstall" script so `bun install` leaves "cline" and
// "clinemin" commands usable from any directory, not just this repo — this
// fork is git-clone-from-source (not published), so there's no package
// manager doing this step for us.
const MARKER = "# cline-cli-alias (auto-added by bun install, safe to remove)";
const COMMAND_NAMES = ["cline", "clinemin"];

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const entryPath = path.join(repoRoot, "apps", "cli", "src", "index.ts");

function alreadyInstalled(filePath: string): boolean {
	try {
		return fs.readFileSync(filePath, "utf-8").includes(MARKER);
	} catch {
		return false;
	}
}

function appendBlock(filePath: string, block: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const prefix = fs.existsSync(filePath) && fs.statSync(filePath).size > 0 ? "\n" : "";
	fs.appendFileSync(filePath, `${prefix}${block}\n`);
}

/** Asks PowerShell itself for $PROFILE — "Documents" is frequently redirected
 *  (OneDrive Known Folder Move, roaming profiles, etc), so guessing the path
 *  by joining os.homedir() + "Documents" silently writes to a file PowerShell
 *  never loads. */
function resolvePowerShellProfilePath(): string {
	try {
		const out = execFileSync(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", "[Console]::Out.Write($PROFILE)"],
			{ encoding: "utf-8" },
		).trim();
		if (out) return out;
	} catch {}
	// Fallback if powershell.exe couldn't be spawned (shouldn't normally happen on win32).
	return path.join(os.homedir(), "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");
}

function setupPowerShell(): string | undefined {
	const profilePath = resolvePowerShellProfilePath();
	if (alreadyInstalled(profilePath)) return undefined;
	const block = [
		MARKER,
		...COMMAND_NAMES.map((name) =>
			[`function ${name} {`, `    bun --conditions=development "${entryPath}" -i @args`, "}"].join("\n"),
		),
	].join("\n");
	appendBlock(profilePath, block);
	return profilePath;
}

function setupPosixRc(): string | undefined {
	const shell = process.env.SHELL ?? "";
	const rcName = shell.includes("zsh") ? ".zshrc" : ".bashrc";
	const rcPath = path.join(os.homedir(), rcName);
	if (alreadyInstalled(rcPath)) return undefined;
	const block = [
		MARKER,
		...COMMAND_NAMES.map(
			(name) => `${name}() { bun --conditions=development "${entryPath}" -i "$@"; }`,
		),
	].join("\n");
	appendBlock(rcPath, block);
	return rcPath;
}

try {
	if (!fs.existsSync(entryPath)) {
		// Shouldn't happen mid-install, but never block install over this.
		process.exit(0);
	}
	const updated = process.platform === "win32" ? setupPowerShell() : setupPosixRc();
	if (updated) {
		console.log(`\nAdded "cline" / "clinemin" shell commands to ${updated}`);
		console.log(
			'Open a new terminal (or reload your profile) and run "cline" (or "clinemin") from any project folder.\n',
		);
	}
} catch (error) {
	// Best-effort — never fail `bun install` over a shell profile edit (e.g. a
	// locked-down PowerShell execution policy, or a read-only profile path).
	console.warn(`Could not set up the "cline" shell alias automatically: ${String(error)}`);
	console.warn(`Run it manually instead: bun --conditions=development "${entryPath}" -i`);
}
