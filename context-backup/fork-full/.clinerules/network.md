# Networking in this fork

The VS Code-era proxy wrapper (`@/shared/net`, `getAxiosSettings`, `mockFetchForTesting`)
was removed with the extension. This CLI-only fork has **no central fetch wrapper** —
SDK and CLI code use `globalThis.fetch` (Node's native fetch) and axios directly, which
is fine for a local CLI.

## Guidelines

1. **Follow existing patterns.** Before adding a network call, look at how nearby code
   does it — e.g. `sdk/packages/core/src/services/llms/` (handler factory, provider
   defaults), `sdk/packages/shared/src/hub.ts`, `sdk/packages/shared/src/mcp.ts`.
2. **LLM providers go through the provider SDKs** (OpenAI/Anthropic/Gemini clients),
   which delegate to the global `fetch` — don't build a parallel HTTP layer inside a
   provider.
3. **Respect env-var conventions** the code already uses: `CLINE_*` for Cline behavior
   (e.g. `CLINE_VCR`, `CLINE_DIR`), and standard `HTTP_PROXY`/`HTTPS_PROXY` where a
   client library supports them.
4. **Tests: use the VCR, not live calls.** `sdk/packages/shared/src/vcr.ts` patches
   `globalThis.fetch` to record and replay HTTP interactions deterministically:
   - `CLINE_VCR=record` — record requests to the cassette file
   - `CLINE_VCR=playback` — replay from the cassette (no real API calls)
   - `CLINE_VCR_CASSETTE` — cassette path (default `./vcr-cassette.json`)
   - `CLINE_VCR_FILTER` — only intercept paths containing this substring; others pass
     through to the real network
   - `CLINE_VCR_INCLUDE_REQUEST_BODY` — `"1"` to save sanitized request bodies
   This catches all HTTP traffic in the codebase, including calls made through the
   OpenAI/Anthropic/Gemini/Vercel AI SDKs (they all delegate to the global fetch).
5. **Timeout & retry** — reuse existing helpers in `@cline/core` services rather than
   hand-rolling per-call retries.

## Verification

If you add a new network call:
1. Match the style of an existing caller in the same area.
2. Don't import utilities that no longer exist (e.g. `@/shared/net`, `@cline/shared/net`).
3. If the call hits an LLM provider, ensure it flows through the provider SDK
   (global fetch) rather than a bespoke HTTP client.
4. Add/adjust a VCR cassette or unit test instead of relying on live network calls.
