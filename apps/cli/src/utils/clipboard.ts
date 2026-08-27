import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Read the system clipboard as text.
 *
 * Used by `/paste`, where the text the user wants is already on the clipboard
 * (they just copied it out of the browser) — asking them to re-paste it into a
 * TUI textarea would only mangle long multi-line replies.
 *
 * Returns an empty string when the platform helper is missing or the clipboard
 * holds no text; callers report that as "nothing to paste" rather than failing.
 */
export async function readClipboardText(): Promise<string> {
	const [command, args] =
		process.platform === "win32"
			? ([
					"powershell.exe",
					["-NoProfile", "-Command", "Get-Clipboard -Raw"],
				] as const)
			: process.platform === "darwin"
				? (["pbpaste", [] as string[]] as const)
				: (["xclip", ["-selection", "clipboard", "-o"]] as const);

	try {
		const { stdout } = await execFileAsync(command, [...args], {
			maxBuffer: 32 * 1024 * 1024,
			windowsHide: true,
		});
		return stdout.replace(/\r\n/g, "\n").trim();
	} catch {
		return "";
	}
}
