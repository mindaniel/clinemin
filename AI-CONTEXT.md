# AI Context — Cline CLI fork (full reference)

> **On-demand reference for AI agents.** The system prompt only auto-loads the short boot
> rules in `.clinerules/general.md`. Read this file when a task touches architecture,
> providers, llama.cpp, storage, networking, skills, or release — and re-read it if your
> context was compacted or you're unsure about project conventions.

## What this repo is

Personal fork of Cline (`github.com/mindaniel/clinemin`), **CLI-only**: the VS Code
extension, JetBrains plugin, and webview were removed. There is **no `proto/`, no gRPC,
no webview-ui**. Only `apps/cli`, `apps/cline-hub`, and `sdk/packages/*` remain.
`startchat.txt` at the root is a one-page kickoff summary of the fork's additions.

## Repo layout

```
apps/
  cli/          # The CLI: TUI, headless/one-shot runs, agents, scheduling, MCP,
                # connectors, ACP, wizards (src: acp, commands, connectors, logging,
                # runtime, session, tui, utils, wizards)
  cline-hub/    # Hub dashboard + daemon (auto-spawned by the CLI)
  examples/     # Example apps using the SDK (incl. desktop-app: Tauri v2 + Next.js + Bun sidecar)
sdk/
  packages/
    shared/     # Shared types, storage (paths), hooks, VCR (fetch record/replay),
                # mcp, feature flags, node/browser entrypoints
    llms/       # LLM providers: vendors (anthropic, openai, bedrock, google, vertex,
                # ollama, lmstudio, deepseek-web, llamacpp, ...), AI SDK dispatch
                # (ai-sdk.ts), model catalog, types
    core/       # Core runtime: session loop, tools, hooks, providers
                # (local-provider-service), storage services, telemetry, hub daemon,
                # multi-agent, cron, connectors
    agents/     # Multi-agent orchestration
    sdk/        # SDK entry point (re-exports @cline/llms as Llms)
    ui/         # UI components (hub dashboard / examples)
```

## How a request flows

```
cline (apps/cli/src/index.ts)
  -> @cline/core runtime (session loop, tool execution, hooks, providers)
    -> @cline/llms provider (dispatch via family, e.g. "openai-compatible")
      -> streaming response back to the TUI / session
```

## Tooling: bun = tooling, node = runtime

- **bun**: `bun install` (never npm/npx), `bun run <script>`, `bunx <bin>`,
  `bun <file>.ts`, `bun -F <pkg> <script>` (workspace filter), `bun run --parallel`.
  Root `bun.lock` is the single lockfile for all workspaces; there are no per-package
  npm lockfiles.
- **node** is the runtime — leave alone: `node:` import specifiers,
  `process.versions.node`, `engines.node`, `@types/node`,
  `prebuild-install --target=<node>`, tsconfig `module`/`target` output for Node.
- **Build**: `bun run build:sdk` builds every `sdk/packages/*` package (`bun.mts` + `tsc`).
  `bun -F @cline/cli build` builds the CLI. `bun run check` = biome + build + typecheck
  + publish checks in one go.
- **Tests**: **vitest** everywhere (no `bun:test`, no mocha). Unit:
  `vitest run --config vitest.config.ts`; e2e: `vitest.e2e.config.ts`; interactive:
  `vitest.interactive.e2e.config.ts`. Per package: `bun -F @cline/cli test:unit`,
  `bun -F @cline/core test:unit`. Root: `bun run test:unit` (parallel), `bun run test:e2e`.

## The rule that bites: SDK resolves through dist/

SDK packages (`@cline/shared|llms|agents|core|sdk`) export **compiled `dist/` only** —
their `exports` have no `development` source condition. After changing SDK source you
**must** run `bun run build:sdk` before running the CLI or tests. Running processes do
not hot-reload SDK changes — rebuild and restart.

## Searching the codebase

Skip build output: `sdk/packages/*/dist/`, `node_modules/`, `coverage/`, `build/`.
Point `search_files` at source trees with `file_pattern="*.ts"`, e.g.
`search_files(path="sdk/packages/core/src", regex="...", file_pattern="*.ts")`, or grep
with `--exclude-dir={dist,node_modules,coverage}`.

## Providers

- **Provider id != family.** Many ids (llamacpp, lmstudio, qwen-code, custom) share family
  `"openai-compatible"` for the AI SDK dispatch in
  `sdk/packages/llms/src/providers/vendors/ai-sdk.ts`, distinguished at runtime via
  `context.provider.id`.
