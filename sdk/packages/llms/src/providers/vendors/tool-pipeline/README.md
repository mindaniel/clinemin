# Tool-Call Pipeline (`tool-pipeline`)

A self-contained, 3-stage pipeline that safely extracts, validates, and routes
`<tool>...</tool>` calls in LLM responses — used by the **deepseek-web-v2**
provider. It guarantees **zero execution of invalid Python** and routes precise
correction prompts back to the model instead of crashing.

## Stages

| Stage | Module | Responsibility |
|-------|--------|----------------|
| 1. Extract & parse | `tool-parser.ts` | Regex-extract `<tool>` blocks, strip markdown fences, `JSON.parse()` with a `jsonrepair` fallback for syntax sloppiness (commas, quotes, missing brackets, Python constants). Malformed blocks are skipped, never thrown. |
| 2. Python validation | `python-validator.ts` | For `editor.new_text`, stream the code into a real Python interpreter over stdin and run `ast.parse`. Rejects malformed code with a **line-precise** message. Safe fallbacks if no interpreter is found. |
| 3. Dispatch & route | `tool-dispatcher.ts` | Compose 1+2 into an executable tool list. Invalid `editor` calls are dropped and a structured `Tool call rejected: …` retry prompt is produced for the model. |

## Key design decisions

- **JSON repair is envelope-only.** `jsonrepair` runs only on the JSON body
  (`name` / `arguments`); it is never applied to the Python code inside
  `new_text`. We never "fix" logic, variable names, or missing brackets in code.
- **`jsonrepair`, not `json-repair`.** The requested package `json-repair` does
  not exist on the npm registry (404). The canonical, maintained library for this
  exact task is **`jsonrepair`** (`import { jsonrepair } from "jsonrepair"`),
  which handles the required cases: fences, trailing commas, missing quotes,
  Python constants, truncated JSON, etc.
- **Windows `python3` Store-alias trap.** On Windows, `python3` often resolves to
  the Microsoft Store *stub* (`WindowsApps\python3.exe`) which exits `9009` with
  "Python was not found…" even when a real Python exists. `python-validator.ts`
  therefore probes candidates in order — `python3` → `python` → `py` — and skips
  the Store stub's fake failure instead of misreporting it as a syntax error.
- **Validation is AST-syntax-only.** It checks structure (bracket completion,
  loop syntax, indentation), matching the model's system-prompt contract. It does
  not attempt semantic interpretation or auto-repair of code.
- **JSON repair never applies to code** (see AGENTS / safety rules): a malformed
  Python payload is rejected with a line-precise error, and the *model* fixes it.

## Integration

`deepseek-web-v2.ts` reuses its existing `<tool>` parser (which also strips
blocks from visible text and normalizes tool names) and layers the pipeline's
validation on top via `validateToolCalls(...)`. Rejected editor calls are dropped
from the emitted tool list and the `retryPrompt` is surfaced as text so it feeds
back to the model on the next turn.

## Failure detection → feedback routing

The pipeline detects **any** "AI tried to use a tool but failed" and routes a
corrective `retryPrompt` back to the model (no silent skips):

| Failure | Detection | Feedback to model |
|---------|-----------|-------------------|
| `editor.new_text` is invalid Python | AST parse (stage 2) | `Tool call rejected: [Tool: editor] Python syntax error at line X: [msg]. Fix the code structure … emit a corrected <tool> block.` |
| `<tool>` block's JSON is unrepairable | stage 1 `ok:false` | `Tool call rejected: Attempted a <tool> block but its JSON could not be parsed (…). Re-emit it as exactly: <tool>{"name": "...", "arguments": { ... }}</tool> …` |

In every failure the offending attempt is **not** dispatched (never executed or
written to disk); valid sibling tools still run, and the model is told precisely
how to re-emit the rejected call correctly.

## Exports

- `extractToolCalls(rawResponse): ParseResult[]` — stage 1
- `validatePythonCode(code): ValidationResult` — stage 2
- `processResponseForTools(rawResponse): ProcessedResponse` — stage 3 (full)
- `validateToolCalls(calls): ProcessedResponse` — stage 3 (integration entry)
- `hasToolBlock(rawResponse): boolean` — cheap fast-path guard
- `findInvalidUnicode(text)` / `UnsupportedUnicodeError` — stage-2 helper for
  malformed code points

Types: `ParsedTool`, `ParseResult`, `ValidationResult`, `ValidTool`,
`ParsedToolInput`, `ProcessedResponse`.

## Unicode / international-text handling

