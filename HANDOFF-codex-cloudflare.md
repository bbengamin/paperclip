# Handoff — Cloudflare bridge sandbox + codex_remote adapter (fork)

_Last updated: 2026-06-22. Repo: fork `bbengamin/paperclip` (parent `paperclipai/paperclip`). Author env: Windows._

## 1. Goal / guiding rule

Split two features out of the messy `adapter-wrapper` experiment branch into clean, **upstream-safe** branches so we can keep pulling from `paperclipai/paperclip` without conflicts.

**Hard rule:** never modify original paperclip files on the feature branches. Features plug in only through native extension seams (external adapter store, sandbox-provider plugins). New code lives in new dirs/packages.

## 2. Branches

| Branch | Purpose | State |
|---|---|---|
| `master` | tracks `origin/master` (= all upstream) | clean baseline |
| `adapter-wrapper` | original 2-week experiment | **reference only**, do not merge |
| `cloudflare-bridge` | forked Cloudflare sandbox provider (Tailscale + bridge routes) | pushed → PR #2 |
| `codex-remote` | standalone external `codex_remote` adapter | pushed → PR #3 |
| `codex-claudflare` | **local test branch** = master + both features + local-only core patches | local only, NOT pushed |

PRs (draft, into `bbengamin/paperclip:master`):
- **#2** https://github.com/bbengamin/paperclip/pull/2 — cloudflare-bridge
- **#3** https://github.com/bbengamin/paperclip/pull/3 — codex-remote

## 3. What each feature is

### cloudflare-bridge (`packages/plugins/sandbox-providers/cloudflare-bridge/`)
Fork of the upstream `cloudflare` provider (upstream left untouched). Distinct identity:
- package `paperclip-plugin-cloudflare-bridge-sandbox`
- `PLUGIN_ID` `paperclip.cloudflare-bridge-sandbox-provider`, `driverKey` `cloudflare-bridge`

Adds: Tailscale networking (`bridge-template/tailscale-up.sh` + proxy-env), per-issue reusable sandbox ids, runtime-agnostic image (no baked-in CLI). Dropped: experimental SSE streaming. 39 tests pass.

