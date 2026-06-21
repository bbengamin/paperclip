# Codex Remote Adapter Handoff

Date: 2026-06-20
Last updated: 2026-06-20 (session 2 — stability fixes applied)

## Session 2 — Stability fixes applied (A, B-core, D)

Root causes were confirmed in code + logs + live API (run `0ded26df…` = failed
`process_lost` "server may have restarted", `processPid: null`). Fixes:

### A — Liveness / process_lost (DONE, tested)
- **A1 (root cause):** bridge-channel commands now run on a dedicated
  `<sessionId>-bridge` Cloudflare session instead of sharing the Codex session.
  `executeInSandbox` deletes the named session on a command timeout — so a slow
  bridge poll was tearing down the live Codex session. Also bounded the host
  bridge queue client per-command timeout to 30s so a stuck poll recovers fast
  instead of starving the in-sandbox "run alive" pings.
  Files: `packages/plugins/sandbox-providers/cloudflare/src/plugin.ts`,
  `packages/adapter-utils/src/execution-target.ts`.
- **A2:** the orphaned-run watchdog (`reapOrphanedRuns`) is now sandbox-aware:
  environment-backed runs (those holding a provider lease) re-check liveness
  before being reaped, get a sandbox-specific message instead of the misleading
  "server may have restarted", and are allowed one automatic retry so the issue
  resumes instead of being stranded. File: `server/src/services/heartbeat.ts`.
- **A3:** if the linked issue already reached a terminal-good status
  (done/in_review/cancelled), the watchdog suppresses the redundant retry.
- **A4:** tests in `server/src/__tests__/heartbeat-process-recovery.test.ts`
  (environment-backed retry + terminal-issue no-retry) and the Cloudflare plugin
  bridge-session test. NOTE: a *pre-existing* failing test in that file
  ("queues exactly one retry when the recorded local pid is dead", asserts
  `checkoutRunId`) fails independent of these changes (verified via stash).

### B — Sandbox identity (CORE done, tested; lifecycle refinements pending)
- **B1 (the cross-task contamination fix):** `buildLeaseSandboxId` now scopes a
  reusable sandbox id per issue (`pc-env-<env>-issue-<issueId>`) instead of one
  shared `pc-env-<env>`. Different issues can no longer land on the same
  `/workspace` checkout; the same issue still reuses its warm sandbox for fast
  continuation within the `sleepAfter` (10m) window. ⚠️ This is in the
  **bridge-template Cloudflare Worker** — it requires a **`wrangler deploy`** to
  take effect. Files: `packages/plugins/sandbox-providers/cloudflare/bridge-template/src/{helpers.ts,routes.ts}`.
- Pending refinements (not blocking): explicit destroy-after-sleep-window (today
  relies on Cloudflare `sleepAfter`), and gating reuse strictly to
  continuation wake reasons.

### D — Logging (DONE, tested)
- HTTP access-log silence policy made `/api`-prefix-agnostic and extended to the
  per-issue/per-run live-poll routes (`/issues/:id/live-runs`, `/active-run`,
  `/companies/:id/skills`). The previous patterns required an `/api` prefix the
  logger never saw, so nothing was silenced. File:
  `server/src/middleware/http-log-policy.ts`.
- Per-tick plugin stream-notification logs + per-chunk stream-forward log demoted
  from info to debug. Files: `server/src/services/plugin-worker-manager.ts`,
  `server/src/services/environment-runtime.ts`.

### To activate
- Restart `pnpm dev` (server runs from source; picks up heartbeat/logging).
- Rebuilt host packages: `@paperclipai/adapter-utils` and the Cloudflare plugin
  (`@paperclipai/plugin-cloudflare-sandbox`) — already built this session.
- **Redeploy the Cloudflare bridge-template Worker** for B1 (per-issue sandbox).

### Remaining (deferred per plan)
- **C — startup latency:** instrument Codex spawn→first-stdout, then overlap
  warmup/install with bridge startup. Best measured during a live A/B run.
- **E — adapter split:** revert `packages/adapters/codex-local` execute to
  upstream-original (move config.toml/auth copy into the `codex_local` wrapper)
  and build a new standalone `packages/adapters/codex-remote` package. Decided
  to do this AFTER stability.