Non-ASCII text (CJK, accented Latin, emoji) in `new_text` is **fully supported**.
Valid UTF-8 passes validation; well-formed surrogate pairs (e.g. emoji) are not
flagged. Two things the pipeline handles especially:

1. **Literal newlines inside JSON strings.** LLMs sometimes emit real line
   breaks inside a string value (invalid strict JSON). The `jsonrepair` fallback
   in `tool-parser` rewrites them to `\n` escapes, so the `editor` call is
   accepted instead of rejected.
2. **Lone surrogates (corrupted CJK).** If transport splits an international
   character into an orphaned surrogate (`\ud800`–`\udfff`), Node cannot
   UTF-8-encode it, which used to surface as a cryptic internal
   `UnicodeEncodeError: 'surrogates not allowed'` mislabeled as a Python syntax
   error. `validatePythonCode` now **sanitizes** lone surrogates to U+FFFD via
   `sanitizeSurrogates` before parsing — the validator stays non-aggressive and
   only rejects genuinely malformed Python, never correct code carrying a
   transport-split CJK character.

## DeepSeek frequency throttle ("Messages too frequent")

Beyond tool-call validation, this provider also guards against DeepSeek's
anti-abuse rate limit, which shows as:

> Messages too frequent. Try again later.

Two layers address it (see `deepseek-web-v2.ts`):

1. **Randomized pacing before every send.** Each message waits a random
   `[minSendDelayMs, maxSendDelayMs]` (default ~0.8–2.8s) before firing, plus an
   extra random `[toolTurnExtraMinMs, toolTurnExtraMaxMs]` (~1.5–4.5s) on
   tool-request turns (the fastest back-to-back pattern). A fixed delay would
   still look machine-gunned; the range + jitter is deliberately irregular.
   Tune via config.json or `DEEPSEEK_WEB_V2_{MIN,MAX}_SEND_DELAY_MS` and
   `DEEPSEEK_WEB_V2_{TOOL_TURN_EXTRA_MIN,TOOL_TURN_EXTRA_MAX}_MS`.
   `computeSendDelay()` / `randomInRange()` are pure and injectable for tests.

2. **Rate-limit detection + monotonic context.** When a throttled reply
   (`isRateLimitText`) arrives, it is flagged and logged. Critically, DeepSeek
   often DROPS its reported `accumulated_token_usage` after rejecting a message
   (the user-visible "tokens reset to lower"). The provider tracks that number
   **strictly monotonically** (and only resets on a genuinely new chat), so a
   post-rate-limit rollback can't erase the system-prompt re-injection
   thresholds or under-report usage back to the CLI.

3. **No redundant page reloads.** The provider drives the real web UI via CDP.
   It used to call `window.location.href = ...` (a full page reload) before
   *every* message just to ensure it was on the right chat. That reload raced
   the CDP network-capture listener and, on slow connections, produced
   "message was not typed into the composer within 10s" (requiring a re-send).
   `navigateDeepSeekChat` now first checks `isSameChatLocation(currentUrl,
   destination)` and **skips navigation entirely** when the tab is already on
   the correct chat — so follow-up turns of the same conversation reuse the
   already-loaded page with no reload. A real navigation still happens when the
   target chat actually differs (e.g. switching conversations or a brand-new
   chat).

4. **Throttle recovery via a one-shot reload.** Because healthy turns skip
   reloading, that optimization must not strand you on a page DeepSeek
   temporarily blocked. So when a throttled reply is detected
   (`isRateLimitText`), the provider arms `requestThrottleRecoveryReload()`; on
   the very next turn `consumeThrottleRecoveryReload()` forces a real page
   reload even if the URL already matches — clearing the blocked composer so
   you can message normally again. It fires only once, then reloads are skipped
   again until the next throttle.

## Chat recall (`/findchat`)

If a rebuild/restart makes the provider start a new web chat instead of
continuing your history, `/findchat` (a CLI local command) lets you recall and
reopen an existing DeepSeek Web v2 chat in the **same Chrome the provider
drives**:

- `listDeepSeekWebV2Chats()` reads the provider's persisted `chats.json`
  (deepseek-v2-specific for now; generalizable to other web providers later).
- The CLI shows a searchable picker; picking one calls
  `openDeepSeekWebV2Chat(sessionId)`, which reuses the live CDP connection
  (`connectBrowser` / `ensureDeepSeekPage` / `navigateDeepSeekChat`) to navigate
  the existing tab to `/a/chat/s/<session_id>`, so your logged-in history is
  shown and you can continue it.

Both functions are exported from `@cline/llms` for reuse.


## Tests

`tool-pipeline.test.ts` covers parsing, JSON repair, fence stripping, and
Python-validation pass/reject behavior (including the real interpreter path).