- **Custom providers**: `addLocalProvider`
  (`sdk/packages/core/src/services/providers/local-provider-service.ts`) registers
  arbitrary-named providers at runtime (not limited to `BUILT_IN_PROVIDER`); writes
  `providers.json` + `models.json`, calls `registerProvider()`, appears in the picker.
  Use `protocol: "openai-chat"`, `client: "openai-compatible"`.
- Per-provider settings persist via `ProviderSettingsManager` / `saveLocalProviderSettings`
  to `~/.cline/settings/providers.json` (`model`, `baseUrl`, `contextWindow`, `apiKey`,
  `headers`, `timeout`).

## llama.cpp (the fork's main addition)

- Runtime: `sdk/packages/llms/src/providers/vendors/llamacpp-runtime.ts`.
- State file is **per-port** (`server-state-<port>.json`) so named profiles (`llamacpp`,
  `llamacpp-<name>`) don't clobber each other; the port comes from the instance's own
  `baseUrl`, not a shared singleton.
- Env overrides: `LLAMACPP_BINARY_PATH`, `LLAMACPP_PORT`, `LLAMACPP_ARGS`,
  `LLAMACPP_AUTO_START`, `LLAMACPP_MODEL_PATH`.

## Storage

- File-backed JSON under `~/.cline/` (override: `setClineDir` from `@cline/shared/storage`).
  No VS Code ExtensionContext in this fork.
- API (`@cline/shared/storage`): `setClineDir`, `setHomeDir`, `resolveClineDir`,
  `resolveClineDataDir`, `resolveGlobalSettingsPath`, `resolveProviderSettingsPath`,
  `resolveMcpSettingsPath`, `resolveSessionDataDir`, `resolveDbDataDir`.
- Layout: `data/`, `settings/providers.json`, `settings/models.json`,
  `settings/cline_mcp_settings.json`, `sessions/`, `db/`, `hooks/`, `workspaces/`,
  `llamacpp/`.
- CLI ordering rule: call `setClineDir`/`setHomeDir` **before** any telemetry capture
  (canonical pattern in `apps/cli/src/main.ts`).
- Read user-editable config files with `readFileStrippingUtf8Bom` / `stripUtf8Bom` from
  `@cline/shared/node`; DON'T strip BOMs of files passed to tools/models.

## Networking

- **No central fetch wrapper** (the VS Code-era `@/shared/net`/`getAxiosSettings` is gone).
  Use `globalThis.fetch` (Node native) / axios directly. LLM providers go through the
  provider SDKs, which delegate to global fetch.
- Tests: use the **VCR** (`sdk/packages/shared/src/vcr.ts`) — `CLINE_VCR=record|playback`,
  `CLINE_VCR_CASSETTE` (default `./vcr-cassette.json`), `CLINE_VCR_FILTER`,
  `CLINE_VCR_INCLUDE_REQUEST_BODY`. This catches all HTTP traffic including provider SDKs.

## Skills, hooks, workflows (on-demand — not auto-loaded)

- Skills: `.cline/skills/*/SKILL.md` (publish-cli, publish-desktop, publish-extension,
  publish-ui), `.agents/skills/*/SKILL.md` (cline-sdk, create-pull-request, opentui),
  `.claude/skills/*`. Invoke via the `skills` tool; never mention a skill without
  invoking it.
- Hooks: implemented in `sdk/packages/core/src/hooks/`, configured via `.clinerules/hooks/`
  (see `hooks/README.md`).
- Workflows: `.clinerules/workflows/*` (release, hotfix-release, pr-review,
  git-branch-analysis, address-pr-comments, find-pr-reviewers, writing-documentation) —
  load on demand.

## Release & git

- `bun run release` (see `sdk/scripts/release.ts`) drives SDK versioning + publishing;
  CLI publish: `bun -F @cline/cli publish:npm` (dry run: `publish:npm:dry`).
- Contributors don't create changelog-entry files; maintainers curate `CHANGELOG.md` at
  release time.
- Git identity is **local**: `user.email "shyt2112@gmail.com"`, `user.name "mindaniel"`.
- gitleaks pre-commit hook (husky); portable binary at
  `$env:USERPROFILE\tools\gitleaks\gitleaks.exe` — Bash sessions may need
  `export PATH="$USERPROFILE/tools/gitleaks:$PATH"`.

## Known environment caveats (cloud VM)

- `@cline/core` test `src/services/workspace/workspace-manifest.test.ts` fails on cloud VMs
  because git `insteadOf` rules rewrite GitHub remotes — environment artifact, not a bug.
- Some `@cline/cli` e2e assertions may fail on exact tool-listing string formats — pre-existing
  test drift.

