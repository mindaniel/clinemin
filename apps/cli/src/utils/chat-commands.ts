import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveWorkspaceRoot } from "./helpers";

export type ChatCommandState = {
	enableTools: boolean;
	autoApproveTools: boolean;
	cwd: string;
	workspaceRoot: string;
	toolsLocked?: boolean;
	threadMuted?: boolean;
};

export type ForkSessionResult = {
	forkedFromSessionId: string;
	newSessionId: string;
	/**
	 * Present when the source session had valid compaction state that was
	 * re-anchored onto the forked session, so the UI can surface why the
	 * next request is smaller than the canonical history.
	 */
	carriedWorkingContext?: {
		workingContextMessages: number;
		canonicalMessages: number;
	};
};

export type MuteCommandInput = {
	target?: string;
};

/**
 * One row of the hub's session list, as a chat surface needs it.
 *
 * `unattended` is the field that decides whether sending is safe: a session
 * started with `--zen` approves its own tool calls, while one started from a
 * TUI waits for a client that this thread is not. Sending to the latter parks
 * the turn on the first approval, so the list has to say which is which rather
 * than leaving the user to find out by hanging.
 */
export type ConnectorSessionSummary = {
	sessionId: string;
	title?: string;
	provider?: string;
	model?: string;
	cwd?: string;
	updatedAt?: string;
	unattended: boolean;
	/**
	 * The hub is running it right now. False for a stopped session (attaching
	 * revives it) and for one a TUI runs on its own local backend; absent when
	 * the hub cannot tell (older daemon).
	 */
	live?: boolean;
	/** A TUI still has it open; reviving it would give it two writers. */
	heldByPid?: number;
};

export type ChatCommandContext = {
	enabled: boolean;
	botUserName?: string;
	requireBotMention?: boolean;
	host?: ChatCommandHost;
	getState: () => Promise<ChatCommandState> | ChatCommandState;
	setState: (next: ChatCommandState) => Promise<void> | void;
	reply: (text: string) => Promise<void> | void;
	submitPrompt?: (prompt: string) => Promise<void> | void;
	reset?: () => Promise<void> | void;
	abort?: () => Promise<void> | void;
	stop?: () => Promise<void> | void;
	mute?: (
		input: MuteCommandInput,
	) => Promise<string | undefined> | string | undefined;
	unmute?: (
		input: MuteCommandInput,
	) => Promise<string | undefined> | string | undefined;
	describe?: () => Promise<string> | string;
	fork?: () =>
		| Promise<ForkSessionResult | undefined>
		| ForkSessionResult
		| undefined;
	/**
	 * Drive a session this thread did not start.
	 *
	 * A connector normally owns the sessions it creates, which makes it a second
	 * place work happens rather than a way into the work already running. These
	 * hand the thread the hub's session list and let it point at one: the same
	 * thing `cline send` does from a terminal, addressed by session id, so a task
	 * dispatched on a laptop can be steered from a phone and picked back up in
	 * the TUI afterwards.
	 */
	sessions?: {
		/** Recent sessions the hub knows about, newest first. */
		list?: (limit: number) => Promise<ConnectorSessionSummary[]>;
		/**
		 * Point this thread at `sessionId`; returns a line for the user.
		 * `revive` starts a stopped session back up in the hub first.
		 */
		attach?: (
			sessionId: string,
			options?: { revive?: boolean },
		) => Promise<string> | string;
		/** Stop driving the attached session and go back to the thread's own. */
		detach?: () => Promise<string> | string;
		/** The session this thread is currently driving, if it was attached. */
		attached?: () => Promise<string | undefined> | string | undefined;
	};
	schedule?: {
		create?: (input: {
			name: string;
			cronPattern: string;
			prompt: string;
		}) => Promise<string> | string;
		list?: () => Promise<string> | string;
		delete?: (scheduleId: string) => Promise<string> | string;
		trigger?: (scheduleId: string) => Promise<string> | string;
	};
};

