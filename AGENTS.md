# Cline — CLI-only fork

Personal fork of Cline (`github.com/mindaniel/clinemin`): the VS Code extension, JetBrains
plugin, and webview were removed. Only `apps/cli`, `apps/cline-hub`, and `sdk/packages/*`
remain. Toolchain: **Bun 1.3.13** + **Node >=22**. Never use npm/yarn/pnpm.

## Quickstart

- Run: `bun run cli` (interactive: `bun run cli -i`; one-shot: append a prompt).
  Auto-spawns the `@cline/cline-hub` daemon — don't start it separately.
- Health/version: `bun run cli doctor`, `bun run cli version`.
- Agent turns need an LLM credential: `cline auth` or env vars (`ANTHROPIC_API_KEY`,
  `CLINE_API_KEY`, `OPENROUTER_API_KEY`).
- Build: `bun run build:sdk` after SDK changes (SDK packages resolve through `dist/` only).
- Tests: vitest per package — `bun -F @cline/cli test:unit`, `bun -F @cline/core test:unit`.

## Context

- **Full project reference (architecture, providers, llama.cpp, storage, networking,
  skills, release): read `AI-CONTEXT.md`.**
- Boot rules: `.clinerules/general.md`. Hooks: `.clinerules/hooks/`. On-demand workflows:
  `.clinerules/workflows/*`. Skills: `.cline/skills/*/SKILL.md`, `.agents/skills/*/SKILL.md`.
- Desktop app (optional, Tauri): `apps/examples/desktop-app`.