### codex-remote (`packages/adapters/codex-remote/`)
Standalone external adapter `paperclip-plugin-codex-remote`, loaded via the adapter-plugin store (`createServerAdapter()` in `src/server/adapter.ts`) — **no registry/core edits**. Fully decoupled from `codex_local` (renamed identifiers; fixed `adapterType` bug). Folds the old registry-wrapper logic (sandbox preflight + remote defaults). Dropped SSE/`onActivity`/terminal-disposition subsystem. 76 tests pass.
- **Deferred:** custom UI run-log parser (needs a self-contained, worker-compatible bundled module at `./ui-parser`; tsc ESM output won't work). Adapter works without it (default run-log rendering).

## 4. Local-only core patches (on `codex-claudflare` ONLY — NOT on feature branches)

These touch upstream core files, so they are intentionally kept off the feature PRs. They are **upstream-PR candidates** (once merged upstream, they flow back via pulls, no fork divergence). Re-apply after any rebuild from clean master.

| Commit | File | Why |
|---|---|---|
| `3b9bc15d` | `server/src/services/plugin-loader.ts`, `server/src/adapters/plugin-loader.ts` | Windows: pass `pathToFileURL(...).href` to `--import` and `import()` (raw `C:\...` → `ERR_UNSUPPORTED_ESM_URL_SCHEME`). Broke plugin install + would break adapter install. |
| `7705e9b2` | `packages/shared/src/environment-support.ts` | Add `"codex_remote"` to hardcoded `REMOTE_MANAGED_ADAPTERS` so it may use `ssh`/`sandbox` envs. No extension seam exists for external adapters — see §7. |

The line-ending fix (`b61a6892`) is **also on the feature branch** (`cloudflare-bridge` as `b494efe9`, in PR #2) because it's a genuine feature fix, not core: forces LF for `tailscale-up.sh` (CRLF shebang → container exit 127).

## 5. How these deploy to a server (important nuance)

- **cloudflare-bridge**: auto-built into the Docker image (`scripts/build-docker-plugin-packages.mjs` globs `packages/plugins/sandbox-providers/*`). But you still must (a) `wrangler deploy` the Worker to your Cloudflare account and (b) configure the env driver in the UI.
- **codex-remote**: NOT auto-deployed (it's under `packages/adapters/`, an external adapter). Options: publish to npm + install via Adapters page, OR mount + register a `localPath` adapter-store record, OR a fork `Dockerfile` overlay that copies+builds+registers it. (See earlier discussion; a `DEPLOY.md` was offered but not yet written.)
- The two **core patches in §4 are not in the upstream Docker build** — a from-clean-master server image would reintroduce the Windows + env-gate bugs. Resolve via upstream PRs or a fork overlay.

## 6. Local testing — current status & steps

**Cloudflare Worker** (run from `packages/plugins/sandbox-providers/cloudflare-bridge/bridge-template`):
- `npx wrangler secret put BRIDGE_AUTH_TOKEN` and `TAILSCALE_AUTHKEY`
- `npx wrangler deploy` (Containers is a **paid** Workers feature; needs Docker running)
- Get bridge URL from deploy output / dashboard / `npx wrangler deployments list`. Worker name: `paperclip-cloudflare-sandbox-bridge`. Use the bare `https://…workers.dev` root as `bridgeBaseUrl` (provider appends `/api/paperclip-sandbox/v1`).

**Paperclip** (run `pnpm dev` from repo root, on `codex-claudflare`):
1. Build the adapter once: `pnpm --filter paperclip-plugin-codex-remote build`; register it in the adapter store (Adapters page or a `localPath` record → `packages/adapters/codex-remote`).
2. Instance Settings → **Experimental → enable "Enable Environments"** (gates the whole env UI; runtime ignores the flag but honors the saved values).
3. Environments page → configure the `cloudflare-bridge` env → **Set as default** (persists `instanceSettings.defaultEnvironmentId`), and/or set the per-agent override (now visible after the §4 env-support patch).
4. Leave general setting `executionMode` = `any` (don't force kubernetes).
5. Run a test task.

**Verify a run actually hits the sandbox:** resolved environment `source` should be `instance`/`agent` (not `default`); working dir should be the remote sandbox path, NOT `C:\Users\…\.paperclip\…`.

### Gotchas already solved (don't re-debug)
- "secret_binding_missing TAILSCALE_AUTHKEY": do **not** put Tailscale vars in the Paperclip environment env — the Worker supplies them. Remove them.
- "tailscale up exit 127": CRLF line endings (fixed, redeploy Worker).
- "codex_remote requires a sandbox execution target" + run goes local: the §4 env-support patch + setting an env as instance default/agent override. Env picker reverting to placeholder = the support-gate filtering (fixed by §4 patch; rebuild/hard-refresh UI).
- Windows plugin/adapter install ESM error: §4 `3b9bc15d`.

**Last known state:** §4 env-support patch just applied + committed. Next action was: restart `pnpm dev`, hard-refresh browser, set the bridge env as instance default, re-run the test task, and confirm it enters the sandbox.

## 7. Key open question — env eligibility has no extension seam

`REMOTE_MANAGED_ADAPTERS` in `packages/shared/src/environment-support.ts` is a hardcoded allow-list consumed by UI **and** server (`agents.ts:896,900`, `heartbeat.ts`). External adapters cannot declare sandbox/ssh support — nothing on `ServerAdapterModule` or the manifest feeds it. So codex_remote sandbox eligibility **requires** a core edit (§4). 

**Recommended upstream PR:** add a declarative seam (e.g. `supportedEnvironmentDrivers` / `supportsRemoteManagedEnvironments` on `ServerAdapterModule` or the plugin manifest) that `environment-support.ts` consults, so external adapters work without patching the set. This removes the fork divergence.

## 8. TODO / next steps

- [ ] Finish local E2E: confirm a codex_remote run executes inside the cloudflare-bridge sandbox and Codex starts.
- [ ] Decide deploy strategy for codex-remote (npm publish vs localPath vs fork Docker overlay); optionally write `DEPLOY.md`.
- [ ] Upstream PR(s) for the two core patches in §4 (Windows ESM URL fix; env-support extension seam). Keep them OFF the feature PRs.
- [ ] Optional Branch 3 `codex-local-auth` (config.toml/`CODEX_HOME` auth for built-in codex_local via an external override adapter) — designed, not built.
- [ ] codex-remote custom UI run-log parser (bundled `./ui-parser`) — deferred.
- [ ] Consider pushing `codex-claudflare` for backup (currently local only).

## 9. Memory

Project context saved in agent memory: `fork-feature-branch-architecture`, `codex-remote-helper-dedup` (superseded — codex_remote is intentionally standalone). The plan file: `~/.claude/plans/in-the-branch-adapter-wrapper-mutable-pretzel.md`.
