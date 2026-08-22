import type { ToolApprovalRequest, ToolApprovalResult } from "@cline/sdk";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentMode } from "./agent-mode.js";
import { CoreMode } from "./core-mode.js";
import { ReplyStreamer } from "./stream.js";
import {
	TelegramClient,
	type TelegramCallbackQuery,
	type TelegramMessage,
	type TelegramUpdate,
} from "./telegram.js";

/**
 * Cline Telegram bridge.
 *
 * Lets you text a Telegram bot and drive a local AI (default: llama.cpp via
 * Cline's built-in `llamacpp` provider) through the Cline SDK. Two switchable
 * modes:
 *
 *  - agent      -> lightweight, stateless-per-conversation `Agent.run()/continue()`
 *  - clinecore  -> full persistent sessions with built-in tools and inline-keyboard
 *                  tool approvals
 */

const DEFAULT_LLAMACPP_MODEL = "qwen2.5-0.5b-instruct-q4_k_m.gguf";
const DEFAULT_LLAMACPP_BASE = "http://localhost:8080/v1";
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

const HELP_TEXT = `🤖 Cline Telegram Bridge

You're talking to a local AI driven by the Cline SDK.

Commands:
/mode            show current mode
/mode agent      lightweight chat (Agent API, no tools)
/mode clinecore  full persistent sessions with tools + approvals
/new             start a fresh conversation (current mode)
/abort           stop the current run + clear this chat's session from memory
/model           list available models (tap a button to switch)
/model <n>       switch to model #n from the list (or a filename substring)
/projects        list saved project folders (name + path)
/add <folder>    save a project folder (no arg = use current folder)
/continue <n>    switch this chat to project #n (fresh session there)
/delete <n>      remove project #n
/tools [on|off]  toggle built-in tools (clinecore mode)
/yolo  [on|off]  auto-approve tool use (clinecore mode)
/status          show mode, provider, model, cwd, working folder
/whereami        show this chat id
/help            show this help

Anything else you type is sent to the model.`;

const USAGE = `Cline Telegram bridge

Usage:
  TELEGRAM_BOT_TOKEN=<token> bun run src/index.ts

Required env:
  TELEGRAM_BOT_TOKEN  (or TELEGRAM_TOKEN)  your Telegram bot token from @BotFather

Optional env:
  ALLOWED_USER_ID       numeric Telegram user id the bot will respond to
  TELEGRAM_CHAT_ID      numeric chat id the bot will respond to
  DEFAULT_MODE          "agent" | "clinecore" (default: agent)
  CLINE_PROVIDER_ID     (default: llamacpp)
  CLINE_MODEL_ID        llama.cpp: the .gguf model filename (auto-discovered if empty)
  CLINE_MODELS_DIR      extra directory to scan for /model .gguf files
  CLINE_BASE_URL        (default: ${DEFAULT_LLAMACPP_BASE} for llamacpp)
  CLINE_API_KEY         API key for non-local providers
  CLINE_CWD             workspace for ClineCore sessions (default: process.cwd())
  CLINE_PROJECTS_FILE   JSON file for saved projects (default: ./projects.json)
  CLINE_SYSTEM_PROMPT   custom system prompt
  CLINE_MAX_ITERATIONS  ClineCore max iterations (default: 40)
  CLINE_TOOLS           "on" | "off" built-in tools in clinecore mode (default: on)
  CLINE_AUTO_APPROVE    "true" to auto-approve all tools (default: false)
  TELEGRAM_API_BASE     custom Bot API base URL
  CLINE_BRIDGE_CONFIG   JSON file with {token, chatId, modelsDir} (default:
                        ~/.cline/telegram-bridge/config.json) used as a fallback when env vars
                        aren't set, so the bridge can be auto-started by
                        scripts/start-telegram-bridge.ps1 on every clinemin run.`;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function env(name: string): string {
	return process.env[name]?.trim() ?? "";
}

/**
 * Optional JSON config file (default ~/.cline/telegram-bridge/config.json) can
 * hold `token` / `chatId` so the bridge can be auto-started by the `clinemin`
 * launcher without needing shell env vars. Env vars always win.
 */
