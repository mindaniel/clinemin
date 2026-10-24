## Install (Windows, no admin needed)

Paste this into PowerShell. It installs bun and a portable Node.js 22 for your account only, skipping
any step that is already done, then builds clinemin.

```powershell
# Allow scripts for your account, so bun and npm can run
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force

# bun (runs this repo)
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { irm bun.sh/install.ps1 | iex }

# Node.js 22+ as a portable zip in %USERPROFILE%\node (newer LTS versions: nodejs.org/en/download)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    $v = "v22.14.0"
    Invoke-WebRequest "https://nodejs.org/dist/$v/node-$v-win-x64.zip" -OutFile "$env:TEMP\node.zip"
    Expand-Archive "$env:TEMP\node.zip" $env:USERPROFILE -Force
    Rename-Item "$env:USERPROFILE\node-$v-win-x64" "$env:USERPROFILE\node"
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$env:USERPROFILE\node", "User")
}

# Pick up the new PATH in this terminal
$env:Path = [Environment]::GetEnvironmentVariable("Path", "User") + ";" + [Environment]::GetEnvironmentVariable("Path", "Machine")

# Get and build clinemin
git clone https://github.com/mindaniel/clinemin.git
cd clinemin
bun install
bun run build:sdk
```

`bun install` adds a `cline` command to your PowerShell profile. Open a new terminal, go to any
project and run it:

```powershell
cd path\to\your\project
cline
```

<details>
<summary><code>cline</code> not found?</summary>

Run it directly:

```powershell
bun --conditions=development "C:\path\to\clinemin\apps\cli\src\index.ts" -i
```

Or add the shortcut yourself: run `notepad $PROFILE`, paste this, then open a new terminal.

```powershell
function cline {
    bun --conditions=development "C:\path\to\clinemin\apps\cli\src\index.ts" -i @args
}
```

</details>

## Update

```powershell
git pull origin main
bun install
bun run build:sdk
```

## Manager mode

`/manager` runs the session as a manager: it delegates every step to the workers in `.cline/team.json` and does no work itself. `/manager <task>` goes straight in, and `/manager off` leaves again.

Both directions rebuild the system prompt, and a system prompt is fixed for the life of a session — so each switch restarts the session and clears the conversation. `/manager off` asks first. Start a manager at the top of a chat, not halfway through one.

## Keyboard shortcuts

No need to memorize these: `Ctrl+P` opens the command palette, which lists every command with its shortcut, and `Alt+K` opens help. On Windows and Linux, `Opt` means `Alt`.

While the agent is running, `Esc` aborts it — except when you have a queued message selected or are editing one, where `Esc` belongs to the queue. Use `Ctrl+X` to halt the run at any time; the queued-message hint line says so too.

| Shortcut | Action | Shortcut | Action |
|---|---|---|---|
| `Opt+S` | Settings | `Opt+Z` | Auto-compaction limit (`/autocompact`) |
| `Opt+M` | Change model | `Opt+J` | Manager mode (`/manager`) |
| `Opt+P` | Change provider | `Opt+O` | Workers (`/workers`) |
| `Opt+C` | MCP servers | `Opt+I` | Find web chat (`/findchat`) |
| `Opt+G` | Plugins | `Opt+V` | Paste model reply (`/paste`) |
| `Opt+A` | Account | `Opt+N` | Continuation note (`/note`) |
| `Opt+X` | Compact context | `Opt+E` | Browser profile (`/profile`) |
| `Opt+W` | Skills | `Opt+T` | Telegram (`/telegram`) |
| `Opt+R` | Fork session | `Opt+H` | Session history |
| `Opt+U` | Restore checkpoint | `Opt+K` | Help |
| `Opt+L` | New session | `Opt+Q` | Exit |

## Using llama.cpp

Open the provider picker (`Ctrl+P` → Change Provider), select **llama.cpp**. First prompt triggers the download (binary + a small default model, one-time). To point it at your own models: `Ctrl+P` → Change Provider, then set `LLAMACPP_MODEL_PATH`.

Config lives in `~/.cline/llamacpp/` (binary, default model, server state). Advanced overrides (binary path, port, extra `llama-server` flags, autostart toggle) via env vars: `LLAMACPP_BINARY_PATH`, `LLAMACPP_PORT`, `LLAMACPP_ARGS`, `LLAMACPP_AUTO_START`.

## Other providers

Anthropic, OpenAI, Gemini, Bedrock, Vertex, OpenRouter, Ollama, LM Studio, and any OpenAI-compatible endpoint all still work — pick from the same provider list.

## Rules, skills, MCP

Project-specific rules in `.clinerules/`. Skills let the model load specific instructions on demand. MCP servers connect to databases, APIs, or custom tools — manage with `cline mcp`.

## Multi-agent, scheduling, chat integrations

