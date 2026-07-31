import { exec, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const CONFIG_DIR = path.join(os.homedir(), ".cline", "llamacpp");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const STATE_FILE = path.join(CONFIG_DIR, "server-state.json");
const GITHUB_LATEST_RELEASE_API =
	"https://api.github.com/repos/ggml-org/llama.cpp/releases/latest";

// Small, fast, CPU-friendly default so a first run works with no GPU and modest RAM.
export const DEFAULT_MODEL_NAME = "qwen2.5-0.5b-instruct-q4_k_m.gguf";
const DEFAULT_MODEL_URL =
	"https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf";

export type ProgressCallback = (message: string) => void;

/**
 * Local settings for the auto-managed llama-server that don't have a
 * first-class slot in Cline's provider settings (binary/install locations,
 * port, extra CLI flags, autostart toggle) — the model path and context
 * window DO have first-class slots (`model` / `contextWindow` on the
 * provider settings, set via the TUI setup wizard) and are passed in as
 * `EnsureRunningOverrides` instead. This file lives in its own small JSON
 * config (editable by hand), with env var overrides for scripting/CI.
 */
export interface LlamaCppRuntimeConfig {
	binaryPath?: string;
	modelPath?: string;
	installDir?: string;
	port?: string;
	extraArgs?: string;
	autoStart?: boolean;
}

interface ServerState {
	pid: number;
	modelPath: string;
	port: string;
	extraArgs: string;
}

export interface EnsureRunningResult {
	ok: boolean;
	alreadyRunning: boolean;
	baseURL: string;
	binaryPath?: string;
	modelPath?: string;
	error?: string;
}

function readConfigFile(): LlamaCppRuntimeConfig {
	try {
		return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
	} catch {
		return {};
	}
}

/** Env vars win over the config file, so scripted/CI runs can override without editing files. */
export function resolveRuntimeConfig(): LlamaCppRuntimeConfig {
	const fileConfig = readConfigFile();
	return {
		binaryPath: process.env.LLAMACPP_BINARY_PATH || fileConfig.binaryPath,
		modelPath: process.env.LLAMACPP_MODEL_PATH || fileConfig.modelPath,
		installDir: process.env.LLAMACPP_INSTALL_DIR || fileConfig.installDir,
		port: process.env.LLAMACPP_PORT || fileConfig.port,
		extraArgs: process.env.LLAMACPP_EXTRA_ARGS || fileConfig.extraArgs,
		autoStart:
			process.env.LLAMACPP_AUTOSTART !== undefined
				? process.env.LLAMACPP_AUTOSTART !== "false"
				: (fileConfig.autoStart ?? true),
	};
}

function installDirOf(config: LlamaCppRuntimeConfig): string {
	return config.installDir || CONFIG_DIR;
}

function pickAssetName(): string {
	const plat = process.platform;
	const arch = process.arch;
	if (plat === "win32") return arch === "arm64" ? "bin-win-cpu-arm64.zip" : "bin-win-cpu-x64.zip";
	if (plat === "darwin") return arch === "arm64" ? "bin-macos-arm64.zip" : "bin-macos-x64.zip";
	return "bin-ubuntu-x64.zip"; // linux fallback
}

async function fetchJson<T>(url: string): Promise<T> {
	const res = await fetch(url, { headers: { "User-Agent": "cline-llamacpp" } });
	if (!res.ok) throw new Error(`GitHub API error ${res.status}`);
	return res.json() as Promise<T>;
}

async function downloadToFile(url: string, dest: string, onProgress?: ProgressCallback): Promise<void> {
	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok || !res.body) throw new Error(`Download failed ${res.status}: ${url}`);

	const total = Number(res.headers.get("content-length") || 0);
	let received = 0;
	const fileStream = fs.createWriteStream(dest);

	const reader = (res.body as unknown as ReadableStream<Uint8Array>).getReader();
	await pipeline(
		(async function* () {
			while (true) {
				const { done, value } = await reader.read();
				if (done) return;
				received += value.byteLength;
				if (onProgress && total > 0) {
					onProgress(`${((received / total) * 100).toFixed(0)}%`);
				}
				yield value;
			}
		})(),
		fileStream,
	);
}