type ParsedChatCommand = {
	input: string;
	trimmed: string;
	command: string;
	args: string[];
	state: ChatCommandState;
};

export type ChatCommandDefinition = {
	names: string[];
	isAvailable?: (context: ChatCommandContext) => boolean;
	run: (
		parsed: ParsedChatCommand,
		context: ChatCommandContext,
	) => Promise<void> | void;
};

export class ChatCommandHost {
	private readonly definitions: ChatCommandDefinition[];

	constructor(definitions: ChatCommandDefinition[] = []) {
		this.definitions = [...definitions];
	}

	register(
		_kind: "command",
		definition: ChatCommandDefinition,
	): ChatCommandHost {
		this.definitions.push(definition);
		return this;
	}

	getDefinitions(): readonly ChatCommandDefinition[] {
		return this.definitions;
	}

	clone(): ChatCommandHost {
		return new ChatCommandHost(this.definitions);
	}

	async handle(input: string, context: ChatCommandContext): Promise<boolean> {
		if (!context.enabled) {
			return false;
		}

		const trimmed = input.trim();
		if (!trimmed.startsWith("/")) {
			return false;
		}

		const [commandRaw, ...args] = trimmed.split(/\s+/);
		if (
			context.requireBotMention &&
			!isCommandAddressedToBot(commandRaw, context.botUserName)
		) {
			return false;
		}
		const command = normalizeCommandName(
			commandRaw.toLowerCase(),
			context.botUserName,
		);
		const parsed: ParsedChatCommand = {
			input,
			trimmed,
			command,
			args,
			state: await context.getState(),
		};
		const matched = this.definitions.find((definition) =>
			definition.names.includes(parsed.command),
		);
		if (!matched) {
			return false;
		}
		if (matched.isAvailable && !matched.isAvailable(context)) {
			return false;
		}
		await matched.run(parsed, context);
		return true;
	}
}

export function normalizeCommandName(
	command: string,
	botUserName?: string,
): string {
	const botMention = command.match(/^(\/[^@\s]+)@[a-z0-9_.-]+$/i);
	if (!botMention) {
		return command;
	}
	const expectedBotName = botUserName?.replace(/^@+/, "").trim().toLowerCase();
	if (!expectedBotName) {
		return command;
	}
	const suffix = command.slice(botMention[1].length + 1).toLowerCase();
	return suffix === expectedBotName ? botMention[1] : command;
}

export function isCommandAddressedToBot(
	command: string,
	botUserName?: string,
): boolean {
	const expectedBotName = botUserName?.replace(/^@+/, "").trim().toLowerCase();
	if (!expectedBotName) {
		return false;
	}
	const match = command.match(/^\/[^@\s]+@([a-z0-9_.-]+)$/i);
	return match?.[1]?.toLowerCase() === expectedBotName;
}

function tokenizeArgs(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaping = false;
	for (const char of input) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === "\\") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current) {
		tokens.push(current);
	}
	return tokens;
}

function parseFlagValues(tokens: string[]): {
	positionals: string[];
	flags: Record<string, string>;
} {
	const positionals: string[] = [];
	const flags: Record<string, string> = {};
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!token.startsWith("--")) {
			positionals.push(token);
			continue;
		}
		const key = token.slice(2).trim().toLowerCase();
		const value = tokens[index + 1];
		if (!key || !value || value.startsWith("--")) {
			flags[key] = "";
			continue;
		}
		flags[key] = value;
		index += 1;
	}
	return { positionals, flags };
}

function scheduleUsage(): string {
	return [
		"Usage:",
		'/schedule create "<name>" --cron "<pattern>" --prompt "<text>"',
		"/schedule list",
		"/schedule trigger <schedule-id>",
		"/schedule delete <schedule-id>",
	].join("\n");
}

