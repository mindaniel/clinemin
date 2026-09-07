/**
 * Code fences that are commands, not files.
 *
 * Every web provider is told (see `simple-system-prompt.ts`) to send shell
 * commands and get their output pasted back, and every one of them answers with
 * a fence rather than the `<tool>` contract at least some of the time. The
 * shared fallback in `parseFallbackToolUses` reads a fence as an `editor` call —
 * "create this file" — which is right for a code fence and catastrophically
 * wrong for a command one: `Get-ChildItem -Recurse` gets written to disk as a
 * file, the command never runs, and the model is told the write succeeded.
 *
 * This ran for a while as a private pre-filter inside `claude-web.ts`, which
 * meant Claude was the only provider that did not write commands to files.
 * Kimi, ChatGPT, Gemini, Qwen, Grok and DeepSeek all shared the bug. It lives
 * here so a vendor gets the behaviour by using the shared fallback rather than
 * by remembering to copy a helper.
 *
 * The language tag is required and a bare ``` fence is never treated as a
 * command: an unlabelled fence is how a model quotes output or shows an
 * example, and running those would be a disaster. The list mirrors
 * `SHELL_FENCE_OPEN_RE` in `manager-block.ts`, which does the same job one
 * layer up for a manager's `<manager>` blocks.
 */
export const SHELL_FENCE_LANGUAGES = new Set([
	"powershell",
	"pwsh",
	"ps1",
	"bash",
	"shell",
	"sh",
	"zsh",
	"cmd",
	"bat",
	"console",
	"terminal",
]);

export function isShellFenceLanguage(lang: string | undefined): boolean {
	return SHELL_FENCE_LANGUAGES.has((lang ?? "").toLowerCase().trim());
}

/**
 * Pull shell fences out of a reply and turn each into a `run_commands` call.
 *
 * Returns the text with those fences removed, so a caller can hand the rest to
 * a fence-to-file parser without it seeing the commands. When the session has
 * no `run_commands` tool the text comes back untouched: a shell fence we cannot
 * run has to stay visible, because silently deleting it would leave the model
 * believing it asked for something.
 */
export function extractShellFenceCommands(
	text: string,
	availableToolNames: string[],
): {
	remainingText: string;
	toolUses: { name: string; arguments: Record<string, unknown> }[];
} {
	if (!availableToolNames.includes("run_commands")) {
		return { remainingText: text, toolUses: [] };
	}

	const toolUses: { name: string; arguments: Record<string, unknown> }[] = [];
	const remainingText = text.replace(
		/```([\w+-]*)[ \t]*\r?\n([\s\S]*?)```/g,
		(full: string, lang: string, code: string) => {
			if (!isShellFenceLanguage(lang)) {
				return full;
			}
			const command = code.replace(/\s+$/, "");
			if (!command.trim()) {
				return full;
			}
			toolUses.push({
				name: "run_commands",
				arguments: { commands: [command] },
			});
			return "";
		},
	);

	return { remainingText, toolUses };
}