/** Ensures a llama-server binary exists locally, downloading the latest release if needed. */
async function ensureLlamaServerBinary(installDir: string, onProgress?: ProgressCallback): Promise<string> {
	const binDir = path.join(installDir, "bin");
	const exeName = process.platform === "win32" ? "llama-server.exe" : "llama-server";
	const exePath = path.join(binDir, exeName);
	if (fs.existsSync(exePath)) return exePath;

	fs.mkdirSync(binDir, { recursive: true });
	onProgress?.("Looking up latest llama.cpp release…");

	const release = await fetchJson<{ assets: { name: string; browser_download_url: string }[] }>(
		GITHUB_LATEST_RELEASE_API,
	);
	const suffix = pickAssetName();
	const asset = release.assets.find((a) => a.name.endsWith(suffix));
	if (!asset) throw new Error(`No llama.cpp release asset found for this platform (${suffix})`);

	const zipPath = path.join(installDir, asset.name);
	onProgress?.(`Downloading ${asset.name}…`);
	await downloadToFile(asset.browser_download_url, zipPath, (pct) => onProgress?.(`Downloading llama.cpp… ${pct}`));

	onProgress?.("Extracting llama.cpp…");
	const AdmZip = (await import("adm-zip")).default;
	new AdmZip(zipPath).extractAllTo(binDir, true);
	fs.unlinkSync(zipPath);

	if (!fs.existsSync(exePath)) {
		throw new Error(`Extracted archive did not contain ${exeName}`);
	}
	if (process.platform !== "win32") fs.chmodSync(exePath, 0o755);
	return exePath;
}

function defaultModelPath(installDir: string): string {
	return path.join(installDir, "models", DEFAULT_MODEL_NAME);
}

/** Default folder the setup wizard suggests before the user has pointed it elsewhere. */
export function defaultModelsDir(): string {
	return path.join(CONFIG_DIR, "models");
}

/**
 * Scans a folder (one level of subfolders deep, matching how LM Studio lays out
 * "modelsDir/publisher/ModelName/*.gguf") for .gguf model files, so users can pick
 * a model without typing a full path. Skips mmproj-* companion files — those are
 * vision projectors, not standalone models. Multi-part files ("...-00002-of-...")
 * are skipped except for part 1, since llama.cpp loads the rest automatically.
 */
export function scanLocalModels(modelsDir: string): string[] {
	const found: string[] = [];
	const isUsableGguf = (name: string) => {
		if (!name.toLowerCase().endsWith(".gguf")) return false;
		if (/^mmproj-/i.test(name)) return false;
		const part = name.match(/-(\d+)-of-\d+\.gguf$/i);
		if (part && part[1] !== "00001") return false;
		return true;
	};

	const scanDir = (dir: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return [];
		}
		return entries;
	};

	if (!fs.existsSync(modelsDir)) return [];
	for (const entry of scanDir(modelsDir)) {
		const full = path.join(modelsDir, entry.name);
		if (entry.isFile() && isUsableGguf(entry.name)) found.push(full);
	}
	for (const entry of scanDir(modelsDir)) {
		if (!entry.isDirectory()) continue;
		for (const inner of scanDir(path.join(modelsDir, entry.name))) {
			const full = path.join(modelsDir, entry.name, inner.name);
			if (inner.isFile() && isUsableGguf(inner.name)) found.push(full);
		}
	}
	return found.sort();
}

/** Ensures a default small model is present locally, downloading it if needed. */
async function ensureDefaultModel(installDir: string, onProgress?: ProgressCallback): Promise<string> {
	const modelPath = defaultModelPath(installDir);
	if (fs.existsSync(modelPath)) return modelPath;

	fs.mkdirSync(path.dirname(modelPath), { recursive: true });
	onProgress?.(`Downloading default model (${DEFAULT_MODEL_NAME})…`);
	await downloadToFile(DEFAULT_MODEL_URL, modelPath, (pct) => onProgress?.(`Downloading model… ${pct}`));
	return modelPath;
}

function readState(): ServerState | null {
	try {
		return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
	} catch {
		return null;
	}
}

function writeState(state: ServerState): void {
	try {
		fs.mkdirSync(CONFIG_DIR, { recursive: true });
		fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
	} catch {}
}

/** Throws if a model path was explicitly configured but doesn't exist, rather than silently
 *  falling back to the auto-downloaded default — a wrong/mistyped path should be a loud error.
 *  `modelOverride` (the provider's saved "model" setting) takes priority over the LLAMACPP_*
 *  env/file config when it's actually a real file — for other providers (or before the
 *  llamacpp setup wizard has ever run) this field holds a non-path catalog id, so a
 *  non-existent override is treated as "no override" rather than an error. */