function parseBooleanValue(
	value: string | undefined,
	current: boolean,
): boolean | undefined {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) {
		return undefined;
	}
	if (normalized === "on" || normalized === "true" || normalized === "1") {
		return true;
	}
	if (normalized === "off" || normalized === "false" || normalized === "0") {
		return false;
	}
	if (normalized === "toggle") {
		return !current;
	}
	return undefined;
}

function usage(text: string): string {
	return `Usage: ${text}`;
}

/**
 * Enough of a session id to type back, and no more.
 *
 * Hub ids are ULIDs — 26 characters, unreadable on a phone. A prefix is what
 * the user actually retypes, and `/attach` resolves prefixes, so the list shows
 * the prefix and nothing else.
 */
const SESSION_ID_PREFIX_LENGTH = 8;

/**
 * The part of a session id worth showing, and worth typing back.
 *
 * Hub ids are `<epoch-ms>_<random>`. The leading timestamp is identical for
 * every session started in the same ~100-second window, so two CLIs opened
 * together showed the SAME 8-character prefix and the list could not be used
 * to tell them apart. The random tail is the part that differs.
 */
export function shortSessionLabel(sessionId: string): string {
	const separator = sessionId.lastIndexOf("_");
	if (separator > 0 && separator < sessionId.length - 1) {
		return sessionId.slice(separator + 1);
	}
	return sessionId.slice(0, SESSION_ID_PREFIX_LENGTH);
}

function formatSessionLine(session: ConnectorSessionSummary): string {
	const parts = [
		shortSessionLabel(session.sessionId),
		session.heldByPid
			? `open in a TUI (pid ${session.heldByPid})`
			: session.live === false
				? "stopped"
				: session.unattended
					? "running, unattended"
					: "running, has a client",
	];
	if (session.model) parts.push(session.model);
	else if (session.provider) parts.push(session.provider);
	// Basename only: the full path is the least useful thing on a phone screen,
	// and both separators appear because a Windows hub serves POSIX-style cwds
	// from the workspace root.
	if (session.cwd) {
		parts.push(session.cwd.split(/[\\/]/).filter(Boolean).pop() ?? session.cwd);
	}
	const head = parts.join(" · ");
	return session.title ? `${head}\n  ${session.title}` : head;
}

/**
 * Resolve what the user typed to exactly one session.
 *
 * A prefix that matches several is refused rather than guessed: the whole point
 * of attaching is to drive a specific piece of work, and silently picking the
 * newest of two matches would send a message into the wrong job.
 */
export function resolveSessionReference(
	sessions: readonly ConnectorSessionSummary[],
	reference: string,
):
	| { ok: true; session: ConnectorSessionSummary }
	| { ok: false; error: string } {
	const wanted = reference.trim().toLowerCase();
	if (!wanted) {
		return { ok: false, error: usage("/attach <session-id>") };
	}
	const exact = sessions.find(
		(session) => session.sessionId.toLowerCase() === wanted,
	);
	if (exact) {
		return { ok: true, session: exact };
	}
	// What the list shows is the tail, so that is what a user types back.
	const byLabel = sessions.filter(
		(session) => shortSessionLabel(session.sessionId).toLowerCase() === wanted,
	);
	if (byLabel.length === 1 && byLabel[0]) {
		return { ok: true, session: byLabel[0] };
	}
	if (byLabel.length > 1) {
		return {
			ok: false,
			error: `${reference} matches ${byLabel.length} sessions. Use the full id.`,
		};
	}
	const matches = sessions.filter((session) =>
		session.sessionId.toLowerCase().startsWith(wanted),
	);
	if (matches.length === 1 && matches[0]) {
		return { ok: true, session: matches[0] };
	}
	if (matches.length > 1) {
		return {
			ok: false,
			error: `${reference} matches ${matches.length} sessions. Use more characters.`,
		};
	}
	return {
		ok: false,
		error: `No session matches ${reference}. Try /sessions.`,
	};
}

