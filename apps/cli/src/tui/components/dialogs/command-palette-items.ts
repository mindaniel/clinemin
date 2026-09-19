export type CommandPaletteAction =
	| "settings"
	| "change-model"
	| "change-provider"
	| "account"
	| "mcp"
	| "plugins"
	| "compact"
	| "skills"
	| "fork"
	| "undo"
	| "clear"
	| "history"
	| "autocompact"
	| "manager"
	| "workers"
	| "profiles"
	| "findchat"
	| "paste"
	| "note"
	| "profile"
	| "telegram"
	| "help"
	| "quit";

export interface CommandPaletteResult {
	kind: "action";
	action: CommandPaletteAction;
}

export interface CommandPaletteItem {
	id: string;
	label: string;
	description: string;
	shortcut: string;
	keywords: string[];
	result: CommandPaletteResult;
}

const ACTION_ITEMS: Array<{
	action: CommandPaletteAction;
	label: string;
	shortcut: string;
	description: string;
	keywords: string[];
	requiresFork?: boolean;
}> = [
	{
		action: "settings",
		label: "Open Settings",
		shortcut: "Opt+S",
		description: "Review and edit CLI configuration",
		keywords: ["config", "preferences", "general", "tools"],
	},
	{
		action: "change-model",
		label: "Change Model",
		shortcut: "Opt+M",
		description: "Pick a different model for future requests",
		keywords: ["model", "provider", "llm", "reasoning", "thinking"],
	},
	{
		action: "change-provider",
		label: "Change Provider",
		shortcut: "Opt+P",
		description: "Switch provider and configure credentials",
		keywords: ["provider", "api key", "account", "auth"],
	},
	{
		action: "mcp",
		label: "Manage MCP Servers",
		shortcut: "Opt+C",
		description: "Enable, disable, or inspect MCP servers",
		keywords: ["mcp", "server", "tool", "toggle"],
	},
	{
		action: "plugins",
		label: "Manage Plugins",
		shortcut: "Opt+G",
		description: "Open plugin settings",
		keywords: ["plugins", "extensions", "settings"],
	},
	{
		action: "account",
		label: "Open Account",
		shortcut: "Opt+A",
		description: "View or switch your Cline account",
		keywords: ["account", "login", "auth", "cline"],
	},
	{
		action: "compact",
		label: "Compact Context",
		shortcut: "Opt+X",
		description: "Compact context",
		keywords: ["compact", "context", "compress"],
	},
	{
		action: "skills",
		label: "Browse Skills",
		shortcut: "Opt+W",
		description: "Insert an installed skill or workflow command",
		keywords: ["skills", "workflows", "marketplace"],
	},
	{
		action: "fork",
		label: "Create Session Fork",
		shortcut: "Opt+R",
		description: "Branch the current conversation into a new session",
		keywords: ["fork", "session", "branch"],
		requiresFork: true,
	},
	{
		action: "undo",
		label: "Restore Checkpoint",
		shortcut: "Opt+U",
		description: "Return to an earlier checkpoint",
		keywords: ["undo", "checkpoint", "restore"],
	},
	{
		action: "clear",
		label: "Start New Session",
		shortcut: "Opt+L",
		description: "Clear the conversation and restart the session",
		keywords: ["clear", "new", "reset"],
	},
	{
		action: "history",
		label: "Session History",
		shortcut: "Opt+H",
		description: "Resume a previous session",
		keywords: ["history", "resume", "sessions"],
	},
	{
		action: "autocompact",
		label: "Auto-Compaction Limit",
		shortcut: "Opt+Z",
		description: "Show how to set the auto-compaction context limit",
		keywords: ["autocompact", "compact", "context", "limit", "tokens"],
	},
	{
		action: "manager",
		label: "Start Manager Mode",
		shortcut: "Opt+J",
		description: "Pick a manager model and delegate work to workers",
		keywords: ["manager", "delegate", "team", "orchestrate"],
	},
	{
		action: "workers",
		label: "Manage Workers",
		shortcut: "Opt+O",
		description: "Set up the workers a manager can delegate to",
		keywords: ["workers", "team", "delegate", "manager"],
	},
	{
		action: "profiles",
		label: "Manage Profiles",
		// Not Opt+F, which terminals use for forward-word navigation and which
		// `command-palette.test.ts` keeps deliberately unbound. Opt+B is the
		// backward-word twin, so of what is left this is the readable one.
		shortcut: "Opt+D",
		description:
			"Named connections, so two workers can share a provider on separate accounts",
		keywords: [
			"profiles",
			"profile",
			"account",
			"credentials",
			"connection",
			"provider",
			"worker",
		],
	},
	{
		action: "findchat",
		label: "Find Web Chat",
		shortcut: "Opt+I",
		description: "Find and reopen a web provider chat",
		keywords: ["findchat", "find", "chat", "web", "reopen"],
	},
	{
		action: "paste",
		label: "Paste Model Reply",
		shortcut: "Opt+V",
		description: "Preview the clipboard, then use it as the model reply",
		keywords: ["paste", "clipboard", "reply", "recovery", "web"],
	},
	{
		action: "note",
		label: "Continuation Note",
		shortcut: "Opt+N",
		description: "Show or set this project's post-tool continuation note",
		keywords: ["note", "continuation", "project"],
	},
	{
		action: "profile",
		label: "Switch Browser Profile",
		shortcut: "Opt+E",
		description: "Switch the browser profile web providers log in with",
		keywords: ["profile", "browser", "login", "sign out", "web"],
	},
	{
		action: "telegram",
		label: "Configure Telegram",
		shortcut: "Opt+T",
		description: "Set the Telegram connector token, chat ID, and on/off",
		keywords: ["telegram", "connector", "bot", "chat id"],
	},
	{
		action: "help",
		label: "Open Help",
		shortcut: "Opt+K",
		description: "Show CLI shortcuts and commands",
		keywords: ["help", "shortcuts", "commands"],
	},
	{
		action: "quit",
		label: "Exit Cline",
		shortcut: "Opt+Q",
		description: "Close the interactive CLI",
		keywords: ["quit", "exit"],
	},
];

