# Context Backup

Contains the previous versions of the AI context files, so you can restore if needed.

## `original-upstream/` — the true originals (extracted from git HEAD)

The exact committed versions from before any edits: the upstream VS Code-era
`.clinerules/*` files and `AGENTS.md`, including the three files later deleted
(`debug-harness.md`, `protobuf-development.md`, `sdk-migration.md`).

Restore everything with:
```powershell
# option 1: from this backup
Copy-Item -Recurse context-backup\original-upstream\.clinerules\* .clinerules\
Copy-Item context-backup\original-upstream\AGENTS.md AGENTS.md

# option 2: straight from git (same content)
git checkout HEAD -- .clinerules AGENTS.md
```

## `fork-full/` — the fork-accurate full rules (pre-trim)

The versions that existed after dropping the VS Code content but BEFORE the
context-length trim (task: "beginning context too long"). These are the
fork-accurate, detailed rules — restore these if the slim boot rules
(`.clinerules/general.md` + `AGENTS.md`) are too thin and you want the full
detail auto-loaded again:

```powershell
Copy-Item -Recurse context-backup\fork-full\.clinerules\* .clinerules\
Copy-Item context-backup\fork-full\AGENTS.md AGENTS.md
```

Note: the current live setup keeps only slim boot rules auto-loaded
(`.clinerules/general.md` ~170 tokens + `AGENTS.md` ~110 tokens) and moved all
detail to `AI-CONTEXT.md` (read on demand).