function readBridgeFileConfig(): { token?: string; chatId?: string; modelsDir?: string } {
	const file =
		env("CLINE_BRIDGE_CONFIG") ||
		path.join(os.homedir(), ".cline", "telegram-bridge", "config.json");
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as {
			token?: string;
			chatId?: string;
			modelsDir?: string;
		};
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

const bridgeFileConfig = readBridgeFileConfig();

const config = {
	botToken: env("TELEGRAM_BOT_TOKEN") || env("TELEGRAM_TOKEN") || bridgeFileConfig.token || "",
	apiBase: env("TELEGRAM_API_BASE"),
	allowedUserId: env("ALLOWED_USER_ID"),
	allowedChatId: env("TELEGRAM_CHAT_ID") || bridgeFileConfig.chatId || "",
	defaultMode: (env("DEFAULT_MODE") || "agent") as "agent" | "clinecore",
	providerId: env("CLINE_PROVIDER_ID") || "llamacpp",
	modelId: env("CLINE_MODEL_ID"),
	apiKey: env("CLINE_API_KEY"),
	baseUrl: env("CLINE_BASE_URL"),
	cwd: env("CLINE_CWD") || process.cwd(),
	workspaceRoot: env("CLINE_WORKSPACE_ROOT") || env("CLINE_CWD") || process.cwd(),
	systemPrompt: env("CLINE_SYSTEM_PROMPT"),
	maxIterations: Number(env("CLINE_MAX_ITERATIONS") || "40"),
	enableTools: env("CLINE_TOOLS") !== "off",
	autoApprove: env("CLINE_AUTO_APPROVE") === "true",
	pollTimeout: Number(env("POLL_TIMEOUT") || "30"),
};

interface RuntimeSettings {
	providerId: string;
	modelId: string;
	apiKey?: string;
	baseUrl?: string;
	cwd: string;
	workspaceRoot: string;
	systemPrompt?: string;
	maxIterations: number;
	enableTools: boolean;
	autoApprove: boolean;
}

let rt: RuntimeSettings;

/**
 * Ask a llama.cpp server which model it currently has loaded (OpenAI-compatible
 * `/v1/models`). Returns null if the server isn't reachable or reports nothing.
 */
async function getServedModelId(baseUrl: string): Promise<string | null> {
	try {
		const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
			signal: AbortSignal.timeout(3000),
		});
		if (res.ok) {
			const data = (await res.json()) as { data?: Array<{ id?: string }> };
			return data?.data?.[0]?.id ?? null;
		}
	} catch {
		// server not reachable yet — Cline's auto-start will handle it
	}
	return null;
}

/**
 * llama.cpp reports its loaded model via the OpenAI-compatible /v1/models
 * endpoint. If the user didn't pin CLINE_MODEL_ID, discover the served model so
 * the request `model` field matches what the server loaded. If the server isn't
 * up yet, Cline will auto-start it with the default model.
 */
async function resolveModelId(
	providerId: string,
	configured: string,
	baseUrl: string,
): Promise<string> {
	if (configured) return configured;
	if (providerId === "llamacpp") {
		return (await getServedModelId(baseUrl)) ?? DEFAULT_LLAMACPP_MODEL;
	}
	return configured;
}

// ---------------------------------------------------------------------------
// Per-chat sessions & mode plumbing
// ---------------------------------------------------------------------------

type ModeName = "agent" | "clinecore";

interface ChatSession {
	chatId: number;
	mode: ModeName;
	agent: AgentMode | null;
	core: CoreMode | null;
	chain: Promise<unknown>;
}

const sessions = new Map<number, ChatSession>();
const activeStreamers = new Map<number, ReplyStreamer>();

function getSession(chatId: number): ChatSession {
	let s = sessions.get(chatId);
	if (!s) {
		s = { chatId, mode: config.defaultMode, agent: null, core: null, chain: Promise.resolve() };
		sessions.set(chatId, s);
	}
	return s;
}

function createAgentMode(): AgentMode {
	return new AgentMode({
		providerId: rt.providerId,
		modelId: rt.modelId,
		apiKey: rt.apiKey,
		baseUrl: rt.baseUrl,
		systemPrompt: rt.systemPrompt,
	});
}