function normalize(value: string): string {
	return value
		.toLowerCase()
		.replace(/[+-]/g, " ")
		.replace(/[^a-z0-9/ ]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function includesAllTokens(haystack: string, tokens: string[]): boolean {
	return tokens.every((token) => haystack.includes(token));
}

function scoreItem(item: CommandPaletteItem, query: string): number {
	const normalizedQuery = normalize(query.trim());
	if (!normalizedQuery) return 1;

	const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
	const label = normalize(item.label);
	const description = normalize(item.description);
	const keywordText = normalize(item.keywords.join(" "));
	const shortcut = normalize(item.shortcut);
	const searchText = `${label} ${description} ${keywordText} ${shortcut}`;

	if (!includesAllTokens(searchText, tokens)) return 0;
	if (label === normalizedQuery) return 120;
	if (label.startsWith(normalizedQuery)) return 100;
	if (label.includes(normalizedQuery)) return 75;
	if (shortcut.includes(normalizedQuery)) return 70;
	if (keywordText.includes(normalizedQuery)) return 60;
	if (description.includes(normalizedQuery)) return 45;
	return 20;
}

export function buildCommandPaletteItems(input: {
	canForkSession: boolean;
}): CommandPaletteItem[] {
	return ACTION_ITEMS.filter(
		(item) => !item.requiresFork || input.canForkSession,
	).map((item) => ({
		id: `action:${item.action}`,
		label: item.label,
		description: item.description,
		shortcut: item.shortcut,
		keywords: item.keywords,
		result: { kind: "action" as const, action: item.action },
	}));
}

export function filterCommandPaletteItems(
	items: CommandPaletteItem[],
	query: string,
): CommandPaletteItem[] {
	return items
		.map((item, index) => ({
			item,
			index,
			score: scoreItem(item, query),
		}))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			return a.index - b.index;
		})
		.map((entry) => entry.item);
}

export function findCommandPaletteShortcut(
	items: readonly CommandPaletteItem[],
	key: { name: string; meta: boolean; option?: boolean; shift: boolean },
): CommandPaletteItem | undefined {
	if (!key.meta && key.option !== true) return undefined;
	const keyName = key.name.toLowerCase();
	return items.find((item) => {
		const [, shortcutKey] = item.shortcut.toLowerCase().split("+");
		if (!shortcutKey) return false;
		return shortcutKey === keyName;
	});
}
