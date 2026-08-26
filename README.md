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

If you can't install Node.js system-wide (no admin, locked-down machine), get both tools as portable, per-user installs. No winget, no separate npm download — npm ships inside the Node zip, you just need it on your `PATH`.

**1. Install bun** (installer puts it in `%USERPROFILE%\.bun` and adds that to your user `PATH` on its own):

```powershell
irm bun.sh/install.ps1 | iex
```

**2. Download the Node.js zip** — not the `.msi`/`.exe` installer, that one needs admin to run. Check [nodejs.org/en/download](https://nodejs.org/en/download) for the current LTS version number, then either click the "Windows Binary (.zip)" (64-bit) link there, or download it from PowerShell (replace the version below with whatever's current):

```powershell
Invoke-WebRequest -Uri "https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip" -OutFile "$env:TEMP\node.zip"
```

**3. Extract it into your user profile.** The zip unpacks into a versioned folder name (`node-v22.14.0-win-x64`) — unzip it, then rename that folder to something stable so your `PATH` entry never has to change on a Node upgrade:

```powershell
Expand-Archive -Path "$env:TEMP\node.zip" -DestinationPath "$env:USERPROFILE" -Force
Rename-Item "$env:USERPROFILE\node-v22.14.0-win-x64" "$env:USERPROFILE\node"
```

The `node` folder now has `node.exe`, `npm.cmd`, and `npx.cmd` sitting right in it — that's the whole Node+npm install, nothing else to run.

**4. Add that folder to your user `PATH`** (this only touches your own account's environment, no admin prompt):

```powershell
[Environment]::SetEnvironmentVariable("Path", "$env:Path;$env:USERPROFILE\node", "User")
```

**5. Close the terminal and open a new one** (PATH changes only apply to new terminals), then verify all three:

```powershell
node -v
npm -v
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
