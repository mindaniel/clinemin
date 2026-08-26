## Install (no admin required)

Needs Node.js 22+ and [bun](https://bun.sh) (this repo's package manager/runtime — Node alone won't run it). If you already have both, skip to `git clone`.

```powershell
npm install -g bun
git clone https://github.com/mindaniel/clinemin.git
cd clinemin
bun install
bun run build:sdk
```

### No admin rights (no Node/npm installed at all)

If you can't install Node.js system-wide (no admin, locked-down machine), get both tools as portable, per-user installs — no admin, no npm needed.

**bun** — official installer, installs to `%USERPROFILE%\.bun` and adds itself to your user `PATH` automatically:

```powershell
irm bun.sh/install.ps1 | iex
```

**Node.js** — download the portable zip (not the `.msi` installer, which needs admin) from [nodejs.org](https://nodejs.org/en/download) ("Windows Binary (.zip)", 64-bit), extract it somewhere in your user folder (e.g. `C:\Users\<you>\node`), then add it to your user `PATH`:

```powershell
[Environment]::SetEnvironmentVariable("Path", "$env:Path;C:\Users\<you>\node", "User")
```

Open a new terminal so both `PATH` changes take effect, then verify:

```powershell
node -v
bun -v
```

Continue with `git clone` above.

`bun install` also adds `cline` and `clinemin` commands to your PowerShell profile (`$PROFILE`) automatically — open a new terminal and run either one from any project folder:

```powershell
cd path\to\your\project
cline
```

If that doesn't work (e.g. PowerShell's execution policy blocks profile scripts — check with `Get-ExecutionPolicy`, fix with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, no admin needed), run it directly instead:

```powershell
bun --conditions=development "C:\path\to\clinemin\apps\cli\src\index.ts" -i
```

Or add the shortcut yourself — `notepad $PROFILE`, add:

```powershell
function cline {
    bun --conditions=development "C:\path\to\clinemin\apps\cli\src\index.ts" -i @args
}
```

then reload (`. $PROFILE` or a new terminal).

## Update

```powershell
git pull origin main
bun install
bun run build:sdk
```

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

## License

[Apache 2.0 © 2026 Cline Bot Inc.](./LICENSE)
