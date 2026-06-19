# Codex Remote Sandbox Run Lifecycle

Date: 2026-06-18

This note describes one Paperclip heartbeat run that uses the `codex_remote` adapter with a Cloudflare sandbox environment.

## Short Version

Paperclip starts the run. The environment layer asks the Cloudflare provider plugin for a sandbox lease. The `codex_remote` wrapper clones/prepares the Git repo inside that sandbox. The normal Codex adapter then runs Codex inside the sandbox. While Codex is running, sandbox output is streamed back to Paperclip through plugin stream events, and Paperclip API calls from inside the sandbox go through a local reverse callback bridge. When Codex exits, `codex_remote` finalizes git changes, pushes, optionally opens/reuses a PR, then Paperclip records the adapter result and releases or retains the sandbox.

The critical sync paths are:

- Codex stdout/stderr stream: sandbox -> Cloudflare bridge -> Cloudflare plugin -> plugin stream bus -> environment runtime -> adapter `onLog` -> heartbeat run log/UI.
- Paperclip API bridge: Codex curl/fetch inside sandbox -> sandbox-local `127.0.0.1:<port>` bridge server -> queue files in sandbox -> host queue worker -> real Paperclip API.
- Liveness/progress: plugin stream events refresh the pending `environmentExecute` RPC timeout; sandbox bridge activity can also POST `/api/heartbeat-runs/:runId/activity`.

## Main Actors

- Paperclip heartbeat service: decides an issue should run, creates a heartbeat run, calls the selected adapter.
- `codex_remote` wrapper: `server/src/adapters/wrappers/codex-remote.ts`.
- Base Codex adapter: `packages/adapters/codex-local/src/server/execute.ts`.
- Environment runtime: `server/src/services/environment-runtime.ts`.
- Plugin worker manager: `server/src/services/plugin-worker-manager.ts`.
- Cloudflare sandbox provider plugin: `packages/plugins/sandbox-providers/cloudflare/src/plugin.ts`.
- Cloudflare bridge client: `packages/plugins/sandbox-providers/cloudflare/src/bridge-client.ts`.
- Sandbox callback bridge: `packages/adapter-utils/src/sandbox-callback-bridge.ts`.

## Step-by-Step Run Flow

1. Paperclip starts a heartbeat run.

   The run is associated with an issue, agent, company, adapter config, and environment config. The adapter type is `codex_remote`.

2. Paperclip resolves the execution environment.

   For Cloudflare sandbox runs, the environment runtime uses the plugin-backed sandbox provider. It starts or reuses the Cloudflare provider plugin worker, then asks it to acquire/resume a lease.

3. Cloudflare provider plugin creates or resumes the sandbox.

   The provider plugin calls the external Cloudflare Worker bridge with the configured `bridgeBaseUrl` and `bridgeAuthToken`. It passes sandbox options like `sleepAfter`, `keepAlive`, `requestedCwd`, `sessionStrategy`, and `sessionId`.

4. `codex_remote` prepares the git workspace.

   The wrapper derives repo URL, base ref, work branch, and remote cwd. It clones or reuses the repo inside the sandbox and verifies that the workspace is visible from both the main sandbox session and the bridge channel.

5. The base Codex adapter prepares runtime context.

   It builds env vars, prompt, Codex home, skill injection, and sandbox Paperclip API bridge. For sandbox runs, skills are copied into the remote Codex home so Codex can discover them in the sandbox.

6. The sandbox callback bridge starts.

   Paperclip starts two bridge halves:

   - In sandbox: a local HTTP server listening on `127.0.0.1:<port>`.
   - On host/Paperclip side: a queue worker polling request files from the sandbox.

   Codex receives:

   - `PAPERCLIP_API_URL=http://127.0.0.1:<port>`
   - `PAPERCLIP_API_KEY=<bridge token>`
   - `PAPERCLIP_API_BRIDGE_MODE=queue_v1`

   The local server is now supervised and should restart on the same port if it exits.

7. Codex runs inside the sandbox.

   The Codex adapter calls the environment runner. For Cloudflare this becomes a plugin RPC call:

   `environmentRuntime.execute()` -> `pluginWorkerManager.call(pluginId, "environmentExecute", ...)` -> Cloudflare provider plugin -> Cloudflare Worker bridge `/exec`.

