# Cline Telegram Bridge

Text a Telegram bot and drive a **local AI over llama.cpp** through the Cline
SDK. Two switchable modes, chosen per chat with `/mode`:

| Mode | Runtime | What you get |
|------|---------|--------------|
| `agent`     | SDK `Agent.run()` / `Agent.continue()` | Lightweight, stateless-per-conversation chat. No tools. |
| `clinecore` | SDK `ClineCore` (persistent sessions)   | Real work: built-in tools (read/search files, edit, run commands) with **inline-keyboard tool approvals** straight in Telegram. |

Beyond chatting, the bridge ships **persistent project folders**, **model
switching** right from Telegram, and a Windows **auto-start launcher** so it
connects and keeps listening every time you run the CLI (see below).

This example reuses the repo's own approach to Telegram (Bot API long-polling,
plain-text replies with link previews disabled) and drives Cline's built-in
[`llamacpp`](../../../sdk/packages/llms/src/providers/builtins.ts) provider, so
there is nothing Ollama/LM Studio specific here — it is llama.cpp-native.

## How llama.cpp is used

`CLINE_PROVIDER_ID` defaults to `llamacpp`. Cline's `llamacpp` provider is an
OpenAI-compatible endpoint and is the one local vendor Cline can **fully manage
itself**: if no server is reachable it will download the `llama-server` binary
and a small default GGUF model and start it on `http://127.0.0.1:8080`. That
means you can go from zero to texting a local model without installing anything.

Two ways to point it at llama.cpp:

### Option A — let Cline auto-manage the server (simplest)

```bash
TELEGRAM_BOT_TOKEN=<token> bun run src/index.ts
```

If you don't set `CLINE_MODEL_ID`, the bridge queries the running server's
`/v1/models` to discover the loaded model; if nothing is listening yet it uses
Cline's default model (`qwen2.5-0.5b-instruct-q4_k_m.gguf`), which Cline
auto-downloads on first use.

### Option B — bring your own `llama-server`

Start llama.cpp yourself with an OpenAI-compatible endpoint:

```bash
llama-server -m /path/to/model.gguf --port 8080
```

Then run the bridge (it auto-discovers the served model):

```bash
TELEGRAM_BOT_TOKEN=<token> CLINE_MODEL_ID=my-model.gguf bun run src/index.ts
```

> Tip: `CLINE_MODEL_ID` for llama.cpp is the **`.gguf` filename** the server
> loaded (e.g. `qwen2.5-7b-instruct-q4_k_m.gguf`). Setting it explicitly is
> always the most reliable.

## Quick start

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Build the SDK once (first time only):

   ```bash
   bun install
   bun run build:sdk
   ```