---

(Original handoff below.)

## Current Goal

Make `codex_remote` stable on Cloudflare sandbox:

- Spawn or reuse sandbox.
- Warm up Codex runtime and Paperclip bridge.
- Show useful progress in Paperclip.
- Let the agent own task work, Git work, PR creation, comments, and issue status updates.
- Have Paperclip correctly finalize the run when the agent finishes.
- Avoid native Paperclip UI changes so upstream updates remain easy.

## Current Worktree

Uncommitted repo changes exist:

```text
M packages/adapter-utils/src/execution-target-sandbox.test.ts
M packages/adapter-utils/src/execution-target.ts
M packages/adapter-utils/src/sandbox-callback-bridge.test.ts
M packages/adapter-utils/src/sandbox-callback-bridge.ts
M packages/adapters/codex-local/src/server/execute.remote.test.ts
M packages/adapters/codex-local/src/server/execute.ts
?? doc/plans/2026-06-20-codex-remote-adapter-handoff.md
```

Do not assume this branch is clean.

## Latest Code Changes

### Finalization Path

Implemented a terminal issue-disposition path:

- The sandbox callback bridge detects successful `PATCH /api/issues/:id` responses that set status to:
  - `done`
  - `cancelled`
  - `blocked`
  - `in_review`
- `codex_remote` listens for that bridge activity.
- If the patched issue is the current task issue, Codex gets a 5 second grace window to exit.
- If Codex hangs or exits badly after Paperclip issue disposition, the adapter synthesizes a clean result from the Paperclip issue status instead of letting the heartbeat run timeout/fail.

Relevant files:

- `packages/adapter-utils/src/execution-target.ts`
- `packages/adapters/codex-local/src/server/execute.ts`

### Bridge Queue Isolation

Fixed stale queue reuse problem:

- Before:

```text
/workspace/paperclip/.paperclip-runtime/codex/paperclip-bridge/queue
```

- Now:

```text
/workspace/paperclip/.paperclip-runtime/codex/paperclip-bridge/<runId>/queue
```

This should prevent reused sandboxes from processing old request/response files from prior runs.

Relevant file:

- `packages/adapter-utils/src/execution-target.ts`

### Missing Request Race

Fixed scary but normal abort race:

Observed log:

```text
sandbox callback bridge failed to abort pending request ... cannot open ... No such file
```

Now missing request files during worker processing/abort are treated as idempotent races, not retry-worthy failures.

Relevant file:

- `packages/adapter-utils/src/sandbox-callback-bridge.ts`

### Bridge Timeout Race

Changed in-sandbox bridge response timeout to 45s while local Cloudflare bridge request timeout is 60s.

Reason:

- If both are 60s, Cloudflare can abort before the sandbox bridge returns a clean 502.
- With 45s, Paperclip should see a controlled bridge response rather than:

```text
Cloudflare sandbox bridge request timed out after 60000ms
```

Relevant file:

- `packages/adapter-utils/src/execution-target.ts`

## Verification Run

Passed:

```sh
pnpm exec vitest run packages/adapter-utils/src/sandbox-callback-bridge.test.ts -t "ignores request files"
pnpm exec vitest run packages/adapters/codex-local/src/server/execute.remote.test.ts
pnpm --filter @paperclipai/adapter-utils typecheck
pnpm --filter @paperclipai/adapter-codex-local typecheck
pnpm --filter @paperclipai/adapter-utils build
pnpm --filter @paperclipai/adapter-codex-local build
```

Known test caveat:

- `packages/adapter-utils/src/execution-target-sandbox.test.ts` fails on this Windows host because its fake local sandbox runner tries to spawn `sh`.
- That affects existing tests in the file before assertions run. The new bridge behavior has separate targeted coverage in `sandbox-callback-bridge.test.ts`.

## Latest Live Run Observed

Current live run when monitored:

