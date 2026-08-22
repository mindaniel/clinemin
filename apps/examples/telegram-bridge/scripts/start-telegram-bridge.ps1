# Ensures the Cline Telegram bridge is running (idempotent). Safe to call on
# every `clinemin` launch. The bridge is spawned detached, so it keeps listening
# to Telegram even after the CLI exits.
#
# Token resolution order:
#   1. $env:TELEGRAM_BOT_TOKEN
#   2. $env:TELEGRAM_TOKEN
#   3. ~/.cline/telegram-bridge/config.json  ->  { "token", "chatId" }
# If no token is found, the bridge is simply not started (no error).
$ErrorActionPreference = "SilentlyContinue"

$BridgeDir = Split-Path -Parent $PSScriptRoot
$PidFile   = Join-Path $BridgeDir "bridge.pid"
$LogOut    = Join-Path $BridgeDir "bridge.log"
$LogErr    = Join-Path $BridgeDir "bridge.err.log"
$Dist      = Join-Path $BridgeDir "dist\index.js"

# Nothing to launch if the bridge isn't built yet.
if (-not (Test-Path $Dist)) {
	Write-Host "[telegram-bridge] not built ($Dist); skipping auto-start"
	return
}

# Already running? (live pid file pointing at a node process on dist/index.js)
if (Test-Path $PidFile) {
	$old = [int](Get-Content $PidFile -Raw)
	if ($old -gt 0) {
		$proc = Get-Process -Id $old -ErrorAction SilentlyContinue
		if ($proc) {
			$cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$old").CommandLine
			if ($cmd -like "*dist/index.js*") {
				return   # already up
			}
		}
	}
}

# Token: env first, then the bridge config file.
$token = $env:TELEGRAM_BOT_TOKEN
if (-not $token) { $token = $env:TELEGRAM_TOKEN }
if (-not $token) {
	$cfg = Join-Path $env:USERPROFILE ".cline\telegram-bridge\config.json"
	if (Test-Path $cfg) {
		$j = Get-Content $cfg -Raw | ConvertFrom-Json
		if ($j.token) { $token = $j.token }
	}
}
if (-not $token) {
	Write-Host "[telegram-bridge] TELEGRAM_BOT_TOKEN not set; skipping auto-start"
	return
}

$env:TELEGRAM_TOKEN = $token

# Secondary model folder for /model: env var wins, else the bridge config file.
if (-not $env:CLINE_MODELS_DIR) {
	$cfg2 = Join-Path $env:USERPROFILE ".cline\telegram-bridge\config.json"
	if (Test-Path $cfg2) {
		$j2 = Get-Content $cfg2 -Raw | ConvertFrom-Json
		if ($j2.modelsDir) { $env:CLINE_MODELS_DIR = $j2.modelsDir }
	}
}

try {
	$p = Start-Process -FilePath "node.exe" -ArgumentList "dist/index.js" `
		-WorkingDirectory $BridgeDir -WindowStyle Hidden `
		-RedirectStandardOutput $LogOut -RedirectStandardError $LogErr -PassThru
	Set-Content $PidFile $p.Id
	Write-Host "[telegram-bridge] started (pid $($p.Id))"
} catch {
	Write-Host "[telegram-bridge] failed to start: $($_.Exception.Message)"
}
