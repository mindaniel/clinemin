# Bun (tooling) and Node (runtime)

This repo uses **bun** for package management and task running, and **Node** as
the execution runtime. Both are correct at the same time; the distinction is the
source of most confusion, so keep it straight before editing scripts, configs,
docs, or comments.

## Use bun for tooling

- `bun install` (never `npm install` / `npm ci`)
- `bun run <script>` (never `npm run <script>`)
- `bunx <bin>` (never `npx <bin>`)
- `bun <file>.ts` to run a TS entrypoint directly (no `ts-node` / `tsx`)
- `bun -F <package> <script>` (aka `bun --filter`) to run a script in one workspace package, e.g. `bun -F @cline/cli typecheck`
- `bun run --parallel ...` for parallel tasks

The root `bun.lock` is the single lockfile for the whole workspace (all
`sdk/packages/*`, `apps/cli`, `apps/cline-hub`, `apps/examples/*`). There are no
per-package npm lockfiles.

## Node is the runtime — do NOT rewrite these to bun

The SDK packages compile to `dist/` JavaScript that runs under Node, and native
modules target the Node ABI. The following are Node runtime/ABI references and are
correct as-is:

| Reference | Why it is Node |
|-----------|----------------|
| `prebuild-install --target=<node version>` | Downloads native `.node` binaries for that Node ABI. |
| `node:` import specifiers (e.g. `node:fs`) | Node builtin module scheme; unrelated to tooling. |
| `process.versions.node`, `engines.node`, `@types/node` | Runtime version probe / declared runtime / its types. |
| tsconfig `module`/`target` output for Node | The compiled `dist/` targets Node, not bun. |

When in doubt, leave it.

## Tests: vitest everywhere

- SDK packages and the CLI use **vitest** — there is no `bun:test` and no mocha.
  Unit: `vitest run --config vitest.config.ts`. E2E: `vitest run --config vitest.e2e.config.ts`
  (and `vitest.interactive.e2e.config.ts` for the interactive CLI).
- Per package: `bun -F @cline/cli test:unit`, `bun -F @cline/core test:unit`, etc.
- From the root: `bun run test:unit` runs each package's unit suite in parallel;
  `bun run test:e2e` runs the core + CLI e2e suites.
- Run tests **after** `bun run build:sdk` when SDK code changed — packages resolve
  through `dist/`, not source.

## Build

- `bun run build:sdk` builds every `sdk/packages/*` package (each runs `bun.mts`, then `tsc` for type declarations).
- `bun -F @cline/cli build` builds the CLI (see `apps/cli/package.json`).
- `bun run check` runs biome checks, builds, typechecks, and publish checks in one go.