function resolveModelPath(config: LlamaCppRuntimeConfig, installDir: string, modelOverride?: string): string {
	if (modelOverride && fs.existsSync(modelOverride)) {
		return modelOverride;
	}
	if (config.modelPath) {
		if (!fs.existsSync(config.modelPath)) {
			throw new Error(`Configured model not found: ${config.modelPath}`);
		}
		return config.modelPath;
	}
	return defaultModelPath(installDir);
}

function resolveBinaryPath(config: LlamaCppRuntimeConfig): string | undefined {
	if (config.binaryPath) {
		if (!fs.existsSync(config.binaryPath)) {
			throw new Error(`Configured llama-server binary not found: ${config.binaryPath}`);
		}
		return config.binaryPath;
	}
	return undefined;
}

async function checkHealth(baseURL: string): Promise<boolean> {
	try {
		const res = await fetch(`${baseURL.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(3000) });
		return res.ok;
	} catch {
		return false;
	}
}

async function waitForHealth(
	baseURL: string,
	timeoutMs: number,
	expectHealthy: boolean,
	onProgress?: ProgressCallback,
): Promise<boolean> {
	const start = Date.now();
	let lastHeartbeat = start;
	while (Date.now() - start < timeoutMs) {
		if ((await checkHealth(baseURL)) === expectHealthy) return true;
		if (expectHealthy && onProgress && Date.now() - lastHeartbeat > 15000) {
			lastHeartbeat = Date.now();
			onProgress(`Still loading model… (${Math.round((Date.now() - start) / 1000)}s) — large models can take a while`);
		}
		await new Promise((r) => setTimeout(r, 400));
	}
	return false;
}

function killPid(pid: number): void {
	try {
		process.kill(pid);
	} catch {}
}

/** Asks the live server what model it actually has loaded (from /v1/models), independent of our own bookkeeping. */
async function getLiveModelId(baseURL: string): Promise<string | null> {
	try {
		const res = await fetch(`${baseURL.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(3000) });
		if (!res.ok) return null;
		const json = (await res.json()) as { data?: Array<{ id: string }> };
		return json.data?.[0]?.id ?? null;
	} catch {
		return null;
	}
}

/** Finds the PID of whatever's listening on a port, but only Windows for now (netstat parsing). */
async function findListeningPid(port: string): Promise<number | null> {
	if (process.platform !== "win32") return null;
	try {
		const { stdout } = await execAsync("netstat -ano -p tcp");
		for (const line of stdout.split("\n")) {
			if (new RegExp(`[:.]${port}\\s`).test(line) && /LISTENING/i.test(line)) {
				const parts = line.trim().split(/\s+/);
				const pid = Number.parseInt(parts[parts.length - 1], 10);
				if (!Number.isNaN(pid)) return pid;
			}
		}
	} catch {}
	return null;
}

/** Confirms a PID is actually llama-server before we touch it — never kill an unidentified process. */
async function isLlamaServerPid(pid: number): Promise<boolean> {
	try {
		const cmd = process.platform === "win32" ? `tasklist /FI "PID eq ${pid}" /FO CSV /NH` : `ps -p ${pid} -o comm=`;
		const { stdout } = await execAsync(cmd);
		return /llama-server/i.test(stdout);
	} catch {
		return false;
	}
}

export interface EnsureRunningOverrides {
	/** Absolute path to a .gguf file, e.g. from the provider's saved "model" setting. Wins over LLAMACPP_MODEL_PATH. */
	modelPath?: string;
	/** Context window in tokens, e.g. from the provider's saved "contextWindow" setting. Becomes `-c <n>`. */
	contextWindow?: number;
}

/** `-c <contextWindow>` (if set) plus whatever's in LLAMACPP_EXTRA_ARGS/config file, as a single string for state comparison. */
function buildExtraArgs(config: LlamaCppRuntimeConfig, overrides: EnsureRunningOverrides | undefined): string {
	const parts: string[] = [];
	if (overrides?.contextWindow && overrides.contextWindow > 0) {
		parts.push("-c", String(Math.round(overrides.contextWindow)));
	}
	if (config.extraArgs) parts.push(config.extraArgs);
	return parts.join(" ");
}