```bash
cline --team-name auth-sprint "Plan and implement user authentication with tests"
cline schedule create "PR summary" --cron "0 9 * * MON-FRI" --prompt "List all open PRs" --workspace /path/to/repo
cline connect telegram -k $BOT_TOKEN
```

## Headless / CI

```bash
cline "Run tests and fix any failures"
git diff origin/main | cline "Review these changes for issues"
cline --json "List all TODO comments" | jq -r 'select(.type == "agent_event" and .event.text) | .event.text'
```

### Scripting a multi-turn conversation

A script can hold one conversation across many runs. The first run's `run_result`
line carries `sessionId`; pass it back with `--id` and the run continues that
session (history reloaded, one turn, exit) instead of opening the TUI:

```bash
cline -P deepseek-web-v2 -m deepseek-chat --json "Remember: kiwi"          # -> run_result.sessionId
echo "What did I ask you to remember?" | cline -P deepseek-web-v2 --json --id <sessionId> "Answer below."
```

On a web provider the resumed turn goes into the **same browser chat**, so the
model keeps its memory and only the new message is sent. Notes:

- Long input goes through stdin (Windows caps a command line at 32k chars). With
  `--json`, cline still wants a quoted prompt argument of more than one word; it
  is joined in front of stdin.
- `--zen` + `--id` is refused; steer a zen session with `cline send` instead.
- `-s "<system prompt>"` replaces the coding system prompt, which makes cline a
  plain chat client (no tool contract).
- Worked example: the PDF idea-map scripts in
  `OneDrive - University of St Andrews/idea-map/` (`common.py` drives this).

### Long prompts as attached files (DeepSeek and ChatGPT web)

Typing a 100k-char prompt into chat.deepseek.com works, but pasting it is what a
person does, and the page turns a long paste (over ~4k chars) into an attached
`.txt` file. `deepseek-web-v2` can do the same:

```bash
DEEPSEEK_WEB_V2_PASTE_AS_FILE_CHARS=4000 cline -P deepseek-web-v2 "..."   # or "pasteAsFileChars" in ~/.cline/deepseek-web-v2/config.json
```

Only text after a `<<<ATTACH>>>` line is attached; text before it is typed as
the message (nothing after it = type everything). Two things add the marker:

- **Tool results.** When a turn's `Tool result:` blocks together pass the
  threshold, they move behind the marker and the continuation note stays typed
  (`attachToolResults`). The session also gets wide tool-output caps — 200k
  chars per file read (8,000 lines), command, search and tool result, instead
  of 48k / 2,000 lines and the 8k per-result cap in the request builder
  (`WEB_ATTACH_TOOL_OUTPUT_LIMITS` in
  `sdk/packages/core/src/extensions/tools/executors/output-limits.ts`, chosen
  per provider by `resolveToolOutputLimits`). A web chat sends only the new
  message each turn, so the API-cost reason for the tight caps does not apply.
- **Scripts.** A script puts its document after the marker (the idea-map
  scripts send each paper that way).

An unmarked prompt is always typed. Attaching a whole opening turn was tried
and dropped: the model read its own system prompt and tool contract as a
document and answered that it could not run tools.

The paste is a synthetic `ClipboardEvent`; the provider waits until
`file/upload_file` / `file/fetch_files` report the file as `SUCCESS`, then types
the message and sends. Default is 0 (off): always type, default caps. Set it in
`config.json` rather than the environment for TUI sessions, since those run in
the hub process. Code: `deepseek-web-v2/capture.ts` (`attachPromptAsFile`),
shared helpers in `tool-pipeline/paste-attachment.ts`,
`vendors/web-attachments.ts` (`webChatAttachesLongText`).

ChatGPT web does the same with `CHATGPT_WEB_PASTE_AS_FILE_CHARS` (or
`"pasteAsFileChars"` in `~/.cline/chatgpt-web/config.json`). chatgpt.com turns a
paste into a "Pasted text" attachment only past ~6-20k chars, and only while the
account has `file_upload` allowance left: a Free account gets 5 a day, after
which a long paste stays plain text. The provider notices that (no
`/backend-api/files` upload starts) and types the prompt instead. Ready signal:
the `files/process_upload_stream` response ends. Code:
`chatgpt-web/capture.ts` (`attachPromptToChatGPT`).

Things chatgpt.com changed in late 2026 that the provider now handles: the
composer lost its `#prompt-textarea` id (now a `.ProseMirror` div with
`role="textbox"`), and the reply stream is ended by an abort
(`loadingFailed net::ERR_ABORTED`) instead of finishing, so the body is read via
`Network.streamResourceContent` chunks.

To see what a page does, the probes used during development attach to the
provider's Chrome over CDP (`http://127.0.0.1:<debugPort>/json`, DeepSeek 9232,
ChatGPT 9234 with the default profile offsets) and log `Network.*` events while
pasting, without sending.

## License

[Apache 2.0 © 2026 Cline Bot Inc.](./LICENSE)
