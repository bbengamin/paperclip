# Handoff — Adapter Test environment inheritance + codex_remote sandbox eligibility

_Last updated: 2026-06-22. Repo: `C:\projects\ai-setup\paperclip`. Session scope: changes/events after prior `HANDOFF-codex-cloudflare.md`._

## 1. Goal / guiding rule

Fix the adapter **Test** button in agent settings so `codex_remote` tests run against the effective Cloudflare/sandbox environment instead of accidentally probing the local Paperclip host.

User constraint during early session: code changes only after approval. Approval was given for the later implementation plan.

## 2. Events in this session

### Rolled back and restored env-support patch

File:
- `packages/shared/src/environment-support.ts`

Actions:
1. Inspected latest committed change:
   - `7705e9b2 fix(env): allow codex_remote to use ssh/sandbox environments`
2. Removed the 5-line `codex_remote` allow-list patch on request.
3. User observed the difference and asked to restore it.
4. Restored the exact 5 lines.

Current note:
- Content is back to the committed state, but Git still marks the file modified due to line-ending state (`i/lf w/mixed`). I did not normalize or reset it.

## 3. Implemented fix

Files changed:

- `ui/src/components/AgentConfigForm.tsx`
- `ui/src/components/AgentConfigForm.test.ts`
- `server/src/services/environment-execution-target.ts`
- `server/src/__tests__/environment-execution-target.test.ts`
- `packages/adapters/codex-remote/src/server/test.ts`

Behavior changes:

1. Agent settings adapter Test now uses the effective environment:
   - explicit agent override first
   - otherwise non-local instance default
   - otherwise `null` / local host

2. Adapter model lookup now uses the same effective environment ID as adapter Test.

3. Server execution target resolver now uses:
   - `adapterSupportsRemoteManagedEnvironments()`

   instead of its own duplicated hardcoded allow-list.

   This makes `codex_remote` eligible for:
   - `sandbox`
   - `ssh`

   because `packages/shared/src/environment-support.ts` already includes `codex_remote`.

4. Codex Remote probe warning text was adjusted:
   - sandbox failures still say “remote sandbox”
   - local transport failures now say only “Could not complete the Codex hello probe.”

## 4. Tests / verification

Planned `pnpm test -- ...` commands failed before Vitest due to Windows symlink preflight:

```text
EPERM: operation not permitted, symlink ... packages/plugins/examples/plugin-orchestration-smoke-example/node_modules/@paperclipai/shared
```

Targeted verification was run by invoking Vitest directly:

Passed:
- `pnpm exec vitest run --project @paperclipai/ui ui/src/components/AgentConfigForm.test.ts`
- `pnpm exec vitest run --project @paperclipai/server server/src/__tests__/environment-execution-target.test.ts --no-file-parallelism --maxWorkers=1`
- `pnpm exec vitest run packages/adapters/codex-remote/src/server/test.remote.test.ts packages/adapters/codex-remote/src/server/adapter.test.ts --root packages/adapters/codex-remote`

Typechecks passed:
- `pnpm --filter @paperclipai/ui typecheck`
- `pnpm --filter @paperclipai/server typecheck`
- `pnpm --filter paperclip-plugin-codex-remote typecheck`

## 5. Process event

User asked to kill PG process.

Found and killed:
- `postgres`, PID `17708`

Afterward no remaining matching `postgres|pg_ctl|pglite|embedded` processes were listed.

## 6. Current git state notes

Known modified files from this session:

- `packages/adapters/codex-remote/src/server/test.ts`
- `server/src/__tests__/environment-execution-target.test.ts`
- `server/src/services/environment-execution-target.ts`
- `ui/src/components/AgentConfigForm.test.ts`
- `ui/src/components/AgentConfigForm.tsx`

Pre-existing / session artifact state:
- `packages/shared/src/environment-support.ts` marked modified due to line endings, content restored.
- `HANDOFF-codex-cloudflare.md` is untracked and was not modified.
