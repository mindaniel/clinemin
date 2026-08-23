# Project boot rules (auto-loaded every session — keep short)

This file (plus `AGENTS.md`) is the only rule content auto-loaded into the system prompt.
For project details (architecture, providers, llama.cpp, storage, networking, skills,
release), read `AI-CONTEXT.md` at the repo root — re-read it after compaction or when unsure.

## Non-negotiables

- **CLI-only fork of Cline** — no VS Code, no webview, no gRPC/proto. Code:
  `apps/cli` (CLI), `apps/cline-hub` (hub daemon), `sdk/packages/*` (SDK).
- **Use bun for tooling** (`bun install`, `bun run X`, `bunx`, `bun file.ts`), never
  npm/npx. Node is the runtime — leave `node:` imports, `process.versions.node`,
  `engines.node`, `@types/node` alone.
- **SDK resolves through compiled `dist/` only** — after any SDK source change, run
  `bun run build:sdk` before running the CLI or tests. Processes don't hot-reload.
- **Tests are vitest** (no `bun:test`, no mocha): `bun -F @cline/core test:unit`,
  `bun -F @cline/cli test:unit`.
- **Never search `dist/`, `node_modules/`, `coverage/`.** Point `search_files`/grep at
  `sdk/packages/*/src` or `apps/*/src` with `file_pattern="*.ts"`.
- **Avoid `providerId === "..."` string matching** in provider/config plumbing — prefer
  metadata / data-shape logic. If an exception is needed, explain why.
- **Don't create changelog-entry files** on PRs; maintainers curate `CHANGELOG.md` via
  `bun run release`.
- **Git identity is local**: `user.email "shyt2112@gmail.com"`, `user.name "mindaniel"`.

## Additions to this file

High-signal, non-obvious lessons only (interventions, multi-step discoveries, things that
worked differently than expected). Never obvious patterns or things readable from a few
files.