```text
Run: 0ded26df-7036-4fc6-a1de-1bd69ac60601
Issue: LOC-50
Issue id: 4026b289-0cce-4069-b59c-fd36d055119e
Agent: Voldjin
Adapter: codex_remote
Environment id: 7084ebfc-c668-4190-8293-70ba00f2d02e
Lease id: ffc56e17-3e73-4013-8539-a8f02791851c
Remote cwd: /workspace/paperclip
Status at last poll: run still running, issue still in_progress
```

Important: user reported a PR completed about 35 minutes earlier, but apparently for `LOC-48`, not the current `LOC-50`.

## LOC-50 Timeline

All timestamps below are UTC from Paperclip logs unless noted.

```text
15:39:08.533 run created
15:39:09.262 run started
15:39:09.383 LOC-50 marked started/in_progress
15:39:16.692 adapter skipped saved Codex session because wake reason was issue_assigned
15:39:18.446 workspace verify main session succeeded
15:39:19.166 workspace verify bridge channel succeeded
15:39:19.171 codex_remote execution target resolved: sandbox/cloudflare
15:39:19.199 Paperclip-managed Codex home prepared
15:39:19.232-15:39:19.310 Codex skills repaired/injected locally
15:39:19.318 sanitized remote CODEX_HOME asset prepared without auth.json
15:39:19.319 syncing CODEX_HOME to sandbox, skipping workspace archive sync
15:39:24.741 remote runtime assets synced
15:39:34.140 sandbox global Codex home installed at /root/.codex
15:39:34.144 sandbox callback bridge started under run-specific path
15:39:50.326 sandbox callback bridge ready
15:39:53.440 runtime command install/probe completed
15:39:56.464 command resolved: sandbox://cloudflare/.../workspace/paperclip :: codex
15:40:04.739 Paperclip preflight passed
15:40:04.762 fresh Codex exec started
15:40:25.571 first bridge-alive progress: "Sandbox bridge alive; waiting for Codex output"
15:46:03.230 first Codex stdout chunk received
15:46:03.234 thread.started: 019ee5b2-9f82-77a2-8da6-7fce6c09f2e1
15:46:24.533 turn.started
15:47:36.930 agent message: pulling assigned Paperclip issue context
15:47:58.333 command started: inspect PAPERCLIP/GitHub env vars
15:48:12.037 env command completed and showed repo metadata + Paperclip bridge env
15:48:12.037 command started: pwd && rg --files -uu
15:48:12.040 file listing completed
15:50:12.130 command started: git status
15:50:12.131 git status completed: on loc-48-index-html-update branch
15:51:46.530 fetched current Paperclip issue LOC-50 via bridge
15:53:13.325 agent decision: issue is broad but actionable; compare branch against main
15:53:47.729 command started: git log
15:54:57.527 git log completed, showing HEAD on LOC-48 branch
15:58:21.626 diff stat completed: index.html 550 insertions, 1 deletion
15:59:41.122 attempted diff command completed with empty output
16:02:23.618 command started: git branch -vv
16:06:17.721 git branch -vv completed, still on loc-48-index-html-update
16:09:01.332 run updated, but no new log output after 16:06:17
19:11 Kyiv polling still showed run=running, issue=LOC-50 in_progress
```

## Key Agent Decisions In LOC-50

The agent made these decisions:

1. It correctly treated Paperclip as the task system and pulled Paperclip issue context.
2. It detected repo metadata from env:

```text
PAPERCLIP_WORKSPACE_REPO_URL=https://github.com/lckmain/test-paper
PAPERCLIP_WORKSPACE_CWD=/workspace/paperclip
PAPERCLIP_TASK_ID=4026b289-0cce-4069-b59c-fd36d055119e
```

3. It found a pre-existing repo checkout under:

```text
/workspace/paperclip/repo
```

4. It found the checkout was on:

```text
loc-48-index-html-update
```

5. It concluded the requested LOC-50 landing page work may already be present on that branch and started validating/comparing it.

## Critical Finding

The sandbox reuse behavior is currently mixing task workspace state.

For LOC-50, the sandbox contained:

```text
/workspace/paperclip/repo
branch: loc-48-index-html-update
commit: fd3f790 Update index landing page for QuestLore ad traffic
```