function createCoreMode(chatId: number): CoreMode {
	return new CoreMode(chatId, {
		providerId: rt.providerId,
		modelId: rt.modelId,
		apiKey: rt.apiKey,
		baseUrl: rt.baseUrl,
		cwd: rt.cwd,
		workspaceRoot: rt.workspaceRoot,
		systemPrompt: rt.systemPrompt,
		maxIterations: rt.maxIterations,
		enableTools: rt.enableTools,
		autoApprove: rt.autoApprove,
		requestApproval: (req) => requestApproval(chatId, req),
	});
}

function modeFor(s: ChatSession): AgentMode | CoreMode {
	if (s.mode === "agent") {
		s.agent ??= createAgentMode();
		return s.agent;
	}
	s.core ??= createCoreMode(s.chatId);
	return s.core;
}

async function disposeMode(s: ChatSession): Promise<void> {
	if (s.core) {
		await s.core.dispose().catch(() => undefined);
		s.core = null;
	}
	if (s.agent) {
		await s.agent.dispose().catch(() => undefined);
		s.agent = null;
	}
}

// ---------------------------------------------------------------------------
// Model switching (llama.cpp)
//
// Cline's llamacpp runtime restarts llama-server whenever the requested model
// path differs from what the server has loaded. So "switching models" here means:
// pick a .gguf from the available list, store it as rt.modelId, dispose the
// existing sessions (new ones are created with the new model), and let Cline
// restart the server on the next message.
// ---------------------------------------------------------------------------

interface AvailableModel {
	path: string;
	current?: boolean;
}

/** The model list last shown via /model, so inline-keyboard callbacks can resolve an index. */
let modelPicker: AvailableModel[] = [];

function scanDirModels(
	dir: string,
	add: (p: string) => void,
	depth: number,
	maxDepth: number,
): void {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		const full = path.join(dir, name);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(full);
		} catch {
			continue;
		}
		if (stat.isFile()) {
			if (/\.gguf$/i.test(name)) add(full);
		} else if (stat.isDirectory() && depth < maxDepth) {
			scanDirModels(full, add, depth + 1, maxDepth);
		}
	}
}

/**
 * Discover switchable GGUF models: scan known model directories plus the
 * directory of the currently-served model. Sharded model parts
 * (`*-00001-of-00004.gguf`) are excluded — they aren't independently loadable.
 */
async function discoverModels(): Promise<AvailableModel[]> {
	const served = await getServedModelId(rt.baseUrl || DEFAULT_LLAMACPP_BASE);
	const map = new Map<string, AvailableModel>();
	const add = (p: string): void => {
		if (/-\d+-of-\d+\.gguf$/i.test(p)) return; // sharded part, not standalone
		const r = path.resolve(p);
		map.set(r.toLowerCase(), { path: r });
	};
	const dirs = new Set<string>();
	// Extra scan dir: env var wins, else the bridge config file, so a saved
	// `modelsDir` works even when the bridge is started without env vars.
	const extraModelsDir = env("CLINE_MODELS_DIR") || bridgeFileConfig.modelsDir;
	for (const d of [
		extraModelsDir,
		path.join(os.homedir(), ".cline", "llamacpp", "models"),
		path.join(os.homedir(), ".localcode", "llamacpp", "models"),
	]) {
		if (d) dirs.add(d);
	}
	if (served) {
		add(served);
		dirs.add(path.dirname(served));
	}
	for (const dir of dirs) scanDirModels(dir, add, 0, 2);

	const currentPath = served ? path.resolve(served).toLowerCase() : null;
	return [...map.values()]
		.map((m) => ({
			...m,
			current: currentPath ? m.path.toLowerCase() === currentPath : false,
		}))
		.sort((a, b) => a.path.localeCompare(b.path));
}

async function handleModelCommand(chatId: number, arg: string): Promise<void> {
	if (arg) {
		await selectModel(chatId, arg);
		return;
	}
	modelPicker = await discoverModels();
	if (modelPicker.length === 0) {
		await tg.send(
			chatId,
			"No GGUF models found. Put `.gguf` files in `~/.cline/llamacpp/models` (or set `CLINE_MODELS_DIR`).",
		);
		return;
	}
	const lines = modelPicker.map(
		(m, i) => `${i + 1}. ${m.current ? "🟢 " : ""}${path.basename(m.path)}\n   \`${m.path}\``,
	);
	const buttons = modelPicker
		.slice(0, 12)
		.map((m, i) => [{ text: `${i + 1}. ${path.basename(m.path).slice(0, 28)}`, callback_data: `md:${i}` }]);
	const opts = buttons.length ? { replyMarkup: { inline_keyboard: buttons } } : {};
	await tg.send(
		chatId,
		`Available models (${modelPicker.length}):\n\n${lines.join("\n")}\n\nTap a button or send \`/model <number>\` to switch.`,
		opts,
	);
}

