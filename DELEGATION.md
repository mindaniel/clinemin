# Delegating work to background sessions

How to hand a task to one or more background Cline sessions and steer them,
instead of running everything in one foreground conversation.

The point is division of labour. A large task in a single session burns one
context window, serialises everything, and leaves you watching a wall of tool
calls. Split it, dispatch the pieces, and spend your own attention on reviewing
and redirecting.

## The two commands

```bash
cline --zen -p "<task>"
```

Starts a session in the background hub and exits immediately. Prints the
session id. The hub keeps running the agent loop after the CLI is gone.

```bash
cline send <session-id> "<message>"
```

Sends another turn to that session and prints its reply. Blocks until the turn
finishes.

| Flag | What it does |
| --- | --- |
| `--steer` | Deliver ahead of anything already queued for that session |
| `--force` | Send to a session that was not started with `--zen` (see Approvals) |
| `--json` | Machine-readable result: `text`, `finishReason`, `usage` |

Find ids later with `cline history`, or from the line `--zen` prints on exit.

## The manager pattern

One session (or a person) holds the plan. Workers hold the code.

1. **Split the task** so each piece is independently verifiable — "split
   grok-web into a folder", not "refactor the vendors". A worker that cannot
   tell whether it succeeded will report that it did.
2. **Dispatch** one `--zen` session per piece. Give each the full context it
   needs in the prompt; they do not share a conversation and cannot see each
   other's work.
3. **Steer** with `cline send` as they go. This is the part that did not exist
   before: a background session used to be a single shot.
4. **Collect and review.** Do not trust a worker's own summary of whether the
   build passes. Run `bun run types` and the tests yourself.

### Worked example

```bash
# Dispatch two independent pieces.
cline --zen -p "Split sdk/packages/llms/src/providers/vendors/grok-web.ts into a
folder, following the kimi-web layout. Read SPLIT_PROMPT.md first."
# [zen] ... session 1788975717228_btof5 will continue running in the background.

cline --zen -p "Add a test file for tool-pipeline/cdp-pool.ts covering the
two-profiles-one-process case."
# [zen] ... session 1788975611289_l7v4f ...

# Correct one mid-flight, ahead of whatever it has queued.
cline send 1788975717228_btof5 --steer "Do not delete the old file in the same
commit that adds the folder. Two commits."

# Ask for status.
cline send 1788975611289_l7v4f "What is left?"
```

## Things that will actually bite you

**Only unattended sessions can be steered.** A `--zen` session runs with
`autoApproveTools: true`, because nobody is attached to approve anything.
`cline send` does not attach either — it delivers a turn and reads the reply.
So a session started normally would stop at the first tool call needing
approval and wait for an answer that never comes. `send` refuses those up front
rather than hanging; `--force` overrides it if you know the session is safe (a
read-only run, or one you are watching in another terminal).

**Workers auto-approve every tool call.** That is what makes them unattended,
and it means a worker will happily run destructive commands. Scope their
prompts, and do not point one at a repo with uncommitted work you care about.

**Rebuilding does nothing to a running hub.** After changing anything under
`sdk/`, run `bun run build:sdk`, then `cline hub stop`. The hub restarts on the
next command with the new build. Skipping this is the single most common reason
a fix "did not work".

**One hub serves every terminal.** The providers execute in the hub process,
not in your CLI. Anything the providers keep per-process is therefore shared
across all your sessions — that is the bug class behind the browser-profile and
CDP-pool fixes. If you add per-session state to a provider, it has to be keyed
by session, not stored in a module variable.

**Web providers need one `/profile` per concurrent session.** Two sessions on
the same profile share one Chrome, one tab, and one logged-in account, and will
interleave into the same chat. Make a profile per worker (`/profile new
<name>`), which gets its own user-data-dir and its own debug port. Ports are
spaced 10 apart, so profile *n* puts DeepSeek on `9222 + 10n`.

**`cline history` / `session.list` is history, not a live process list.** A
session id appearing there means it is real, not that it is still warm. Sending
to a cold one asks the hub to pick it back up, the same as resuming from the
TUI.

**A queued prompt may return no text.** If the session has not reached your
message yet, `send` reports it as delivered rather than printing a reply. It is
queued, not lost.

## Limits

- **No approval prompt.** `send` cannot answer an approval request, which is
  why it is scoped to unattended sessions. Attaching for real — subscribing to
  `approval.request` and prompting in the terminal — is a strict superset that
  can be added without changing the command's surface.
- **No cancel.** The hub has `run.abort`, but no CLI surface for it yet.
- **No fan-out.** One id per call. Dispatch and steer several with a shell loop.
- **The send path has not been exercised end to end.** The hub connection,
  session lookup and the approval guard are verified against a live hub; a full
  round trip was not run, because it spends a real provider turn.

## Where this lives

| Piece | File |
| --- | --- |
| `cline send` | `apps/cli/src/commands/send.ts` |
| `--zen` dispatch | `apps/cli/src/runtime/run-zen.ts` |
| Config-free send | `HubSessionClient.sendSessionInput`, `sdk/packages/core/src/hub/client/session-client.ts` |
| Hub-side handler | `handleSessionInput`, `sdk/packages/core/src/hub/server/handlers/run-handlers.ts` |
| Queue vs steer | `sdk/packages/core/src/runtime/turn-queue/pending-prompt-service.ts` |
| Per-session browser profile | `sdk/packages/llms/src/providers/vendors/tool-pipeline/browser-profiles.ts` |