This explains the user’s observation:

- PR exists and task appears completed, but for `LOC-48`.
- New issue `LOC-50` reused the same sandbox and saw the old `LOC-48` repo/branch.
- Agent then reasoned from existing LOC-48 state instead of creating a clean LOC-50 branch/workspace.

This is separate from the bridge queue isolation fix. Queue isolation prevents old bridge requests from crossing runs, but it does not clean or namespace the task repo checkout under `/workspace/paperclip/repo`.

## Recommended Next Fix

Implement task-scoped sandbox workspace hygiene.

Options:

1. Conservative immediate fix:
   - On every non-continuation run, adapter should clean known task work dirs before Codex starts:

```text
/workspace/paperclip/repo
```

   - Keep `.paperclip-runtime` and `.paperclip-lease.json`.
   - Do this only when wake reason is not a fast continuation/approval/comment response for the same task.

2. Better fix:
   - Use task-scoped work dirs:

```text
/workspace/paperclip/tasks/<issueId>/repo
```

   - Pass that as suggested working area in env/instructions.
   - Still let agent own cloning, but avoid cross-task contamination.

3. Strongest/simple production rule:
   - Reuse sandbox only for the exact same issue id within the short activity window.
   - If issue id changes, either:
     - spawn a new sandbox, or
     - clean the sandbox task workspace before running Codex.

Given current bug, option 3 is the safest rule.

## What To Check Tomorrow First

1. Check whether active run is still running:

```sh
curl -fsS http://localhost:3100/api/heartbeat-runs/0ded26df-7036-4fc6-a1de-1bd69ac60601
```

2. Check LOC-50:

```sh
curl -fsS http://localhost:3100/api/issues/LOC-50
```

3. Check full log:

```sh
curl -fsS "http://localhost:3100/api/heartbeat-runs/0ded26df-7036-4fc6-a1de-1bd69ac60601/log?offset=0&limitBytes=1024000"
```

4. Check if stale bridge root is still present in new sandboxes:

```text
/workspace/paperclip/.paperclip-runtime/codex/paperclip-bridge/queue
```

New runs should use:

```text
/workspace/paperclip/.paperclip-runtime/codex/paperclip-bridge/<runId>/queue
```

5. Check if stale repo is still present:

```text
/workspace/paperclip/repo
```

If yes, fix sandbox reuse/workspace hygiene before doing more task tests.

## Possible Immediate Manual Recovery

For testing only, before next run:

- Stop/restart Paperclip.
- Either destroy/retire the current Cloudflare sandbox lease or ensure a new sandbox is spawned.
- Or manually remove `/workspace/paperclip/repo` inside sandbox before running a new issue.

Better product fix is to make Paperclip handle this automatically.

## Build/Restart Notes

Today’s touched code is in packages:

- `@paperclipai/adapter-utils`
- `@paperclipai/adapter-codex-local`

Already built:

```sh
pnpm --filter @paperclipai/adapter-utils build
pnpm --filter @paperclipai/adapter-codex-local build
```

Restart Paperclip before testing changes.

Cloudflare plugin/worker code was not changed in the final patch set, so no Cloudflare plugin rebuild should be required for these adapter-utils/codex-local changes.

## Important Files

- `packages/adapter-utils/src/execution-target.ts`
- `packages/adapter-utils/src/sandbox-callback-bridge.ts`
- `packages/adapter-utils/src/sandbox-callback-bridge.test.ts`
- `packages/adapters/codex-local/src/server/execute.ts`
- `packages/adapters/codex-local/src/server/execute.remote.test.ts`
- `server/src/services/environment-runtime.ts`
- `server/src/services/environment-run-orchestrator.ts`

## Open Questions

- Should sandbox reuse be keyed strictly by issue id?
- Should a new issue always get a new sandbox?
- Should same-task continuation reuse only happen for wake comments/approvals within 10 minutes?
- Where is the best layer to clean task workspace state: environment runtime, codex_remote adapter, or Cloudflare sandbox plugin?
- Should the adapter stop using `/workspace/paperclip/repo` as an implicit convention and instead expose a task-specific suggested clone dir?

