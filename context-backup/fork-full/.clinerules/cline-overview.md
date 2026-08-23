# Cline CLI + SDK Architecture (this fork)

This fork of Cline is **CLI-only**: the VS Code extension, JetBrains plugin, and webview
were removed. What remains is the CLI, the hub dashboard, and the SDK packages. There is
**no gRPC/protobuf layer and no webview UI**.

## Repo layout

```
apps/
  cli/          # The CLI: interactive TUI, headless/one-shot runs, agents, scheduling,
                # MCP, connectors, ACP, wizards
                # (src subdirs: acp, commands, connectors, logging, runtime, session,
                #  tests, tui, utils, wizards)
  cline-hub/    # Hub dashboard + daemon (auto-spawned by the CLI)
  examples/     # Example apps using the SDK
sdk/
  packages/
    shared/     # Shared types, storage (paths), hooks, VCR (fetch record/replay),
                # mcp, feature flags, node/browser entrypoints
    llms/       # LLM provider layer: vendors (anthropic, openai, bedrock, google,
                # vertex, ollama, lmstudio, deepseek-web, llamacpp, ...), AI SDK
                # dispatch (ai-sdk.ts), model catalog, types
    core/       # Core runtime: session loop, tools, hooks, providers (incl.
                # local-provider-service), storage services, telemetry, hub daemon,
                # multi-agent, cron, connectors
    agents/     # Multi-agent orchestration
    sdk/        # SDK entry point (re-exports)
    ui/         # UI components (hub dashboard / examples)
```

## How a request flows

```
cline (apps/cli/src/index.ts)
  -> @cline/core runtime (session loop, tool execution, hooks, providers)
    -> @cline/llms provider (dispatch via family, e.g. "openai-compatible")
      -> streaming response back to the TUI / session
```

## Key concepts

- **Provider id != family.** The LLM dispatch in `sdk/packages/llms/src/providers/vendors/ai-sdk.ts`
  routes by family ("anthropic", "openai-compatible", ...) but individual providers are
  identified by `id` at runtime. Custom providers registered with `addLocalProvider`
  (family "openai-compatible") appear in the provider picker automatically.
- **Everything is file-backed.** Settings/state/secrets live under `~/.cline/`
  (override via `setClineDir`; see @.clinerules/storage.md).
- **Hooks** run at lifecycle/tool points (TaskStart, PreToolUse, PostToolUse, ...) —
  implemented in `sdk/packages/core/src/hooks/`, configured via `.clinerules/hooks/`
  (see `hooks/README.md`).
- **The hub daemon** (`@cline/cline-hub`) is auto-spawned by the CLI; it hosts sessions,
  telemetry, and the dashboard.
- **SDK packages export `dist/` only.** Always `bun run build:sdk` after SDK source
  changes (see @.clinerules/bun-and-node.md).
- **`@cline/core` re-exports `@cline/llms` as the `Llms` namespace.**

## This fork's additions (vs upstream)

- **`llamacpp` provider**: local llama.cpp inference with auto-download of
  `llama-server` + a default model, auto-start/restart, and a TUI setup wizard
  (folder scan → pick `.gguf` → context size preset, with GGUF metadata read to
  suggest the model's real max context). Multiple concurrent servers as named
  profiles (`llamacpp`, `llamacpp-<name>`), each on its own port — see
  `sdk/packages/llms/src/providers/vendors/llamacpp-runtime.ts`.
- **`bun install` auto-adds `cline`/`clinemin` PowerShell profile functions**
  (`sdk/scripts/setup-cli-alias.ts`, wired as the root package.json `postinstall`)
  so the CLI can be launched from any project folder.

## Conventions

- Single entry point — the CLI runs through `apps/cli/src/index.ts`.
- Avoid `as` casts at SDK boundaries; prefer explicit conversion functions with tests.
- Use `{appBaseUrl}` for web URLs, never hardcode the app host.