8. Cloudflare streams Codex output back.

   Non-bridge commands use streaming exec. The Cloudflare provider emits plugin stream notifications on:

   `environment-execute:<providerLeaseId>`

   Events include stdout/stderr chunks and activity pings.

9. Paperclip receives stream events.

   The plugin worker manager receives `streams.open`, `streams.emit`, and `streams.close`.

   Current console logs to watch:

   - `plugin stream notification received`
   - `subscribed to plugin stream`
   - `publishing plugin stream notification to subscribers`
   - `plugin stream notification has no subscribers`
   - `forwarding plugin environment stream chunk to adapter log`

   Important field: `refreshedRpcTimeouts`. If this is `1`, the stream event refreshed the active `environmentExecute` RPC timeout.

10. Codex reports to Paperclip from inside the sandbox.

   When Codex uses `$PAPERCLIP_API_URL`, the sandbox-local bridge writes request JSON files into the queue. The host worker reads them, forwards to the real Paperclip API, writes response JSON, and the sandbox-local HTTP server returns that response to Codex.

11. Codex exits.

   The base Codex adapter parses JSONL output, usage, session info, summary, and errors.

12. `codex_remote` finalizes git.

   After base Codex returns, the wrapper checks git status, commits if dirty, pushes the work branch, and creates or reuses a GitHub PR when configured.

13. Paperclip records the run result.

   The heartbeat service records final run status, logs, result JSON, session params, and error info if any.

14. Sandbox release/retain happens.

   On success, sandbox should be released/shutdown according to environment release behavior. On failure, current code can retain a failed lease so a retry can continue if the sandbox is still alive.

## Sync Channels We Have Now

### 1. Plugin Stream Channel

Purpose: get live Codex stdout/stderr and keep long `environmentExecute` RPC alive.

Path:

Cloudflare exec streaming -> provider plugin `ctx.streams.emit()` -> plugin worker manager -> in-process subscribers -> environment runtime `input.onLog()` -> heartbeat run log.

Channel name:

`environment-execute:<providerLeaseId>`

What it carries:

- stdout chunks
- stderr chunks
- activity events
- stream open/close

Why it matters:

This is the critical path for "Codex is still working, do not timeout the RPC."

### 2. Sandbox Callback API Bridge

Purpose: allow the sandboxed agent to call Paperclip API even though Paperclip runs on the host.

Path:

Codex -> `PAPERCLIP_API_URL` on sandbox localhost -> sandbox queue file -> host queue worker -> real Paperclip API -> response queue file -> Codex.

What it carries:

- issue reads
- comments
- status PATCHes
- heartbeat activity posts
- any allowlisted Paperclip API route

Important env vars in sandbox:

- `PAPERCLIP_API_URL`
- `PAPERCLIP_API_KEY`
- `PAPERCLIP_API_BRIDGE_MODE=queue_v1`
- `PAPERCLIP_BRIDGE_QUEUE_DIR` is used internally by the bridge server.

### 3. Heartbeat Activity Ping

Purpose: tell Paperclip the sandbox bridge is alive.

Path:

Sandbox-local bridge server -> POST `/api/heartbeat-runs/:runId/activity` through the same queue bridge.

Default interval:

30 seconds.

Configured in:

`packages/adapter-utils/src/sandbox-callback-bridge.ts`

Constant:

`DEFAULT_BRIDGE_ALIVE_PING_INTERVAL_MS = 30_000`

### 4. Git/PR Finalization

Purpose: complete the actual external repo work.

Path:

`codex_remote` wrapper -> sandbox git commands -> push branch -> GitHub API PR create/reuse.

This is not a streaming channel. It happens after Codex exits.

## Timeout Layers

### Codex Remote Adapter Timeout

Default:

300 seconds.

Where:

`server/src/adapters/wrappers/codex-remote.ts`

Constant:

`DEFAULT_REMOTE_TIMEOUT_SEC = 300`

Config knob:

agent adapter config `timeoutSec`.

Behavior:

If `timeoutSec` is missing or disabled, `codex_remote` sets it to 300 seconds. This becomes the main Codex process timeout for remote runs.

### Base Codex Adapter Timeout

Where:

`packages/adapters/codex-local/src/server/execute.ts`

Config knobs:

- `timeoutSec`
- `graceSec`

Current default behavior:

- `timeoutSec` is resolved through `resolveAdapterExecutionTargetTimeoutSec(...)`.
- For remote sandbox targets, unset timeout falls back to 300 seconds.
- `graceSec` defaults to 20 in the server adapter.

### Remote Sandbox Fallback Timeout

Default:

300 seconds.

Where:

`packages/adapter-utils/src/execution-target.ts`

Constant:

`DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC = 300`

This protects sandbox adapter runs when no adapter timeout was explicitly configured.

### Plugin Worker RPC Timeout

Default general RPC timeout:

30 seconds.

Where:

`server/src/services/plugin-worker-manager.ts`

Constant:

`DEFAULT_RPC_TIMEOUT_MS = 30_000`

Important exception:

For `environmentExecute`, Paperclip passes a per-call timeout based on command timeout plus overhead.

### `environmentExecute` RPC Timeout

Formula:

`requested command timeoutMs + 30_000`

Where:

`server/src/services/plugin-environment-driver.ts`

Constant:

`RPC_OVERHEAD_BUFFER_MS = 30_000`

Function:

`resolvePluginExecuteRpcTimeoutMs(...)`

Current example:

If Codex command timeout is 300,000 ms, the plugin RPC timeout is 330,000 ms.

Current stability fix:

Plugin stream progress on `environment-execute:<providerLeaseId>` refreshes this RPC timer. So an actively streaming sandbox command should not hit the RPC timeout just because the total run exceeds 330 seconds.

Console field to watch:

`refreshedRpcTimeouts`

Expected:

`refreshedRpcTimeouts: 1` while the active `environmentExecute` call is receiving progress.

### Cloudflare Provider Command Timeout

Default:

300,000 ms.

Where:

`packages/plugins/sandbox-providers/cloudflare/src/config.ts`

Constant:

`DEFAULT_TIMEOUT_MS = 300_000`

Config knob:

Cloudflare driver config `timeoutMs`.

Behavior:

This is passed to Cloudflare bridge `/exec` unless the caller provides a command-specific timeout.

### Cloudflare Plugin-to-Bridge HTTP Timeout

Default:

300,000 ms.

Where:

`packages/plugins/sandbox-providers/cloudflare/src/config.ts`

Constant:

`DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS = 300_000`

Config knob:

Cloudflare driver config `bridgeRequestTimeoutMs`.

Important detail:

For `/exec`, the HTTP timeout becomes:

`max(bridgeRequestTimeoutMs, requested exec timeoutMs)`

Where:

`packages/plugins/sandbox-providers/cloudflare/src/bridge-client.ts`

Function:

`resolveRequestTimeoutMs(...)`

### Sandbox Callback Bridge Response Timeout

Default:

60,000 ms.

Where:

`packages/adapter-utils/src/sandbox-callback-bridge.ts`

Constant:

`DEFAULT_BRIDGE_RESPONSE_TIMEOUT_MS = 60_000`

Meaning:

When Codex calls `PAPERCLIP_API_URL`, the in-sandbox HTTP server waits up to 60 seconds for the host queue worker to write a response file.

### Sandbox Callback Bridge Host Forward Timeout

Default:

30,000 ms.

Where:

`packages/adapter-utils/src/execution-target.ts`

Code:

`AbortSignal.timeout(30_000)` inside `startAdapterExecutionTargetPaperclipBridge(...)`.

Meaning:

The host queue worker gives the real Paperclip API request 30 seconds.

### Sandbox Callback Bridge Alive Ping Interval

Default:

30,000 ms.

Where:

`packages/adapter-utils/src/sandbox-callback-bridge.ts`

Constant:

`DEFAULT_BRIDGE_ALIVE_PING_INTERVAL_MS = 30_000`

### Sandbox Callback Bridge Poll Interval

Default:

100 ms.

Where:

`packages/adapter-utils/src/sandbox-callback-bridge.ts`