async function selectModel(chatId: number, arg: string): Promise<void> {
	const all = modelPicker.length ? modelPicker : await discoverModels();
	let chosen: AvailableModel | undefined;
	const num = Number(arg);
	if (Number.isInteger(num) && num >= 1) {
		chosen = all[num - 1];
	}
	if (!chosen) {
		const lower = arg.toLowerCase();
		chosen = all.find((m) => path.basename(m.path).toLowerCase().includes(lower));
	}
	if (!chosen) {
		await tg.send(chatId, `No model matched \`${arg}\`. Send \`/model\` to see the list.`);
		return;
	}
	await applyModel(chatId, chosen);
}

async function applyModel(chatId: number, m: AvailableModel): Promise<void> {
	const served = await getServedModelId(rt.baseUrl || DEFAULT_LLAMACPP_BASE);
	if (served && path.resolve(served).toLowerCase() === path.resolve(m.path).toLowerCase()) {
		await tg.send(chatId, `Already running \`${path.basename(m.path)}\`.`);
		return;
	}
	rt.modelId = m.path;
	// New sessions pick up the new model, so drop existing ones for the change to
	// take effect (Cline restarts llama-server with the new model on next message).
	for (const s of sessions.values()) {
		await disposeMode(s).catch(() => undefined);
	}
	await tg.send(
		chatId,
		`✅ Switched to \`${path.basename(m.path)}\`.\nIt will load on your next message — llama.cpp restarts the server, which can take a little while.`,
	);
}

// ---------------------------------------------------------------------------
// Persistent projects
//
// A tiny registry of project folders kept in a JSON file so it survives bridge
// restarts. Use /add to register a folder you work on (e.g. a repo you open on
// desktop), then /projects to list them, /continue <n> to point this chat at
// one, or /delete <n> to drop it. What persists is the project *identity*
// (name + folder path) — switching projects starts a fresh session in that
// folder, so each project keeps its own conversation while the bridge runs.
// ---------------------------------------------------------------------------

interface Project {
	id: number;
	name: string;
	folder: string;
	createdAt: number;
	lastUsedAt: number;
}

const PROJECTS_FILE =
	env("CLINE_PROJECTS_FILE") || path.join(process.cwd(), "projects.json");

function loadProjects(): Project[] {
	try {
		const parsed = JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf-8"));
		if (Array.isArray(parsed)) return parsed as Project[];
	} catch {
		// missing or unreadable — start empty
	}
	return [];
}

let projects: Project[] = loadProjects();
let nextProjectId = projects.reduce((maxId, p) => Math.max(maxId, p.id), 0) + 1;

function saveProjects(): void {
	try {
		fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
	} catch (error) {
		console.error(
			"[bridge] failed to save projects:",
			error instanceof Error ? error.message : String(error),
		);
	}
}

function formatProject(p: Project, currentFolder: string): string {
	const isCurrent =
		path.resolve(currentFolder).toLowerCase() === path.resolve(p.folder).toLowerCase();
	return `${isCurrent ? "🟢 " : ""}${p.id}. ${p.name} — \`${p.folder}\``;
}

async function handleProjectsCommand(chatId: number): Promise<void> {
	if (projects.length === 0) {
		await tg.send(
			chatId,
			"No saved projects yet. Register one with `/add <folder>` (or `/add` to use the current folder).",
		);
		return;
	}
	const lines = projects
		.slice()
		.sort((a, b) => a.id - b.id)
		.map((p) => formatProject(p, rt.cwd))
		.join("\n");
	await tg.send(
		chatId,
		`📁 Projects:\n\n${lines}\n\n/continue <n> to switch to a project, /delete <n> to remove one.`,
	);
}