/**
 * Ensures a llama.cpp server is reachable at baseURL, serving the configured
 * model with the configured extra args (context size, threads, etc). The
 * live server's /v1/models response is always checked against what's
 * configured (not just our own state-file bookkeeping), so a mismatch is
 * caught even if the running server predates this tracking or its state
 * file was lost. Only ever kills a process positively identified as
 * llama-server — never anything merely guessed to be listening on the port.
 * The server is intentionally left running after Cline exits.
 */
export async function ensureLlamaCppRunning(
	baseURL: string,
	onProgress?: ProgressCallback,
	overrides?: EnsureRunningOverrides,
): Promise<EnsureRunningResult> {
	const config = resolveRuntimeConfig();
	const installDir = installDirOf(config);

	try {
		const desiredModelPath = resolveModelPath(config, installDir, overrides?.modelPath);
		resolveBinaryPath(config); // throws early if configured but missing
		const desiredPort = config.port || "8080";
		const desiredExtraArgs = buildExtraArgs(config, overrides);

		onProgress?.("Checking for a running llama.cpp server…");
		const isHealthy = await checkHealth(baseURL);

		if (isHealthy) {
			const state = readState();
			const stateMatches =
				!!state &&
				state.modelPath === desiredModelPath &&
				state.port === desiredPort &&
				state.extraArgs === desiredExtraArgs;

			const liveModelId = await getLiveModelId(baseURL);
			const liveMatches = liveModelId === null || path.basename(liveModelId) === path.basename(desiredModelPath);

			if (liveMatches && (!state || stateMatches)) {
				return { ok: true, alreadyRunning: true, baseURL, modelPath: liveModelId ?? desiredModelPath };
			}

			onProgress?.(`Config changed → restarting llama-server with ${path.basename(desiredModelPath)}…`);
			let killedSomething = false;
			if (state) {
				killPid(state.pid);
				killedSomething = true;
			} else {
				const pid = await findListeningPid(desiredPort);
				if (pid && (await isLlamaServerPid(pid))) {
					killPid(pid);
					killedSomething = true;
				}
			}

			if (!killedSomething) {
				return {
					ok: false,
					alreadyRunning: true,
					baseURL,
					modelPath: liveModelId ?? undefined,
					error:
						`A server at ${baseURL} is serving "${liveModelId}", not the configured model ` +
						`"${path.basename(desiredModelPath)}", and it isn't one Cline can safely identify/stop ` +
						`(not llama-server, or already gone). Stop it manually, then retry.`,
				};
			}
			await waitForHealth(baseURL, 10000, false);
		}

		if (config.autoStart === false) {
			return { ok: false, alreadyRunning: false, baseURL, error: "No llama.cpp server reachable and autoStart is disabled." };
		}

		const binaryPath = resolveBinaryPath(config) ?? (await ensureLlamaServerBinary(installDir, onProgress));
		const hasExplicitModel = (overrides?.modelPath && fs.existsSync(overrides.modelPath)) || !!config.modelPath;
		const modelPath = hasExplicitModel ? desiredModelPath : await ensureDefaultModel(installDir, onProgress);

		const port = config.port || "8080";
		const args = [
			"-m",
			modelPath,
			"--port",
			port,
			"--host",
			"127.0.0.1",
			...(desiredExtraArgs ? desiredExtraArgs.split(/\s+/).filter(Boolean) : []),
		];

		onProgress?.("Starting llama-server…");
		// detached on both platforms so the server outlives this process (survives Ctrl+C / exit),
		// and isn't torn down as part of the parent's job object / process group on Windows.
		const child = spawn(binaryPath, args, { stdio: "ignore", detached: true, windowsHide: true });
		child.unref();

		const healthy = await waitForHealth(baseURL, 10 * 60 * 1000, true, onProgress);
		if (!healthy) {
			return { ok: false, alreadyRunning: false, baseURL, binaryPath, modelPath, error: "llama-server did not become reachable within 10 minutes" };
		}

		if (child.pid) writeState({ pid: child.pid, modelPath, port, extraArgs: desiredExtraArgs });

		return { ok: true, alreadyRunning: false, baseURL, binaryPath, modelPath };
	} catch (e) {
		return { ok: false, alreadyRunning: false, baseURL, error: String(e) };
	}
}