Constant:

`DEFAULT_BRIDGE_POLL_INTERVAL_MS = 100`

Meaning:

Both sides check queue state frequently. This is internal bridge behavior, not the UI refresh interval.

### Sandbox Sleep/Shutdown Window

Default:

`10m`

Where:

`packages/plugins/sandbox-providers/cloudflare/src/config.ts`

Constant:

`DEFAULT_SLEEP_AFTER = "10m"`

Also shown in:

`packages/plugins/sandbox-providers/cloudflare/src/manifest.ts`

Config knob:

Cloudflare driver config `sleepAfter`.

Meaning:

Cloudflare sandbox can sleep after idle time. This is separate from Paperclip run timeout.

## What To Watch In Console Tomorrow

Healthy stream path should show:

1. `subscribed to plugin stream`
2. `plugin stream notification received`
3. `publishing plugin stream notification to subscribers`
4. `forwarding plugin environment stream chunk to adapter log`

For active long runs, `plugin stream notification received` should include:

`refreshedRpcTimeouts: 1`

If you see:

`plugin stream notification received` with `refreshedRpcTimeouts: 0`

then the stream exists, but it is not matched to the pending `environmentExecute` RPC. Likely cause: channel mismatch, lease ID mismatch, or no active pending RPC.

If you see:

`plugin stream notification has no subscribers`

then the plugin stream reached Paperclip, but environment runtime was not subscribed. That means output may keep the RPC alive but not reach the run transcript.

If you see only:

`[plugin] [cloudflare exec stdout] ...`

but no `plugin stream notification received`, then Cloudflare provider logging is working, but `ctx.streams.emit(...)` is not reaching the host.

If Codex says:

`Failed to connect to 127.0.0.1:<port>`

then the sandbox-local callback bridge listener is dead or unreachable. With the supervisor change, check bridge logs for:

`sandbox callback bridge process exited; restarting.`

## Known Failure Modes

### Productive Codex run but Paperclip marks timeout

Root class:

`environmentExecute` RPC timeout fires while sandbox work continues.

Expected prevention now:

Stream events refresh the RPC timer before stream scope validation.

Debug:

Look for `refreshedRpcTimeouts: 1`.

### PR created but Paperclip issue not updated

Root class:

GitHub path worked, but callback API bridge failed when Codex tried to comment/PATCH the Paperclip issue.

Debug:

Look for sandbox curl errors to `127.0.0.1:<port>`, bridge queue errors, or missing host worker responses.

### Output visible in server console but not in run view

Root class:

Cloudflare plugin logger sees stdout, but plugin stream bus or environment runtime subscriber path did not deliver it to adapter `onLog`.

Debug:

Compare:

- `[plugin] [cloudflare exec stdout]`
- `plugin stream notification received`
- `publishing plugin stream notification to subscribers`
- `forwarding plugin environment stream chunk to adapter log`

The first missing line tells you where the sync path broke.

## Safe Knobs To Adjust For Testing

Use these first:

- Agent `timeoutSec`: changes Codex run timeout.
- Cloudflare driver `timeoutMs`: changes provider command timeout.
- Cloudflare driver `bridgeRequestTimeoutMs`: changes plugin-to-Cloudflare-bridge HTTP timeout.
- Cloudflare driver `sleepAfter`: changes sandbox idle sleep behavior.
- `PAPERCLIP_BRIDGE_DEBUG=1`: logs bridge proxy request/response lines into the run log. Use only while debugging because request paths/queries can be sensitive.

Avoid changing first:

- Native Paperclip UI.
- Broad heartbeat service behavior.
- Plugin SDK protocol.

## Current Mental Model

Think of the run as three nested loops:

1. Paperclip run loop: owns run status and final result.
2. Plugin `environmentExecute` loop: owns sandbox command execution and live output.
3. Sandbox callback bridge loop: owns Paperclip API requests from inside the sandbox.

The current critical rule is:

If loop 2 is receiving stream progress, loop 1 must not fail the run with an `environmentExecute` RPC timeout.

The second critical rule is:

If loop 3 dies, Codex may still finish git work, but it cannot reliably comment or mark the Paperclip issue done.