3. Run the bridge from this directory:

   ```bash
   TELEGRAM_BOT_TOKEN=123456:ABC... bun run src/index.ts
   ```

   (Or save the token once in a config file so you never need the env var —
   see [Config file](#config-file).)

4. In Telegram, message your bot: `/mode clinecore`, then send a task. Watch
   tool calls surface as **✅ Approve / ⛔ Deny** buttons.

## Auto-start with the CLI (Windows)

You can have the bridge **connect and keep listening every time you start the
CLI**, from any project folder, with no env vars and no manual `node dist/index.js`.

1. **Save your bot token + chat id once** in `C:\Users\<you>\.cline\telegram-bridge\config.json`:

   ```json
   {
     "token": "123456:ABC...",
     "chatId": "123456789",
     "modelsDir": "D:\\qmn1\\LMStudio\\lmstudio-community"
   }
   ```

   The `chatId` is the number you get from sending `/whereami` to your bot.
   `chatId` is optional — the bridge works without it. `modelsDir` is optional
   too: point it at a secondary folder (e.g. your LM Studio models) so its
   `.gguf` files show up when you send `/model`.

2. **Run the launcher** (or have it run for you — see step 3):

   ```powershell
   & "D:\qmn1\clinemin\apps\examples\telegram-bridge\scripts\start-telegram-bridge.ps1"
   ```

   It is **idempotent**: if the bridge is already running (checked via a live
   pid file in `bridge.pid`) it does nothing; otherwise it spawns `node dist/index.js`
   **detached** (hidden window, logs to `bridge.log` / `bridge.err.log`), so the
   bridge keeps listening to Telegram even after the CLI exits.

3. **Wire it into your shell** so it runs on every launch. The `clinemin` /
   `cline` PowerShell functions already call the launcher before starting the
   CLI:

   ```powershell
   function clinemin {
       & "D:\qmn1\clinemin\apps\examples\telegram-bridge\scripts\start-telegram-bridge.ps1"
       bun --conditions=development "D:\qmn1\clinemin\apps\cli\src\index.ts" -i @args
   }
   ```

   These functions are written to your PowerShell profile by
   `sdk/scripts/setup-cli-alias.ts` (run `bun install` to (re)generate). Now,
   whenever you type `clinemin` in any project, the bridge is started (or
   confirmed already running) and the CLI launches on top of it.

To stop a running bridge, kill the process whose id is in `bridge.pid`:

```powershell
Stop-Process -Id (Get-Content "D:\qmn1\clinemin\apps\examples\telegram-bridge\bridge.pid")
```

## Config file

The bridge reads an optional JSON config file (default
`~/.cline/telegram-bridge/config.json`, override with `CLINE_BRIDGE_CONFIG`)
for the bot `token`, `chatId`, and an optional `modelsDir`. **Env vars always
win** — the file is only a fallback so the auto-start launcher doesn't need
shell env vars:

```json
{
  "token": "123456:ABC...",
  "chatId": "123456789",
  "modelsDir": "D:\\qmn1\\LMStudio\\lmstudio-community"
}
```

`modelsDir` adds a **secondary model folder** to the `/model` picker (e.g. your
LM Studio model library). Its `.gguf` files appear alongside the default
llama.cpp models whenever you send `/model`.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `TELEGRAM_BOT_TOKEN` | — | Bot token from @BotFather (or `TELEGRAM_TOKEN`). Falls back to the config file. |
| `TELEGRAM_CHAT_ID` | — | Restrict the bot to one numeric chat id. Falls back to the config file. |
| `ALLOWED_USER_ID` | — | Restrict the bot to one numeric Telegram user id. |
| `DEFAULT_MODE` | `agent` | Initial mode: `agent` or `clinecore`. |
| `CLINE_PROVIDER_ID` | `llamacpp` | SDK provider id. |
| `CLINE_MODEL_ID` | *(auto)* | llama.cpp: the `.gguf` filename. Auto-discovered if empty. |
| `CLINE_MODELS_DIR` | *(config `modelsDir`)* | Extra directory scanned for `/model` `.gguf` files (falls back to the config file's `modelsDir`). |
| `CLINE_BASE_URL` | `http://localhost:8080/v1` | llama.cpp endpoint. |
| `CLINE_API_KEY` | — | API key (llama.cpp needs none; a placeholder is used). |
| `CLINE_CWD` | `process.cwd()` | Workspace for ClineCore sessions. |
| `CLINE_WORKSPACE_ROOT` | `CLINE_CWD` | Workspace root for ClineCore sessions. |
| `CLINE_PROJECTS_FILE` | `./projects.json` | JSON file for the saved-projects registry. |
| `CLINE_SYSTEM_PROMPT` | — | Custom system prompt. |
| `CLINE_MAX_ITERATIONS` | `40` | ClineCore max agent iterations. |
| `CLINE_TOOLS` | `on` | Built-in tools in clinecore mode. |
| `CLINE_AUTO_APPROVE` | `false` | `true` = auto-approve all tools (careful). |
| `CLINE_BRIDGE_CONFIG` | `~/.cline/telegram-bridge/config.json` | JSON file with `{ token, chatId }`. |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | Custom Bot API base URL. |
| `POLL_TIMEOUT` | `30` | Bot API long-poll timeout (seconds). |

## Telegram commands

```
/help  /start            show help
/mode                    show current mode
/mode agent              switch to lightweight Agent mode
/mode clinecore          switch to full tool-capable mode
/new   /clear            start a fresh conversation (current mode)
/abort                   stop the current run + free this chat's session from memory
/model                   list available models (tap a button to switch)
/model <n>               switch to model #n from the list (or a filename substring)
/projects  /list         list saved project folders (name + path)
/add <folder>            save a project folder (no arg = use the current folder)
/continue <n>  /use <n>  point this chat at project #n (fresh session in that folder)
/delete <n>              remove project #n
/tools [on|off]          toggle built-in tools (clinecore)
/yolo  [on|off]          toggle auto-approve (clinecore)
/status                  show mode, provider, model, cwd, working folder, tools
/whereami                show this chat id
```

Anything else you type is sent to the model.

### Projects

`/add <folder>` registers a folder you work on (e.g. a repo you also open on
desktop) in a JSON registry (`./projects.json`, override with
`CLINE_PROJECTS_FILE`) that survives bridge restarts. `/projects` lists them,
`/continue <n>` switches this chat to a project — a **fresh session rooted in
that folder** — and `/delete <n>` drops one. Each project keeps its own
conversation while the bridge runs.

### Switching models on the fly

`/model` scans the llama.cpp model directory (and any `CLINE_MODELS_DIR` /
config-file `modelsDir` folders — e.g. your LM Studio model library) for
`.gguf` files and shows an inline keyboard; tap a button or send
`/model <number>` / `/model <filename-substring>`. Switching restarts
llama-server with the new model on your next message, which can take a little
while — existing sessions are dropped so the change takes effect.

### Aborting a run

`/abort` is handled **outside** the per-chat queue so it can interrupt a turn
that is currently running. It stops generation and disposes this chat's session
to free its in-RAM model context. The model itself stays loaded in llama-server
until a `/model` switch restarts it.

## How it works

- `src/telegram.ts` — minimal, dependency-free Bot API client (long-polling
  `getUpdates`, `sendMessage`, `editMessageText`, `answerCallbackQuery`,
  inline keyboards).
- `src/stream.ts` — streams one turn: a live-edited preview message while
  tokens arrive, then the full answer chunked to Telegram's 4096-char limit.
- `src/agent-mode.ts` — `Agent` mode (no tools).
- `src/core-mode.ts` — `ClineCore` mode: one persistent session per chat,
  built-in tools, and `requestToolApproval` bridged to an inline keyboard.
- `src/index.ts` — config, per-chat sessions, `/mode` switching, model
  discovery + `/model`, the persistent projects registry, command routing,
  and the polling loop.
- `scripts/start-telegram-bridge.ps1` — idempotent Windows launcher used to
  auto-start the bridge with the `clinemin` CLI.

Per-chat turns are serialized (each chat has its own queue), while callback
queries (approvals) are handled immediately on a separate path so approving a
tool never blocks the poller.

## Security

- The bridge is a local long-polling process: it only runs while your machine is
  up. It is **not** hosted by Telegram.
- In `clinecore` mode the model can inspect and change whatever the current
  project folder (or `CLINE_CWD`) points at. Only switch to a project you intend
  it to touch.
- Set `ALLOWED_USER_ID` or `TELEGRAM_CHAT_ID` to lock the bot to yourself. Use
  `/yolo on` sparingly.
