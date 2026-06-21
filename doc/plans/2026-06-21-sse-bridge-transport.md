# SSE / stream-discovery transport for the Codex Remote callback bridge

Date: 2026-06-21
Status: **scaffolding committed, default-off, not yet wired** (intentional WIP — not dead code)

## Why

The sandbox→Paperclip callback bridge currently discovers new requests by
**polling**: the host runs a remote `listJsonFiles` (`ls`) over the Cloudflare
exec RPC every ~100ms per run — roughly **3,000 RPC calls per 5-minute run**
just to check for work. That is the main remaining inefficiency in the bridge.

Replacing discovery with a single long-lived **stream** (SSE-style) cuts host→
sandbox RPCs from ~10/sec to ~1 stream + ~1 call per actual API request.

### Is it worth doing? (decision 2026-06-21)

Deferred. After the stability fixes (poll-timeout cap, dedicated bridge session,
no-cwd queue ops, retry-count→3) the polling bridge is **stable**, so SSE is now
an efficiency/scale upgrade, not a fix. Revisit when any of these appear:
- Cloudflare RPC **cost/volume** becomes noticeable.
- **Many concurrent runs** (e.g. 10 agents ≈ 100 RPC/sec continuous) cause
  rate-limit / connection pressure.
- Poll-related flakiness recurs.

Note: the SSE streaming *primitive itself already ships and is active* — Codex
stdout (the live "thinking"/progress UX) streams over SSE today via
`consumeExecuteEventStream` in the Cloudflare bridge client. Only the **callback
bridge** still polls.

## What already exists (committed `88dbe1e3`, `@paperclipai/adapter-utils`)

In `packages/adapter-utils/src/sandbox-callback-bridge.ts`:
- `getSandboxCallbackBridgeWatcherSource()` — in-sandbox Node watcher that emits
  each new request basename exactly once (record-separator `0x1e` framed,
  base64), **without unlinking** — the host still reads/forwards/removes via the
  queue client, so request handling is identical to poll mode.
- `SandboxCallbackBridgeStreamDiscovery` interface + frame constants
  (`SANDBOX_CALLBACK_BRIDGE_WATCHER_ENTRYPOINT`,
  `SANDBOX_CALLBACK_BRIDGE_STREAM_FRAME_PREFIX`).
- `startSandboxCallbackBridgeWorker({ ..., streamDiscovery? })` — when
  `streamDiscovery` is provided the poll loop is bypassed and requests are
  driven off the stream through the shared `processRequestFile` path (with
  de-dupe + clean stop). Default-off: no production caller passes it.
- Unit test: "processes requests pushed via stream discovery instead of polling"
  drives stream mode end-to-end over the filesystem queue client.

## What remains to finish (task #13)

1. **`streamDiscovery` implementation** (in `execution-target.ts`,
   `startAdapterExecutionTargetPaperclipBridge`): upload the watcher source to an
   asset path, run it as a **streaming** exec via the runner with an `onLog`
   handler, parse RS-framed (`0x1e`) base64 lines → `onFileName`. Handle
   stop (kill the watcher via a pid file) and reconnect on stream drop. Pass the
   resulting `streamDiscovery` to `startSandboxCallbackBridgeWorker`.
2. **Cloudflare plugin `bridge_stream` channel** (`plugin.ts`): a marker that
   selects the **bridge session** AND enables streaming. Today
   `PAPERCLIP_SANDBOX_EXEC_CHANNEL=bridge` → bridge session + *non-streaming*;
   add `bridge_stream` → bridge session + streaming. The worker already honors
   `streamOutput` + `sessionId`, so **no worker (bridge-template) redeploy is
   expected** — verify.
3. **Flag**: select stream vs poll via `PAPERCLIP_BRIDGE_TRANSPORT` (default
   `poll`). Keep poll as the safe fallback.
4. **Live validation**: confirm a streaming exec on the **bridge session**
   delivers stdout to the host adapter's `onLog` in real time (the only unproven
   piece — the existing streaming path is only exercised for the *main* session
   today). Best done with the dev server up, watching a real run.

## Acceptance

- With `PAPERCLIP_BRIDGE_TRANSPORT=sse`, a live Codex Remote run completes (post
  comment, mark issue done, finalize) with the bridge driven by the stream and
  **no continuous `listJsonFiles` RPCs** in logs.
- Default (`poll`) behavior is unchanged.
- RPC volume per run drops from ~10/sec to ~1 stream + per-request calls.
