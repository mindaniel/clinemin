# Task: de-duplicate the web vendor providers

Work in `sdk/packages/llms/src/providers/vendors/`. This is a bun workspace; run
everything from the repo root.

## Before you touch anything

The working tree has ~130 uncommitted files. Commit or stash them first, on a
branch. A refactor this wide is not reviewable on top of unrelated churn, and
there is no way back if it goes wrong.

## What is actually there — verify this yourself, do not trust a summary

There are eight vendor files, 17,963 lines total:

    deepseek-web-v2  3008    chatgpt-web  1893
    claude-web       2286    grok-web     1865
    kimi-web         1987    deepseek-web 1775
    gemini-web       1927    qwen-web     1718

Each one drives a real Chrome via the Chrome DevTools Protocol. They were
written by copy-pasting the previous one, so they share large identical blocks.

Shared helpers already live in `./tool-pipeline/`, and every vendor imports from
it: `browser-lock`, `browser-claims`, `browser-path`, `browser-processes`,
`browser-profiles`, `abort`, `chat-target`, `manager-block`, `patch-block`,
`simple-system-prompt`, `tool-dispatcher`, `conversation-logger`,
`previous-user-dedupe`, `injected-reply`, `cdp-execution-context`.

**Read the import block at the top of a vendor file before proposing to extract
anything.** Most helper names you will see used in the body are imports from
`tool-pipeline/`, not local definitions. Extracting one of those produces an
empty re-export file and no benefit.

Also: in each vendor there is a large template literal (in `grok-web.ts` it is
`SEND_MESSAGE_SOURCE`, around lines 470-694) holding plain JavaScript that gets
injected into the page. The `async function` declarations inside it are strings,
not TypeScript. They cannot be imported, only moved as text.

## The two real duplicates

Confirm each with grep before starting, and report the counts you get.

**1. `class CdpClient` — 6 copies** (`grep -ln "^class CdpClient" *.ts`)

Present in chatgpt-web, claude-web, gemini-web, grok-web, kimi-web, qwen-web.
In grok-web it spans roughly lines 214-471 together with its companions
`isEndpointUp`, `connectCdp`, `waitForEndpoint`. About 250 lines each,
~1,500 lines total.

**2. The chat registry — 7 copies** (`grep -ln "function readChatRegistry" *.ts`)

Present in all of the above plus deepseek-web-v2. In grok-web it is roughly
lines 707-823: `readChatRegistry`, `writeChatRegistry`, `lookup*ChatSession`,
`record*ChatSession`, `delete*ChatSession`, `chatKeyFromPrompt`,
`extract*SessionId`, `list*WebChats`. About 115 lines each, ~800 lines total.

This is what the `/findchat` and `/paste` slash commands read, so its behaviour
is user-visible. Treat any change in its output shape as a breaking change.

## Do this

Work on **one** of the two, whichever you pick, and stop when it is done. Do not
attempt both in one pass.

1. Diff the copies against each other before writing anything. Post the diff
   summary. If they have drifted — different timeouts, an extra retry, a vendor
   -specific selector — the differences are the whole problem. Name each one and
   say whether it looks deliberate or accidental. Do not silently pick one
   copy as the winner.
2. Write the shared version into a new file under `tool-pipeline/`
   (`cdp-client.ts` or `chat-registry.ts`). Parameterise the differences that
   are deliberate; take the safest branch for the ones that are accidental, and
   list what you changed for each vendor.
3. Convert vendors **one at a time**. After each one, run the checks below. Do
   not convert the next until the current one is green.
4. `deepseek-web-v2.ts` is the highest-risk file: four vendors import
   `parseFallbackToolUses` from it, and it holds the only substantial test file
   in the folder. Convert it last.

## Checks — all four must pass after every single vendor

    bunx vitest run --root sdk/packages/llms src/providers/vendors
    bunx tsc --noEmit -p sdk/packages/llms
    bunx biome check --write --diagnostic-level=error
    bun run build:sdk

Baseline before you start: 23 files / 300 tests passing. `tsc` is clean on
`llms`. Two biome errors are pre-existing and not yours to fix —
`tool-parser.ts:194` (`noImplicitAnyLet`) and `kimi-web.ts:905`
(`noShadowRestrictedNames`).

Note that `sdk/packages/core` currently has 6 failing tests. They are unrelated
to this folder and were failing before you started. Do not try to fix them and
do not let them mask a regression you caused — check the names match.

Behaviour cannot be fully covered by tests here, because these providers drive a
real browser. So after the mechanical work: `cline hub stop`, rebuild, then
actually send one message through at least two converted vendors and confirm a
reply comes back. A rebuild does nothing to an already-running session.

## Out of scope

Do not split any vendor into a folder of small files yet. Do not rename exports.
Do not touch the system prompt text. Do not reformat files you are not
converting. Decide whether a vertical split is still worth it only after the
duplication is gone and you can see what is actually left.
