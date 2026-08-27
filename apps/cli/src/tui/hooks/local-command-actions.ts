import type { LocalSlashCommandInvocation } from "../utils/skill-command-input";
import type { OpenConfigOptions } from "./use-config-panel";

export interface LocalSlashCommandActionInput {
	name: string;
	isRunning: boolean;
	openAccount: () => void;
	openConfig: (options?: OpenConfigOptions) => void;
	openMcpManager: () => Promise<boolean>;
	openModelSelector: () => void;
	openSkills: (invocation?: LocalSlashCommandInvocation) => void;
	invocation?: LocalSlashCommandInvocation;
	runCompact: () => void;
	runAutocompact: (tokens: number | undefined) => Promise<boolean>;
	runFork: () => void;
	runUndo: () => Promise<void>;
	clearConversation: () => Promise<void>;
	openHelp: () => void;
	openHistory: () => void;
	exitCline: () => void;
	/**
	 * Provider chat recall: list & reopen a web-provider chat (e.g. DeepSeek
	 * Web v2). Provider-specific; no-ops / returns false for non-web providers.
	 */
	findChat: () => Promise<boolean>;
	/**
	 * Manual reply recovery for web providers: queue the clipboard as the
	 * model's reply for the next turn. No-ops for non-web providers.
	 */
	pasteReply: () => Promise<boolean>;
	/**
	 * Show or set this project's post-tool continuation note. `arg` is the raw
	 * text after `/note`: empty shows the current note, "reset"/"default"
	 * restores the built-in one, anything else becomes the new note.
	 */
	setNote: (arg: string) => boolean;
}

/**
 * Everything after the command word, verbatim. Unlike `/autocompact` the note
 * is free text, so it is neither split nor lower-cased — only the leading
 * command token is removed.
 */
function commandArgument(text: string | undefined): string {
	if (!text) return "";
	const trimmed = text.trim();
	const firstSpace = trimmed.search(/\s/);
	return firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
}

/**
 * Parses the argument of `/autocompact <tokens>`. Supports plain counts and
 * `k`/`M` suffixes (e.g. "1000000", "1M", "1000k"). Returns undefined when no
 * usable count is present.
 */
function parseAutoCompactTokens(text: string | undefined): number | undefined {
	if (!text) return undefined;
	// invocation.text is the full submitted input (e.g. "/autocompact 1M").
	const parts = text.trim().split(/\s+/);
	const raw = parts[1];
	if (!raw) return undefined;
	const match = /^(\d+(?:\.\d+)?)([kKmM])?$/.exec(raw.trim());
	if (!match) return undefined;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value <= 0) return undefined;
	const suffix = (match[2] ?? "").toLowerCase();
	const multiplier = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : 1;
	const tokens = Math.round(value * multiplier);
	return tokens > 0 ? tokens : undefined;
}

export function runLocalSlashCommandAction(
	input: LocalSlashCommandActionInput,
): boolean | Promise<boolean> {
	const normalized = input.name;
	if (normalized === "config" || normalized === "settings") {
		input.openConfig();
		return true;
	}
	if (normalized === "plugins") {
		input.openConfig({ initialTab: "plugins" });
		return true;
	}
	if (normalized === "skills") {
		input.openSkills(input.invocation);
		return true;
	}
	if (normalized === "mcp") {
		return input.openMcpManager().then(() => true);
	}
	if (normalized === "account") {
		input.openAccount();
		return true;
	}
	if (normalized === "model") {
		input.openModelSelector();
		return true;
	}
	if (normalized === "compact") {
		// Autocomplete can invoke local commands while a turn is running. Keep
		// /compact handled, but do not let it take ownership of the active turn's
		// shared running state.
		if (!input.isRunning) {
			input.runCompact();
		}
		return true;
	}
	if (normalized === "autocompact") {
		const tokens = parseAutoCompactTokens(input.invocation?.text);
		return input.runAutocompact(tokens);
	}
	if (normalized === "fork") {
		input.runFork();
		return true;
	}
	if (normalized === "undo") {
		return input.runUndo().then(() => true);
	}
	if (normalized === "clear") {
		return input.clearConversation().then(() => true);
	}
	if (normalized === "help") {
		input.openHelp();
		return true;
	}
	if (normalized === "history") {
		input.openHistory();
		return true;
	}
	if (normalized === "findchat") {
		return input.findChat();
	}
	if (normalized === "paste") {
		return input.pasteReply();
	}
	if (normalized === "note") {
		return input.setNote(commandArgument(input.invocation?.text));
	}
	if (normalized === "quit") {
		setTimeout(input.exitCline, 0);
		return true;
	}
	return false;
}
