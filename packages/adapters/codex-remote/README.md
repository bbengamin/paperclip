# @paperclipai/adapter-codex-remote

Runs **Codex inside a remote sandbox** (currently the Cloudflare sandbox
provider) and lets the agent talk back to Paperclip through a file-queue
callback bridge. The agent owns task work, Git, PR creation, comments, and issue
status updates; this adapter owns sandbox setup, the bridge, progress, and clean
finalization.

Adapter type: `codex_remote`. Wired in `server/src/adapters/registry.ts` via
`createCodexRemoteAdapter({ base: nativeCodexRemoteAdapter })`, which adds the
sandbox preflight/verify + remote defaults on top of this package's `execute`.

## Why this is a separate package

Upstream `@paperclipai/adapter-codex-local` is kept **byte-identical to
`origin/master`** so upstream pulls apply conflict-free. All the remote/sandbox
behavior the fork added lives here instead. This package was created as a
**standalone copy** of codex-local (commit `551a26b6`), so it currently
**duplicates** codex-specific helpers (`parse`, `skills`, `quota`, `codex-home`,
`codex-args`, `cli`, `ui`, model lists). Only cross-adapter helpers (callback
bridge, execution-target, remote-git-sandbox, runtime wrapper) are shared via
`@paperclipai/adapter-utils`.

> Planned cleanup (deferred until remote is fully stable): move the generic
> codex helpers into a shared layer and import them from both adapters to drop
> the duplication. Tracked in the project memory `codex-remote-helper-dedup`.

## How a run works (happy path)

1. Acquire/resume a **per-issue** Cloudflare sandbox (see identity below).
2. Verify workspace (main + bridge session), sync a sanitized `CODEX_HOME`
   (provider `config.toml`, no `auth.json`), install it at `/root/.codex`.
3. Start the **callback bridge** (in-sandbox HTTP server + host worker).
4. Preflight, then run `codex exec` in the sandbox; stream stdout back as run
   progress (the live "thinking"/command/finalize UX).
5. The agent calls Paperclip via the bridge (fetch issue context, post comment,
   `PATCH` issue status). When it PATCHes the issue to a terminal status, the
   adapter detects it and **finalizes the run from that disposition** even if
   Codex lingers past a short grace window.

## Stability mechanisms (why runs don't falsely fail)

These were added during the 2026‑06 stabilization (commits `e8fbf9e0`,
`551a26b6`); most live in `@paperclipai/adapter-utils` + the server watchdog:

- **Per-issue sandbox identity** — the Cloudflare provider lease id is
  `pc-env-<env>-i-<hash(issueId)>` (bounded to Cloudflare's 63‑char limit), so
  different issues never share a `/workspace` checkout. Same issue within the
  ~10‑min sleep window reuses the warm sandbox (fast continuation).
- **Dedicated bridge session** — bridge-channel commands run on a
  `<sessionId>-bridge` session so a bridge timeout can't delete the running
  Codex session.
- **No-cwd bridge ops** — bridge queue commands use absolute paths and run with
  no `cd`, so a transiently-missing `/workspace` (container sleep/wake) can't
  death-spiral the worker with `cd: can't cd to ...`.
- **Bounded poll + low retry** — host queue timeout capped at 30s;
  `MAX_CONSECUTIVE_POLL_ERRORS = 3` so a dead sandbox is declared lost quickly.
- **Sandbox-aware watchdog** (`server/src/services/heartbeat.ts`
  `reapOrphanedRuns`) — environment-backed runs that lose liveness get a
  sandbox-specific reason (not "server may have restarted"), one auto-retry, and
  no retry when the linked issue already reached a terminal status.

## Logging

The run log (UI) gets full Codex output via the stream channel. The server
**console** is kept to a readable lifecycle view:
- Per-line `[cloudflare exec stdout]`, plugin stream-notification, and per-chunk
  forwarding logs are at **debug** (still in the debug file log).
- High-frequency UI poll GETs and the bridge liveness-ping `POST .../activity`
  are silenced on success (`server/src/middleware/http-log-policy.ts`).
- `codex_remote timing +Nms: ...` lines remain in the run log as the per-run
  phase timeline.
- Verbose bridge proxy logging is opt-in via `PAPERCLIP_BRIDGE_DEBUG=1`.

## Open items

- **SSE bridge transport** — replace the ~100ms callback-bridge poll with a
  streamed watcher. Building block committed + default-off; see
  `doc/plans/2026-06-21-sse-bridge-transport.md` (deferred — poll is stable).
- **`codex_local` config.toml wrapper** — improve local auth via a wrapper that
  copies `config.toml`/auth into `CODEX_HOME` (separate task; does not touch the
  upstream package).
- **Helper dedup** — see above.
- **Startup latency** — infra is fast (~5s to Codex start); remaining run time
  is dominated by model "thinking", not plumbing.

## Build / test

```sh
pnpm --filter @paperclipai/adapter-codex-remote build
pnpm --filter @paperclipai/adapter-codex-remote exec vitest run
```

Sandbox/bridge changes also require: rebuild `@paperclipai/adapter-utils` and the
Cloudflare plugin, then restart `pnpm dev`. A change to the deployed Cloudflare
**Worker** (`packages/plugins/sandbox-providers/cloudflare/bridge-template`, e.g.
the lease-id scheme) additionally requires `pnpm run deploy` from that directory.