function formatHelp(state: ChatCommandState): string {
	return [
		"Cline connector commands:",
		"/help or /start - show this help",
		"/new or /clear - start a fresh session",
		"/whereami - show thread, cwd, tools, and yolo state",
		"/tools [on|off|toggle] - allow repo/file/shell tools",
		"/yolo [on|off|toggle] - auto-approve tool use",
		"/cwd <path> - change working directory",
		"/sessions - list sessions running on this machine",
		"/attach <id> - drive one of them from this thread",
		"/detach - go back to this thread's own session",
		"/schedule create/list/trigger/delete - manage scheduled workflows",
		"/abort - stop the current task",
		"/mute [target] - ignore this thread or target until /unmute",
		"/unmute [target] - resume processing this thread or target",
		"/exit - stop this connector",
		"",
		`Current state: tools=${state.enableTools ? "on" : "off"}, yolo=${state.autoApproveTools ? "on" : "off"}, muted=${state.threadMuted ? "true" : "false"}`,
		state.toolsLocked
			? "Tool controls are locked because this connector was started with --no-tools."
			: undefined,
		"Send normal text to ask a question or assign a task.",
		"When tools are on, I can inspect files, edit code, run commands/tests, and help prepare PRs.",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

export function createChatCommandHost(): ChatCommandHost {
	return new ChatCommandHost();
}

function createDefaultChatCommandHost(): ChatCommandHost {
	return createChatCommandHost()
		.register("command", {
			names: ["/help", "/start"],
			run: async ({ state }, context) => {
				await context.reply(formatHelp(state));
			},
		})
		.register("command", {
			names: ["/clear", "/new"],
			isAvailable: (context) => typeof context.reset === "function",
			run: async (_parsed, context) => {
				await context.reset?.();
				await context.reply("Started a fresh session.");
			},
		})
		.register("command", {
			names: ["/sessions"],
			isAvailable: (context) => typeof context.sessions?.list === "function",
			run: async (_parsed, context) => {
				const sessions = (await context.sessions?.list?.(15)) ?? [];
				if (sessions.length === 0) {
					await context.reply(
						'No sessions yet. Start one with `cline --zen "<task>"`.',
					);
					return;
				}
				const attached = await context.sessions?.attached?.();
				await context.reply(
					[
						"Sessions (newest first):",
						...sessions.map((session) => {
							const marker =
								attached && session.sessionId === attached ? "▶ " : "  ";
							return `${marker}${formatSessionLine(session)}`;
						}),
						"",
						"/attach <id> to drive one (a stopped one is started back up with its history) · /detach to stop",
					].join("\n"),
				);
			},
		})
		.register("command", {
			names: ["/attach"],
			isAvailable: (context) => typeof context.sessions?.attach === "function",
			run: async ({ args }, context) => {
				const reference = args[0];
				if (!reference) {
					await context.reply(usage("/attach <session-id> — see /sessions"));
					return;
				}
				const sessions = (await context.sessions?.list?.(200)) ?? [];
				const resolved = resolveSessionReference(sessions, reference);
				if (!resolved.ok) {
					await context.reply(resolved.error);
					return;
				}
				// A stopped session is revived by `attach`. One a TUI still has open
				// is not: two runtimes on one transcript overwrite each other.
				if (resolved.session.heldByPid) {
					await context.reply(
						[
							`${shortSessionLabel(resolved.session.sessionId)} is open in a TUI (pid ${resolved.session.heldByPid}) that runs it outside the hub.`,
							"Close that TUI, then /attach again — it will be started back up",
							"here with its full history.",
						].join("\n"),
					);
					return;
				}
				const attached =
					(await context.sessions?.attach?.(resolved.session.sessionId, {
						revive: resolved.session.live === false,
					})) ?? `Attached to ${resolved.session.sessionId}.`;
				// Say it up front rather than letting the first tool call hang. A
				// session started from a TUI answers approvals through the client
				// attached to it, and this thread is not that client: forwarding a
				// message parks the turn on the first tool call that needs one, and
				// from here that looks like the session simply stopped replying.
				// A revived session is started by this connector, so its approvals
				// come here — the warning only applies to one another client runs.
				await context.reply(
					resolved.session.unattended || resolved.session.live === false
						? attached
						: [
								attached,
								"",
								"Heads up: this session was not started with --zen, so it asks",
								"its own client for tool approvals. Messages from here will",
								"stall on the first tool call that needs one. Answer it where",
								"the session is attached, or use a session started with --zen.",
							].join("\n"),
				);
			},
		})
		.register("command", {
			names: ["/detach"],
			isAvailable: (context) => typeof context.sessions?.detach === "function",
			run: async (_parsed, context) => {
				await context.reply(
					(await context.sessions?.detach?.()) ?? "Detached.",
				);
			},
		})
		.register("command", {
			names: ["/abort"],
			isAvailable: (context) => typeof context.abort === "function",
			run: async (_parsed, context) => {
				await context.abort?.();
			},
		})
		.register("command", {
			names: ["/mute"],
			isAvailable: (context) => typeof context.mute === "function",
			run: async ({ args }, context) => {
				const target = args.join(" ").trim() || undefined;
				const reply = await context.mute?.({ target });
				await context.reply(
					reply ?? "Thread muted. I will ignore messages here until /unmute.",
				);
			},
		})
		.register("command", {
			names: ["/unmute"],
			isAvailable: (context) => typeof context.unmute === "function",
			run: async ({ args }, context) => {
				const target = args.join(" ").trim() || undefined;
				const reply = await context.unmute?.({ target });
				await context.reply(reply ?? "Thread unmuted.");
			},
		})
		.register("command", {
			names: ["/exit"],
			isAvailable: (context) => typeof context.stop === "function",
			run: async (_parsed, context) => {
				await context.reply("Stopping session.");
				await context.stop?.();
			},
		})
		.register("command", {
			names: ["/whereami"],
			isAvailable: (context) => typeof context.describe === "function",
			run: async (_parsed, context) => {
				const description = await context.describe?.();
				if (description) {
					await context.reply(description);
				}
			},
		})
		.register("command", {
			names: ["/tools"],
			run: async ({ args, state }, context) => {
				const resolved = parseBooleanValue(args[0], state.enableTools);
				if (args[0] && resolved === undefined) {
					await context.reply(usage("/tools [on|off|toggle]"));
					return;
				}
				if (resolved === undefined) {
					await context.reply(`tools=${state.enableTools ? "on" : "off"}`);
					return;
				}
				await context.setState({ ...state, enableTools: resolved });
				await context.reply(`tools=${resolved ? "on" : "off"}`);
			},
		})
		.register("command", {
			names: ["/yolo"],
			run: async ({ args, state }, context) => {
				const resolved = parseBooleanValue(args[0], state.autoApproveTools);
				if (args[0] && resolved === undefined) {
					await context.reply(usage("/yolo [on|off|toggle]"));
					return;
				}
				if (resolved === undefined) {
					await context.reply(`yolo=${state.autoApproveTools ? "on" : "off"}`);
					return;
				}
				await context.setState({ ...state, autoApproveTools: resolved });
				await context.reply(`yolo=${resolved ? "on" : "off"}`);
			},
		})
		.register("command", {
			names: ["/cwd"],
			run: async ({ args, state }, context) => {
				const rawPath = args.join(" ").trim();
				if (!rawPath) {
					await context.reply(
						`cwd=${state.cwd}\nworkspaceRoot=${state.workspaceRoot}`,
					);
					return;
				}
				const nextCwd = resolve(state.cwd, rawPath);
				const fileStat = await stat(nextCwd).catch(() => undefined);
				if (!fileStat?.isDirectory()) {
					await context.reply(`invalid directory: ${nextCwd}`);
					return;
				}
				const workspaceRoot = resolveWorkspaceRoot(nextCwd);
				await context.setState({
					...state,
					cwd: nextCwd,
					workspaceRoot,
				});
				await context.reply(`cwd=${nextCwd}\nworkspaceRoot=${workspaceRoot}`);
			},
		})
		.register("command", {
			names: ["/manager"],
			run: async (_parsed, context) => {
				// Like /team, the interactive runtime intercepts this before the host
				// sees it: switching into manager mode rebuilds the system prompt and
				// restarts the session, which only the runtime can do.
				await context.reply(
					"The /manager command must be entered directly as a prompt at the start of a session, not via a chat command.",
				);
			},
		})
		.register("command", {
			names: ["/team"],
			run: async ({ args }, context) => {
				const taskBody = args.join(" ").trim();
				if (!taskBody) {
					await context.reply(
						"Usage: /team <task description>\nStarts a team of agents for the given task.",
					);
					return;
				}
				// In the default host the /team command only shows usage.
				// The interactive runtime handles input transformation and
				// session-level enableTeams toggling before this host runs.
				await context.reply(
					"The /team command must be entered directly as a prompt, not via a chat command.",
				);
			},
		})
		.register("command", {
			names: ["/fork"],
			isAvailable: (context) => typeof context.fork === "function",
			run: async (_parsed, context) => {
				let result: ForkSessionResult | undefined;
				try {
					result = await context.fork?.();
				} catch (error) {
					await context.reply(
						error instanceof Error
							? error.message
							: "Fork failed: could not read messages from the current session.",
					);
					return;
				}
				if (!result) {
					await context.reply(
						"Fork failed: could not read messages from the current session.",
					);
					return;
				}
				await context.reply(
					`Forked session ${result.forkedFromSessionId} into new session ${result.newSessionId}. This is now the active session. Use /history to switch sessions.`,
				);
			},
		})
		.register("command", {
			names: ["/schedule"],
			run: async ({ args }, context) => {
				if (!context.schedule) {
					await context.reply("Scheduling is not available in this chat.");
					return;
				}
				const subcommand = args[0]?.trim().toLowerCase();
				if (!subcommand || subcommand === "help") {
					await context.reply(scheduleUsage());
					return;
				}
				if (subcommand === "list") {
					if (!context.schedule.list) {
						await context.reply("Schedule listing is not available here.");
						return;
					}
					await context.reply(await context.schedule.list());
					return;
				}
				if (subcommand === "trigger") {
					const scheduleId = args[1]?.trim();
					if (!scheduleId) {
						await context.reply(usage("/schedule trigger <schedule-id>"));
						return;
					}
					if (!context.schedule.trigger) {
						await context.reply("Schedule triggering is not available here.");
						return;
					}
					await context.reply(await context.schedule.trigger(scheduleId));
					return;
				}
				if (subcommand === "delete") {
					const scheduleId = args[1]?.trim();
					if (!scheduleId) {
						await context.reply(usage("/schedule delete <schedule-id>"));
						return;
					}
					if (!context.schedule.delete) {
						await context.reply("Schedule deletion is not available here.");
						return;
					}
					await context.reply(await context.schedule.delete(scheduleId));
					return;
				}
				if (subcommand === "create") {
					if (!context.schedule.create) {
						await context.reply("Schedule creation is not available here.");
						return;
					}
					const parsed = parseFlagValues(tokenizeArgs(args.slice(1).join(" ")));
					const name =
						parsed.positionals.join(" ").trim() || parsed.flags.name?.trim();
					const cronPattern = parsed.flags.cron?.trim();
					const prompt = parsed.flags.prompt?.trim();
					if (!name || !cronPattern || !prompt) {
						await context.reply(scheduleUsage());
						return;
					}
					await context.reply(
						await context.schedule.create({ name, cronPattern, prompt }),
					);
					return;
				}
				await context.reply(scheduleUsage());
			},
		});
}

export const chatCommandHost = createDefaultChatCommandHost();

export async function maybeHandleChatCommand(
	input: string,
	context: ChatCommandContext,
): Promise<boolean> {
	return (context.host ?? chatCommandHost).handle(input, context);
}
