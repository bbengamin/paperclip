# paperclip-plugin-codex-remote

Runs **Codex inside a remote sandbox** (e.g. the `cloudflare-bridge` sandbox
provider) and lets the agent talk back to Paperclip through the runtime API
bridge. The agent owns task work, Git, PR creation, comments, and issue status
updates; this adapter owns sandbox setup, remote `CODEX_HOME` sync, preflight,
and clean finalization.

Adapter type: `codex_remote`.

## A standalone external adapter (no upstream changes)

This is a **fork add-on** packaged as an external adapter. Paperclip loads it
through the adapter-plugin store (`buildExternalAdapters` →
`createServerAdapter()`), so **nothing in upstream Paperclip is modified** — no
edits to `server/src/adapters/registry.ts`, `builtin-adapter-types.ts`, or any
core file. Upstream pulls apply conflict-free.

It is also fully **independent of `codex_local`**: it does not import, extend, or
fall back to the upstream codex-local adapter (an earlier experiment built it on
top of codex-local and was unstable). It ships its own `parse`, `skills`,
`quota`, `codex-home`, `codex-args`, `cli`, `ui`, and model lists, and depends
only on **published** `@paperclipai/adapter-utils` exports.

## Entry points

- `.` → `createServerAdapter()` — the complete `ServerAdapterModule` the host
  loads. Folds the sandbox preflight/verify + remote defaults (`timeoutSec`
  default, `dangerouslyBypassApprovalsAndSandbox`, `remoteWorkspaceSync: false`)
  over the package's base `execute`/`testEnvironment`.
- `./server` — raw building blocks (`execute`, `skills`, `quota`, `sessionCodec`, …).
- `./meta` — isomorphic metadata (`models`, `modelProfiles`, `agentConfigurationDoc`).
- `./ui` — UI helpers (`parseCodexStdoutLine`, `buildCodexRemoteConfig`).
- `./cli` — quota probe CLI.

## Install

Build, then register the package with a Paperclip instance through the adapter
plugin store (Adapters page → install by package name, or a `localPath` record
pointing at this directory's built output):

```text
paperclip-plugin-codex-remote
```

No restart-time wiring is required — the host picks it up via the plugin store
and registers the `codex_remote` adapter type.

## How a run works (happy path)

1. Acquire/resume a **per-issue** sandbox via the configured sandbox provider.
2. Verify the workspace (main + bridge session), sync a sanitized `CODEX_HOME`
   (provider `config.toml`, no `auth.json`), install it at `/root/.codex`.
3. Start the runtime-API bridge so the agent can call Paperclip from inside the
   sandbox.
4. Preflight, then run `codex exec` in the sandbox over the HTTP execution path.
5. The agent calls Paperclip via the bridge (fetch issue context, post comments,
   `PATCH` issue status) and finalizes its own work.

## Configuration

See `agentConfigurationDoc` (exported from `./meta`) for the full field list.

## Not yet included

- **Custom UI run-log parser** — external adapters serve a self-contained,
  zero-dependency worker module at `/api/adapters/:type/ui-parser.js`. The
  package's `parse-stdout` logic isn't yet bundled into that worker-compatible
  form, so the run log uses Paperclip's default rendering until a bundled
  `./ui-parser` export is added. Functionality is unaffected.

## Build / test

```sh
pnpm --filter paperclip-plugin-codex-remote build
pnpm --filter paperclip-plugin-codex-remote exec vitest run
```
