This file is the secret sauce for working effectively in this codebase. It captures tribal knowledge—the nuanced, non-obvious patterns that make the difference between a quick fix and hours of back-and-forth & human intervention.

**When to add to this file:**
- User had to intervene, correct, or hand-hold
- Multiple back-and-forth attempts were needed to get something working
- You discovered something that required reading many files to understand
- A change touched files you wouldn't have guessed
- Something worked differently than you expected
- User explicitly asks to "add this to CLAUDE.md"

**Proactively suggest additions** when any of the above happen—don't wait to be asked.

**What NOT to add:** Stuff you can figure out from reading a few files, obvious patterns, or standard practices. This file should be high-signal, not comprehensive.

## What this repo is

- Personal fork of Cline (`github.com/mindaniel/clinemin`), **CLI-only**. The VS Code extension, JetBrains plugin, and webview were removed. Only `apps/cli`, `apps/cline-hub`, and `sdk/packages/*` remain. There is **no `proto/`, no gRPC, no webview-ui**.
- SDK packages (`@cline/shared|llms|agents|core|sdk`) resolve each other through compiled `dist/` (their `exports` point only at `dist/`, with no `development` source condition). You **must** run `bun run build:sdk` after changing SDK source before running the CLI or tests — imports otherwise fail with missing `@cline/*` / missing `dist/` errors. Running processes do **not** hot-reload SDK source changes: rebuild and restart.
- `startchat.txt` at the repo root is a one-page kickoff summary of the fork's additions and conventions — read it when starting a session.

## Miscellaneous

- The whole repo uses **bun** for package management and task running. Emit `bun run X` / `bun install` / `bunx <bin>` / `bun <file>.ts`, never npm/npx. Node remains the *runtime* — see @.clinerules/bun-and-node.md.
- Avoid provider-specific string matching / hardcoded provider branches when fixing provider/config plumbing. Prefer provider metadata, shared catalog/defaults, explicit protocol/client capabilities, or centralized normalization utilities that apply by data shape rather than `providerId === "..."`. If a provider exception seems necessary, stop and explain why instead of adding ad-hoc string matching.
- Check `package.json` (root and per-package) for available scripts before verifying builds/tests (e.g. `bun -F @cline/cli typecheck`, `bun run test:unit`).
- When reading config files that users may edit, use `readFileStrippingUtf8Bom`, `readFileSyncStrippingUtf8Bom`, or `stripUtf8Bom` from `@cline/shared/node`. DON'T strip byte order marks of user files handled by tools/passed to models.
- When creating PRs, contributors should not create changelog-entry files. Maintainers handle release versioning and changelog curation during the release process (`bun run release`).
- When adding new feature flags, see upstream PR https://github.com/cline/cline/pull/7566 as a reference.
- Additional instructions about making requests: @.clinerules/network.md

## Searching the Codebase — Avoiding Build Output

Build output or generated code produces noisy results with `search_files` / `grep`:

| Path | What it is | Why it's a problem |
|------|-----------|-------------------|
| `sdk/packages/*/dist/` | Compiled SDK output (every package compiles here) | Mirrors `src/` as bundled JS — every search gets duplicate hits |
| `node_modules/` | Dependencies | Huge, not project source |
| `coverage/`, `build/` | Test/build artifacts | Noise |

### How to skip build output

Point `search_files` at the source tree and use `file_pattern`:
```
search_files(path="sdk/packages/core/src", regex="myFunction", file_pattern="*.ts")
```
Or grep with exclusions:
```bash
grep -rn "myFunction" sdk/packages/core/src --include="*.ts" --exclude-dir={dist,node_modules,coverage}
```

When you must inspect compiled output (e.g. verifying a build made it in), read the package's `dist/` or use `grep -oP '.{0,40}myFunction.{0,40}' dist/index.js`.

## Provider plumbing (SDK)

- **Provider id != family.** Multiple provider ids (llamacpp, lmstudio, qwen-code, custom ones) share family `"openai-compatible"` for the AI SDK dispatch in `sdk/packages/llms/src/providers/vendors/ai-sdk.ts`, but are distinguished at runtime via `context.provider.id`.
- **Custom providers** are registered at runtime with `addLocalProvider` (`sdk/packages/core/src/services/providers/local-provider-service.ts`) — not limited to the static `BUILT_IN_PROVIDER` enum. It writes `providers.json` + `models.json` under the settings dir and calls `registerProvider()` so the provider is live immediately and shows up in the CLI's provider picker. Use `protocol: "openai-chat"`, `client: "openai-compatible"` to route through the same code path as builtin openai-compatible providers.
- Per-provider settings persist via `ProviderSettingsManager` / `saveLocalProviderSettings` to `~/.cline/settings/providers.json` (`model`, `baseUrl`, `contextWindow`, `apiKey`, `headers`, `timeout` are first-class fields).

## llama.cpp (the fork's main addition)

- Runtime: `sdk/packages/llms/src/providers/vendors/llamacpp-runtime.ts`.
- State file is **per-port** (`server-state-<port>.json`) so multiple named profiles (`llamacpp`, `llamacpp-<name>`) don't clobber each other; the port an instance manages is parsed from its own `baseUrl`, not a shared config singleton.
- Overrides via env vars: `LLAMACPP_BINARY_PATH`, `LLAMACPP_PORT`, `LLAMACPP_ARGS`, `LLAMACPP_AUTO_START`, `LLAMACPP_MODEL_PATH`.

## Git & hooks

- Git identity for this repo is **local** (not global): `user.email "shyt2112@gmail.com"`, `user.name "mindaniel"`.
- gitleaks pre-commit hook is required (husky). Portable binary is at `$env:USERPROFILE\tools\gitleaks\gitleaks.exe`; Bash tool sessions may need `export PATH="$USERPROFILE/tools/gitleaks:$PATH"` since they don't always inherit the Windows PATH update.
- Always run `bun run build:sdk` after sdk-side changes, and `bun -F @cline/cli typecheck` (plus `bun -F @cline/llms typecheck`) before considering a change done.
