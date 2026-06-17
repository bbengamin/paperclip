# Cloudflare Codex Remote — Handoff (2026-06-17)

Continuation of `doc/plans/2026-06-16-cloudflare-codex-remote-handoff.md`. This
captures everything fixed in the 2026-06-17 session so a fresh session can pick
up cleanly.

## Goal

Run Codex Remote agents from local Windows Paperclip into an ephemeral
**Cloudflare sandbox**. The sandbox: starts on demand, joins Tailscale, gets the
local Codex config/auth, reaches the user's `cliproxyapi` provider over
Tailscale, clones a GitHub repo, does the work, and pushes a branch / opens a PR.
**Auth is via the proxy's bearer token — never raw OpenAI/Anthropic keys.**

## Local Context

- Repo: `C:\projects\ai-setup\paperclip`  · branch `adapter-wrapper` (UNPUSHED)
- Server: `http://localhost:3100` · started with `pnpm dev` (background)
- Company: `f97ccce9-522b-42e4-b812-5f83bee99e56`
- Codex Remote agent (DT worker): `cdf3c055-41b5-46a7-9016-82433b86f8ed`
- Cloudflare environment (Claudflare): `7084ebfc-c668-4190-8293-70ba00f2d02e`
- Cloudflare plugin id: `faaa58b5-c84f-4e63-8e67-07deb5d2cb62`
- Test GitHub repo: `https://github.com/lckmain/test-paper` (token embedded in the
  agent's `adapterConfig.remoteGitSandbox.repoUrl`; **revoke that PAT when done**)
- Host Codex config: `C:\Users\Windows\.codex\config.toml`
  (`model_provider = "cliproxyapi"`, base_url `http://100.114.28.103:8317/v1`,
  `experimental_bearer_token`, `requires_openai_auth = false`, `wire_api="responses"`)
- Server dev log (when started via background task): `%TEMP%\paperclip-dev.log`

## How the pipeline works (mental model)

1. Lease a Cloudflare sandbox (plugin `paperclip.cloudflare-sandbox-provider`).
2. `remote-git-sandbox` clones the repo into `/workspace/paperclip`, makes a
   `paperclip/<issue>` branch, sets a git identity, `.git/info/exclude`s
   `.paperclip-runtime/`.
3. Sync a **sanitized** Codex home into `/workspace/paperclip/.paperclip-runtime/codex/home`
   and point `CODEX_HOME` there (project code stays in git — only the few-KB
   Codex config is tar'd in; `syncWorkspace:false`).
4. Start the sandbox callback bridge (sandbox → host Paperclip API), authed by a
   host-signed JWT.
5. `codex exec` runs; cliproxyapi serves the model via the bearer token.
6. Finalize: `git add -A && commit && push` the branch.

## What was fixed this session (commits on `adapter-wrapper`, all authored "Andrii Lutsenko")

- `dce8b8f4` Core: sync managed Codex home into the provider-realized git
  sandbox + set `CODEX_HOME` (was unset → Codex hit `api.openai.com` → 401);
  `syncWorkspace:false`; **Windows tar fix** (pass archive as basename + cwd so
  GNU tar stops parsing `C:\...` as a remote host); cliproxyapi config staleness
  refresh; Cloudflare env-key sanitization (drop `CommonProgramFiles(x86)` etc.);
  `.paperclip-runtime/` git-exclude (prevents pushing `auth.json`/bearer token);
  env-test provider diagnostics.
- `dca7363f` Cloudflare bridge-template + `codex_remote` registration + Windows
  compat (plugin-loader file:// loader, link-plugin-dev-sdk junction fallback) +
  secrets lookup fix + tests + docs.
- `c08b7bea` Fail-fast default `timeoutSec=600` for remote runs (overridable).
- `1e1e95f7` **Plugin worker NODE_OPTIONS fix**: under `pnpm dev` (nested tsx),
  tsx exports `NODE_OPTIONS=--import C:\...loader.mjs`; the forked plugin worker
  inherited that raw `C:\` path → ESM `ERR_UNSUPPORTED_ESM_URL_SCHEME` → plugin
  stuck in `error`. Worker env now sets `NODE_OPTIONS=""`.
- `39e6cfa5` **Send only required config.toml fields to the sandbox** (allowlist):
  keep model/provider keys + `[model_providers.*]`; drop `mcp_servers`,
  `projects`, `plugins`, `marketplaces`, `desktop`, `windows`. Reason: host
  `mcp_servers` (Windows `node_repl.exe`, `space`) don't exist in the sandbox, so
  Codex blocked `startup_timeout_sec` (60–120s) each run.
- `337e569d` **Force HTTP transport** in the sandbox config: inject
  `supports_websockets = false` into each `[model_providers.*]`. Codex defaults
  to a `wss://` Responses transport; the sandbox (userspace Tailscale HTTP proxy)
  can't open it, so Codex retried ~75s before HTTP fallback every run — the
  misleading `failed to refresh available models: timeout waiting for child
  process to exit` (openai/codex#22634). Custom providers honor this flag.

Key files: `packages/adapters/codex-local/src/server/{codex-home.ts,execute.ts,test.ts}`,
`packages/adapter-utils/src/{remote-git-sandbox.ts,sandbox-managed-runtime.ts,command-managed-runtime.ts,execution-target.ts}`,
`server/src/adapters/wrappers/codex-remote.ts`,
`server/src/services/plugin-worker-manager.ts`,
`packages/plugins/sandbox-providers/cloudflare/src/plugin.ts`.

## Verified working

- Env-test diagnostic: real `codex exec` in the sandbox returned `hello` through
  cliproxyapi (bearer auth, Tailscale, no OpenAI).
- A task created `hello.txt`, committed, pushed a branch, and opened a **PR** on
  `test-paper` (after the git-identity fix).

## Known remaining issues / next steps

1. **Live "thinking" UI (deferred, option B).** Sandbox exec output reaches the
   run transcript only as ONE chunk at the very end (no live stream) — UI shows
   "Working…" with nothing during the run. Real fix = thread an incremental
   output callback through the plugin RPC: `packages/plugins/sdk/src/{protocol.ts,worker-rpc-host.ts}`
   → `server/src/services/{plugin-worker-manager.ts,plugin-environment-driver.ts,environment-runtime.ts,environment-execution-target.ts}`
   → cloudflare `plugin.ts` `onOutput` emits instead of only logging. ~6 files,
   affects all plugins, needs a real-run verification.
2. **Embedded Postgres crashes on long sessions.** A ~28-min session died with
   `57P02 ... another server process exited abnormally` (backend crash) taking
   the whole server down. Not an adapter bug — embedded dev Postgres is fragile
   under sustained UI-polling/heartbeat load on Windows. Mitigation: run a real
   Postgres (set `DATABASE_URL` in `.env`, e.g. Docker) for serious use.
3. **Re-verify run speed.** After `39e6cfa5` + `337e569d`, the clone→`thread.started`
   gap should drop from ~5 min to ~30s. NOT yet confirmed with a live run (last
   run was cancelled mid-churn). First thing to test next session.
4. Wandering: agent still does some repo exploration; lean its instructions /
   keep tasks tightly scoped.

## Operational notes (Windows dev)

- **Start server:** `pnpm dev` (runs `dev-runner → dev-watch → server` via tsx).
- **Server hangs at `dev mode: local_trusted` or won't bind:** orphaned
  `postgres.exe` holding the embedded DB shmem. Recipe:
  ```powershell
  Get-Process postgres | Stop-Process -Force
  Start-Sleep -Seconds 15   # let Windows release the shared-memory segment
  Remove-Item "$env:USERPROFILE\.paperclip\instances\default\db\postmaster.pid" -Force -ErrorAction SilentlyContinue
  # then: pnpm dev
  ```
  Don't run two `pnpm dev` at once (port 3100 / 54329 conflict).
- **Plugin stuck in `error` after a fix:** the loader skips `error`-state plugins
  at startup. Force re-activation: `POST /api/plugins/<id>/enable` (or toggle in UI).
- **Cancel a run:** `POST /api/heartbeat-runs/<runId>/cancel`.
- `.env` / `server/.env` hold `PAPERCLIP_AGENT_JWT_SECRET` (signs the sandbox
  bridge callback JWT) — gitignored, required for bridge mode.

## Test commands

```powershell
pnpm --filter @paperclipai/adapter-codex-local exec vitest run --reporter=dot
pnpm --filter @paperclipai/adapter-codex-local build
pnpm exec vitest run packages/adapter-utils/src/remote-git-sandbox.test.ts
# env-test diagnostic (reads remote config, runs a real hello probe):
#   POST /api/companies/<co>/adapters/codex_remote/test-environment
#        body: { adapterConfig: <agent.adapterConfig>, environmentId: <envId> }
```
