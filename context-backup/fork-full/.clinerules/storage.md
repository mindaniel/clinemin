# Storage Architecture

Settings, state and secrets are stored in **file-backed JSON stores** under `~/.cline/`
(override the location with `setClineDir(...)` from `@cline/shared/storage`). This is
the shared storage layer used by the CLI and the hub daemon. There is no VS Code
`ExtensionContext` storage in this fork.

## Import path

Import from the package subpath: `@cline/shared/storage` — e.g. `setClineDir`,
`setClineDirIfUnset`, `setHomeDir`, `setHomeDirIfUnset`, `resolveClineDir`,
`resolveClineDataDir`, `resolveGlobalSettingsPath`, `resolveProviderSettingsPath`,
`resolveMcpSettingsPath`, `resolveSessionDataDir`, `resolveDbDataDir`.

## Path resolution (`sdk/packages/shared/src/storage/paths.ts`)

- `resolveClineDir()`: explicit `setClineDir(...)` → `$CLINE_DIR` env var → `~/.cline`.
- `resolveClineDataDir()`: the data root under the cline dir.
- Config directory names: `agents`, `hooks`, `skills`, `rules`, `workflows`, `plugins`
  (the legacy `.clinerules` dir is treated as deprecated `DEPRECATED_CONFIG_DIR`, and
  `.agents` is the legacy agent-skills dir).
- Global (non-workspace) agents/rules/hooks/skills live under `~/Documents/Cline/`
  (`resolveDocumentsClineDirectoryPath()`).

## CLI directory-ordering rule

The CLI accepts `--config <dir>`. It must call `setClineDir(...)` (and `setHomeDir(...)`)
**before** any telemetry capture, otherwise on-disk state (distinct-id, settings, etc.)
lands under the default `~/.cline` instead of the user's chosen config dir. The canonical
pattern is in `apps/cli/src/main.ts`:

```ts
if (configDir) setClineDir(configDir)
setHomeDir(homedir())
captureCliExtensionActivated()   // <-- after dir overrides
```

## File layout

```
~/.cline/
  data/                 # resolveClineDataDir() — global settings, state
  settings/
    providers.json      # per-provider settings (custom providers) — resolveProviderSettingsPath()
    models.json         # model lists for registered custom providers
    cline_mcp_settings.json   # MCP server config — CLINE_MCP_SETTINGS_FILE_NAME
  sessions/             # session data — resolveSessionDataDir()
  db/                   # databases (connectors, cron) — resolveDbDataDir()
  hooks/                # hook logs — ensureHookLogDir()
  workspaces/           # per-workspace state
  llamacpp/             # llama.cpp runtime: binary, default model, server-state-<port>.json
```

## Provider settings (this fork)

Custom/local providers persist per-provider settings via `ProviderSettingsManager` /
`saveLocalProviderSettings` (`sdk/packages/core/src/services/providers/`). First-class
fields: `model`, `baseUrl`, `contextWindow`, `apiKey`, `headers`, `timeout`.

## Adding new storage keys / files

1. Add the path resolver to `sdk/packages/shared/src/storage/paths.ts` (or reuse an
   existing `resolve*` helper) and export it from `storage/index.ts`.
2. Read/write through the file-backed store — no runtime reads against any host API.
3. If it holds secrets, keep it in a mode-0o600 file under the data dir.
