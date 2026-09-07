# Task: split the web vendor providers into folders

Work in `sdk/packages/llms/src/providers/vendors/`. Bun workspace; run everything
from the repo root.

`kimi-web` is already done and is the worked example. Read it before starting.

## Why

Each vendor is one 1,700-3,000 line file. Nothing in them is wrong; they are
hard to work in. Finding the SSE parser means scrolling past the injected send
script, and a search for "timeout" hits four unrelated concerns. The goal is
navigability, not line count - the split adds lines, because each file carries
its own imports and a header.

## The one thing that will bite you

Every vendor holds a large template literal, `SEND_MESSAGE_SOURCE`, containing
plain browser JavaScript handed to Chrome via `Runtime.evaluate`. To TypeScript
it is a string: never parsed, never typechecked, never executed by any test.

That makes it the only place in this folder where a refactor can break a
provider completely and leave every check green. It already happened once. The
kimi split involved prefixing `export` onto each top-level declaration so the
new modules could import each other, and the regex matched the `async function`
lines *inside* the template literal too. Chrome received a script with `export`
at top level, threw a SyntaxError before running a line, and typed nothing into
the chat box. Tests, tsc, biome and the build all passed. A person watching a
browser do nothing found it.

`injected-script-guard.test.ts` now fails on that shape. Do not disable it, and
do not "fix" it by narrowing what it scans.

**Never bulk-apply a regex across a vendor file.** Add exports by hand, or
restrict the edit to line ranges you have checked are outside every template
literal.

## Recipe, per vendor

1. Read the section banners (`// -- ... --`). They are the seams; the author
   already grouped the file for you. Follow them rather than inventing cuts.
2. Create `<vendor>/` and move each section into its own file. Suggested names,
   matching kimi so the folders look alike: `config.ts`, `browser.ts`,
   `send-script.ts`, `chat-registry.ts`, `sse.ts`, `navigation.ts`,
   `capture.ts`, `model.ts`.
3. Export what other files in the folder need. **By hand.** See above.
4. Add an import block per file. Run `bunx tsc --noEmit -p sdk/packages/llms`
   and let it name what is missing until clean. Relative imports gain one `../`.
5. Write `index.ts` re-exporting exactly the names the old file exported - check
   `llms/src/index.ts` and the dynamic `import()` in `ai-sdk.ts` for the list.
   `./vendors/<id>` resolves to `index.ts`, so no importer changes.
6. Delete the old `.ts`. Move its test file into the folder and repoint its
   import.
7. Module-level mutable state (`activeCdp`, throttle flags) must live in exactly
   one module and be imported. Two copies means two browsers.

## Checks - all of these, after every single vendor

    bunx vitest run --root sdk/packages/llms src/providers/vendors
    bunx tsc --noEmit -p sdk/packages/llms
    bunx biome check --write --diagnostic-level=error
    bun run build:sdk

Then the one that actually caught the bug above - byte-compare the injected
script against the file you deleted:

    git show HEAD:sdk/packages/llms/src/providers/vendors/<id>.ts > old.ts

and diff the `SEND_MESSAGE_SOURCE` body against `<id>/send-script.ts`. It must
be identical, byte for byte.

Then, and this is not optional: `cline hub stop`, rebuild, and **send one real
message through that vendor**. These providers drive a real browser; no test in
this repo executes the injected script. One vendor per commit, verified before
the next. That is what made the kimi failure recoverable - only one file had
changed, so it took minutes to find.

Baselines: 27 files / 329 tests passing, `tsc` clean on `llms`. One pre-existing
biome error, `tool-parser.ts:194` (`noImplicitAnyLet`), is not yours to fix.
`sdk/packages/core` has pre-existing failures in `compact-session-script`,
`subagent-prompts` (2, both asserting on `CRITICAL TOOL CALLING PROTOCOL`, a
string the web prompt no longer contains) and one in
`session-runtime-orchestrator`. Do not fix them and do not let them mask a
regression - check the names match.

## Order

`deepseek-web-v2.ts` (3,017 lines) benefits most and is the highest risk: four
vendors import `parseFallbackToolUses` from it, and it holds the folder's only
substantial test file. Its barrel must re-export that or four providers break.
Do it last.

The other six - chatgpt, claude, gemini, grok, qwen, deepseek-web - are
straightforward and independent of each other.

## Related work, not part of this

**Horizontal de-duplication.** `class CdpClient` is still copy-pasted in
chatgpt, claude, gemini, grok and qwen (kimi now imports the shared one from
`tool-pipeline/cdp-client.ts`). Converting a vendor is: delete four definitions
(`isEndpointUp`, `CdpClient`, `connectCdp`, `waitForEndpoint`), import from
`tool-pipeline/cdp-client`, add a four-line local `connectCdp` wrapper binding
the provider name. About 165 lines each.

The chat registry is duplicated seven times (~115 lines each) -
`readChatRegistry`, `writeChatRegistry`, `lookup*/record*/delete*ChatSession`,
`chatKeyFromPrompt`, `extract*SessionId`, `list*WebChats`. This is what
`/findchat` and `/paste` read, so treat its output shape as user-visible. The
folder split makes it easier, not harder: in kimi it is now one standalone file.

**Provider rosters.** There are six independent lists of "which providers are
web providers": `isWebChatProvider` (shared/prompt/cline.ts),
`isStatefulWebChatProvider` (core compaction-shared.ts),
`model-tool-routing.ts`, `browser-profiles.ts`, `builtins.ts`, and
`webProviderConfigs` (apps/cli use-local-command-actions.tsx). They have already
drifted: `grok-web` is missing from the CLI one, so `/findchat` shows nothing
and `/paste` claims grok "is not a web provider" - even though `grok-web.ts`
exports `listGrokWebChats` and `deleteGrokChatSession`. About 30 lines total,
and it fixes user-visible bugs.

**Per-provider prompts.** Three prompts reach these providers and none is
per-provider: the web prompt (`SIMPLE_WEB_SYSTEM_PROMPT`, used by chatgpt,
claude, gemini, grok, kimi; deepseek and qwen never opt in and keep the stock
tool-calling prompt), the manager prompt (`buildManagerSystemPrompt`), and the
teammate contract (`subagent-prompts.ts`). Tuning one for Kimi changes it for
Claude.

Build it as shared default plus per-provider override - never three prompts
copied into eight files, which is prose nothing typechecks. Rules if you do it:

- Move the text verbatim first and prove byte-identity with a test before
  changing a word. The prompt text is the user's.
- `MANAGER_EXAMPLE_BODY` / `MANAGER_EXAMPLE_COMMAND` are imported by
  `manager-block.ts`, which refuses to dispatch a block or run a command
  matching them - because a model that echoes its own prompt back would
  otherwise have its worked examples executed, which has happened. A provider
  with different example text must export its own constants and the parser must
  check those too.
- `isStockWebSystemPrompt` keys off `# CRITICAL TOOL CALLING PROTOCOL`. Move the
  text and it silently stops matching, and every provider quietly reverts to the
  stock prompt. Its sibling `BUILT_PROMPT_MARKER` in `subagent-prompts.ts` is
  already broken this way: it looks for that heading, the web prompt does not
  contain it, so the re-wrap guard never fires for web workers. That is what the
  two failing `subagent-prompts` tests are reporting.

## Out of scope

Do not rename exports. Do not change prompt text. Do not reformat files you are
not converting. Do not split `model.ts` further - it is the parse ladder and one
run of `doGenerate`, and the cuts would be arbitrary.