async function addProject(chatId: number, folderArg: string): Promise<void> {
	const folder = path.resolve(folderArg.trim() || rt.cwd);
	const existing = projects.find(
		(p) => path.resolve(p.folder).toLowerCase() === folder.toLowerCase(),
	);
	if (existing) {
		existing.lastUsedAt = Date.now();
		saveProjects();
		await tg.send(chatId, `Already saved: \`${existing.name}\` — \`${existing.folder}\`.`);
		return;
	}
	const name = path.basename(folder) || folder;
	projects.push({
		id: nextProjectId++,
		name,
		folder,
		createdAt: Date.now(),
		lastUsedAt: Date.now(),
	});
	saveProjects();
	await tg.send(chatId, `✅ Saved project \`${nextProjectId - 1}. ${name}\` — \`${folder}\`.`);
}

async function continueProject(chatId: number, arg: string): Promise<void> {
	const idx = Number(arg);
	const p = projects.find((x) => x.id === idx);
	if (!p) {
		await tg.send(chatId, `No project \`${arg}\`. Send /projects to see the list.`);
		return;
	}
	rt.cwd = p.folder;
	rt.workspaceRoot = p.folder;
	p.lastUsedAt = Date.now();
	saveProjects();
	// new sessions pick up the new cwd; drop the current one so the next
	// message starts a fresh session rooted in this project's folder
	await disposeMode(getSession(chatId)).catch(() => undefined);
	await tg.send(
		chatId,
		`🟢 Now working on \`${p.name}\` — \`${p.folder}\`.\nStarted a fresh session for this project.`,
	);
}

async function deleteProject(chatId: number, arg: string): Promise<void> {
	const idx = Number(arg);
	const p = projects.find((x) => x.id === idx);
	if (!p) {
		await tg.send(chatId, `No project \`${arg}\`. Send /projects to see the list.`);
		return;
	}
	projects = projects.filter((x) => x.id !== idx);
	saveProjects();
	await tg.send(chatId, `🗑️ Deleted project \`${p.name}\` — \`${p.folder}\`.`);
}

function enqueue(chatId: number, task: () => Promise<void>): Promise<void> {
	const s = getSession(chatId);
	const next = s.chain.then(() => task()).catch(() => undefined);
	s.chain = next;
	return next;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function snippet(value: unknown, max = 400): string {
	let text = "";
	try {
		text = typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		text = String(value);
	}
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ---------------------------------------------------------------------------
// Tool approvals over Telegram inline keyboards
// ---------------------------------------------------------------------------

interface PendingApproval {
	chatId: number;
	respond: (approved: boolean) => Promise<void>;
	resolve: (result: ToolApprovalResult) => void;
}

const pendingApprovals = new Map<number, PendingApproval>();
let approvalSeq = 0;

async function requestApproval(
	chatId: number,
	req: ToolApprovalRequest,
): Promise<ToolApprovalResult> {
	const id = ++approvalSeq;
	const streamer = activeStreamers.get(chatId);
	if (!streamer) {
		return { approved: false, reason: "No active session" };
	}
	const text = `🔒 \`${req.toolName}\` requests approval:\n\`\`\`\n${snippet(req.input)}\n\`\`\``;
	const { respond } = await streamer.askApproval(text, {
		inline_keyboard: [
			[
				{ text: "✅ Approve", callback_data: `ap:${id}:1` },
				{ text: "⛔ Deny", callback_data: `ap:${id}:0` },
			],
		],
	});

	return new Promise<ToolApprovalResult>((resolve) => {
		pendingApprovals.set(id, { chatId, respond, resolve });
		setTimeout(() => {
			const p = pendingApprovals.get(id);
			if (p) {
				pendingApprovals.delete(id);
				void p.respond(false);
				p.resolve({ approved: false, reason: "Approval timed out" });
			}
		}, APPROVAL_TIMEOUT_MS);
	});
}

async function handleCallback(query: TelegramCallbackQuery): Promise<void> {
	const data = query.data ?? "";
	const match = /^ap:(\d+):([01])$/.exec(data);
	if (match) {
		const id = Number(match[1]);
		const approved = match[2] === "1";
		const p = pendingApprovals.get(id);
		if (p) {
			pendingApprovals.delete(id);
			await tg.answerCallback(query.id, approved ? "Approved" : "Denied");
			await p.respond(approved);
			p.resolve({ approved, ...(approved ? {} : { reason: "User denied tool execution" }) });
		} else {
			await tg.answerCallback(query.id, "This approval is no longer pending");
		}
		return;
	}
	const mdMatch = /^md:(\d+)$/.exec(data);
	if (mdMatch) {
		const idx = Number(mdMatch[1]);
		const picker = modelPicker.length ? modelPicker : await discoverModels();
		const m = picker[idx];
		await tg.answerCallback(query.id, m ? `Selected ${path.basename(m.path)}` : "Not found");
		const chatId = query.message?.chat.id ?? query.from.id;
		if (m) await applyModel(chatId, m);
		return;
	}
	await tg.answerCallback(query.id);
}

// ---------------------------------------------------------------------------
// Turn + command handling
// ---------------------------------------------------------------------------

async function runTurn(chatId: number, prompt: string): Promise<void> {
	const s = getSession(chatId);
	const mode = modeFor(s);
	const streamer = new ReplyStreamer(tg, chatId);
	activeStreamers.set(chatId, streamer);
	try {
		const ui = {
			onDelta: (text: string) => streamer.stream(text),
			onNotice: (text: string) => void streamer.notice(text),
		};
		const text = await mode.run(prompt, ui);
		await streamer.done(text);
	} catch (error) {
		await streamer.error(error instanceof Error ? error.message : String(error));
	} finally {
		activeStreamers.delete(chatId);
	}
}

async function handleCommand(chatId: number, raw: string): Promise<void> {
	const s = getSession(chatId);
	const parts = raw.split(/\s+/);
	const cmd = parts[0].toLowerCase();
	const arg = parts.slice(1).join(" ").trim();

	switch (cmd) {
		case "/start":
		case "/help":
			await tg.send(chatId, HELP_TEXT);
			return;
		case "/mode": {
			const a = arg.toLowerCase();
			if (a === "agent" || a === "clinecore") {
				if (s.mode !== a) {
					await disposeMode(s);
					s.mode = a;
				}
				await tg.send(chatId, `Mode set to \`${a}\`.`);
			} else {
				await tg.send(
					chatId,
					`Current mode: \`${s.mode}\`.\n\nUse /mode agent or /mode clinecore to switch.`,
				);
			}
			return;
		}
		case "/new":
		case "/clear":
			await disposeMode(s);
			await tg.send(chatId, "Started a fresh conversation.");
			return;
		case "/model":
			await handleModelCommand(chatId, arg);
			return;
		case "/projects":
		case "/list":
			await handleProjectsCommand(chatId);
			return;
		case "/add":
			await addProject(chatId, arg);
			return;
		case "/continue":
		case "/use":
			await continueProject(chatId, arg);
			return;
		case "/delete":
			await deleteProject(chatId, arg);
			return;
		case "/tools": {
			if (s.mode !== "clinecore") {
				await tg.send(chatId, "/tools only applies in clinecore mode.");
				return;
			}
			const core = modeFor(s) as CoreMode;
			const a = arg.toLowerCase();
			const on = a === "" ? !core.enableTools : a !== "off";
			core.setTools(on);
			await tg.send(chatId, `Built-in tools ${on ? "enabled" : "disabled"}.`);
			return;
		}
		case "/yolo": {
			if (s.mode !== "clinecore") {
				await tg.send(chatId, "/yolo only applies in clinecore mode.");
				return;
			}
			const core = modeFor(s) as CoreMode;
			const a = arg.toLowerCase();
			const on = a === "" ? !core.autoApprove : a !== "off";
			core.setAutoApprove(on);
			await tg.send(chatId, `Auto-approve ${on ? "ON" : "OFF"}.`);
			return;
		}
		case "/status": {
			const lines = [
				`Mode: \`${s.mode}\``,
				`Provider: \`${rt.providerId}\``,
				`Model: \`${rt.modelId || "(auto)"}\``,
				`Base URL: \`${rt.baseUrl || "(default)"}\``,
				`CWD: \`${rt.cwd}\``,
				`Working folder: \`${rt.workspaceRoot}\``,
			];
			if (s.mode === "clinecore") {
				const core = modeFor(s) as CoreMode;
				lines.push(`Tools: \`${core.enableTools ? "on" : "off"}\``);
				lines.push(`Auto-approve: \`${core.autoApprove ? "on" : "off"}\``);
			}
			await tg.send(chatId, lines.join("\n"));
			return;
		}
		case "/whereami":
			await tg.send(chatId, `\`${chatId}\``);
			return;
		default:
			await tg.send(chatId, `Unknown command \`${cmd}\`. Send /help.`);
			return;
	}
}

async function handleMessage(msg: TelegramMessage): Promise<void> {
	const chatId = msg.chat.id;
	if (config.allowedUserId && String(msg.from?.id) !== String(config.allowedUserId)) {
		await tg.send(chatId, "⛔ Unauthorized. This bot is restricted to a specific user.").catch(
			() => undefined,
		);
		return;
	}
	if (config.allowedChatId && String(chatId) !== String(config.allowedChatId)) {
		await tg.send(chatId, "⛔ Unauthorized. This bot is restricted to a specific chat.").catch(
			() => undefined,
		);
		return;
	}
	const text = (msg.text ?? "").trim();
	if (!text) return;
	// /abort is handled OUTSIDE the per-chat chain so it can interrupt a turn
	// that is currently running (a queued command would only run after the turn
	// finishes). It stops generation and drops the session to free its memory.
	if (text.toLowerCase().startsWith("/abort")) {
		await handleAbort(chatId);
		return;
	}
	if (text.startsWith("/")) {
		await enqueue(chatId, () => handleCommand(chatId, text));
		return;
	}
	await enqueue(chatId, () => runTurn(chatId, text));
}

/**
 * Stop the current run (if any) and dispose this chat's session — the in-RAM
 * model context / conversation state is released to save memory. The model
 * itself stays loaded in llama-server until a /model switch restarts it.
 */
async function handleAbort(chatId: number): Promise<void> {
	const s = getSession(chatId);
	if (s.agent || s.core) {
		await modeFor(s).abort().catch(() => undefined);
		await disposeMode(s).catch(() => undefined);
	}
	await tg.send(chatId, "🛑 Stopped the current run and cleared this chat's session from memory.");
}

async function handleUpdate(update: TelegramUpdate): Promise<void> {
	if (update.message?.text !== undefined) return handleMessage(update.message);
	if (update.callback_query?.data !== undefined) return handleCallback(update.callback_query);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let tg: TelegramClient;

async function main(): Promise<void> {
	if (!config.botToken) {
		console.error(USAGE);
		process.exit(1);
	}

	tg = new TelegramClient({ token: config.botToken, apiBase: config.apiBase || undefined });
	const me = await tg.getMe();
	console.log(`[bridge] connected as @${me.username ?? me.id}`);

	const baseUrl =
		config.baseUrl || (config.providerId === "llamacpp" ? DEFAULT_LLAMACPP_BASE : "");

	rt = {
		providerId: config.providerId,
		modelId: await resolveModelId(
			config.providerId,
			config.modelId,
			baseUrl || DEFAULT_LLAMACPP_BASE,
		),
		apiKey: config.apiKey || (config.providerId === "llamacpp" ? "llamacpp" : undefined),
		baseUrl: baseUrl || undefined,
		cwd: config.cwd,
		workspaceRoot: config.workspaceRoot,
		systemPrompt: config.systemPrompt,
		maxIterations: config.maxIterations,
		enableTools: config.enableTools,
		autoApprove: config.autoApprove,
	};

	console.log(
		`[bridge] provider=${rt.providerId} model=${rt.modelId || "(auto)"} baseUrl=${rt.baseUrl || "(default)"} mode=${config.defaultMode}`,
	);
	console.log(
		`[bridge] cwd=${rt.cwd} tools=${rt.enableTools ? "on" : "off"} autoApprove=${rt.autoApprove ? "on" : "off"}`,
	);
	console.log("[bridge] send /help to your bot in Telegram to get started");

	let running = true;
	const shutdown = (): void => {
		running = false;
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	while (running) {
		let updates: TelegramUpdate[] = [];
		try {
			updates = await tg.fetchUpdates(config.pollTimeout);
		} catch (error) {
			console.error(
				"[bridge] getUpdates error:",
				error instanceof Error ? error.message : String(error),
			);
			await sleep(3000);
			continue;
		}
		for (const update of updates) {
			void handleUpdate(update);
		}
		tg.acknowledge(updates);
	}

	console.log("[bridge] shutting down…");
	for (const s of sessions.values()) {
		await disposeMode(s);
	}
	console.log("[bridge] stopped");
	process.exit(0);
}

void main().catch((error) => {
	console.error("[bridge] fatal:", error instanceof Error ? error.message : error);
	process.exit(1);
});
