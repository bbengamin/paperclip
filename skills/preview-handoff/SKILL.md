---
name: preview-handoff
description: >
  Discover, verify, sign, and post browser-clickable preview links for Paperclip
  remote execution environments. Use when a task produces a web UI or HTTP
  preview that the operator should inspect from a Paperclip issue comment.
---

# Preview Handoff

Use this skill when the current Paperclip task produced a real browser or HTTP
preview that the operator should inspect. Preview posting is agent-owned and
task-aware: do not post a preview comment just because a runtime exists.

## Inputs

- Current Paperclip task id from `PAPERCLIP_TASK_ID`.
- Current run id from `PAPERCLIP_RUN_ID` or `PAPERCLIP_CHECKOUT_RUN_ID`.
- Signing secret from `PAPERCLIP_PREVIEW_SIGNING_SECRET`.
- Preview target id from `PAPERCLIP_PREVIEW_TARGET_ID` or runtime fallbacks.
- Candidate app URL or port from declared runtime metadata, app logs, or the
  bounded common-port fallback.
- Paperclip comment credentials from `PAPERCLIP_API_URL`,
  `PAPERCLIP_API_KEY`, and `PAPERCLIP_TASK_ID` when live comment posting is
  available.

Completion criterion: each input is present, derived, or explicitly unavailable
before deciding whether to post, print, or skip.

## Workflow

1. Decide whether the task has a preview-worthy browser/HTTP surface. Complete
   this step only when there is a real UI or HTTP service for the operator to
   inspect; otherwise mention no preview in the normal handoff.
2. Discover candidates in order: `PAPERCLIP_RUNTIME_PRIMARY_URL`,
   `PAPERCLIP_RUNTIME_SERVICES_JSON`, then only the allowed fallback ports.
   Completion criterion: candidate set contains no port outside the allowed
   preview set.
3. Verify candidates with HTTP before posting. Completion criterion: one primary
   candidate is selected from responding HTTP services, preferring
   frontend-looking responses.
4. Resolve preview route metadata. Completion criterion: base URL, target id,
   issue id, run id, expiry, and signing secret are either available or the
   helper reports a non-fatal skip reason.
5. Generate one signed preview URL and one `## Preview` comment. Completion
   criterion: the URL uses the RL-1405 canonical payload and the comment names
   source, port, environment type, verification time, lifecycle note, and up to
   three secondary detections.
6. Post through the Paperclip API when comment env is available. Completion
   criterion: the API accepts the comment, or the helper prints the exact
   markdown snippet for handoff when API env is unavailable.

## Helper

Run from this skill directory:

```bash
node scripts/paperclip-preview-handoff.mjs
```

The helper:

- prefers `PAPERCLIP_RUNTIME_PRIMARY_URL`
- then reads `PAPERCLIP_RUNTIME_SERVICES_JSON`
- then falls back only to common preview ports:
  `3000,3001,4000,4200,5000,5173,5174,8000,8080,9000`
- verifies candidates with HTTP before posting
- prefers frontend-looking candidates when more than one responds
- signs preview URLs with `PAPERCLIP_PREVIEW_SIGNING_SECRET`
- posts one separate `## Preview` comment when Paperclip API env is available
- prints the same markdown snippet when Paperclip API env is missing
- exits successfully without posting when no preview is applicable or verifiable

## Preview Env

Signed URL generation needs these values, either from explicit env or runtime
derivation:

- `PAPERCLIP_PREVIEW_SIGNING_SECRET`
- `PAPERCLIP_PREVIEW_TARGET_ID`
- `PAPERCLIP_TASK_ID`
- `PAPERCLIP_RUN_ID`
- preview base URL

`PAPERCLIP_PREVIEW_BASE_URL` is the explicit route prefix before
`/preview/...`.

Examples:

```text
# SSH gateway
http://<tailscale-host>:3999

# Cloudflare bridge
https://<bridge-host>/api/paperclip-sandbox/v1
```

For Cloudflare environments, Paperclip's Cloudflare sandbox provider injects
the native bridge root URL from its existing `bridgeBaseUrl` config when the
provider PR is deployed. The helper can also use these explicit fallback envs:

- `PAPERCLIP_CLOUDFLARE_BRIDGE_BASE_URL`
- `PAPERCLIP_SANDBOX_BRIDGE_BASE_URL`
- `PAPERCLIP_BRIDGE_BASE_URL`

For example:

```text
PAPERCLIP_CLOUDFLARE_BRIDGE_BASE_URL=https://paperclip-cloudflare-sandbox-bridge.example.workers.dev/
```

The helper appends `/api/paperclip-sandbox/v1` automatically. If
`PAPERCLIP_PREVIEW_BASE_URL` is used with `PAPERCLIP_PREVIEW_ENVIRONMENT_TYPE=cloudflare`,
the same normalization is applied.

For SSH environments, `PAPERCLIP_PREVIEW_BASE_URL` can usually be omitted. The
helper first tries `tailscale status --json` to read the current device DNS name
directly. If that is unavailable, the runtime may provide a tailnet domain:

- `PAPERCLIP_PREVIEW_TAILNET_DOMAIN`, `PAPERCLIP_TAILSCALE_DOMAIN`, or
  `TAILSCALE_DOMAIN`, for example `tail35f301.ts.net`
- optional `PAPERCLIP_PREVIEW_HOSTNAME` when the Tailscale device name differs
  from the OS hostname
- optional `PAPERCLIP_PREVIEW_GATEWAY_PORT`, default `3999`

When a tailnet domain fallback is used, the helper still tries
`tailscale status --json` before falling back to `<hostname>.<tailnet-domain>`.

`PAPERCLIP_PREVIEW_TARGET_ID` is the SSH environment id or Cloudflare
`providerLeaseId`. The helper also accepts these fallbacks when the explicit
target id is not set:

- `PAPERCLIP_PREVIEW_ENVIRONMENT_ID`
- `PAPERCLIP_ENVIRONMENT_ID`
- `PAPERCLIP_PROVIDER_LEASE_ID`
- `PAPERCLIP_REMOTE_PROVIDER_LEASE_ID`
- `PAPERCLIP_CLOUDFLARE_PROVIDER_LEASE_ID`

Missing signing or target env is non-fatal. The helper reports why it skipped
preview posting and the task can still complete normally.

## Paperclip Comment Env

Live comment posting requires:

- `PAPERCLIP_API_URL`
- `PAPERCLIP_API_KEY`
- `PAPERCLIP_TASK_ID`

When available, `PAPERCLIP_RUN_ID` is sent as `X-Paperclip-Run-Id`.

If any Paperclip API env is missing, do not improvise another posting path. Use
the printed markdown snippet in the final handoff if it is useful.

## Output Rules

Post at most one separate preview comment per run. The comment must include:

- signed preview URL
- detected source
- port
- environment type (`ssh`, `cloudflare`, or `remote`)
- verification time
- lifecycle note
- secondary detections, if any

If no preview is available, say that in the normal task handoff instead of
posting a separate preview comment.

## Safety Boundaries

- No arbitrary port scanning.
- No public unsigned preview links.
- Do not change Paperclip core auth/proxy behavior.
- Do not move preview lifecycle ownership into an adapter.
- Do not attach this skill to agents automatically.
- Do not post a separate preview comment when no verified preview exists.
- Missing signing/comment env is non-fatal for unrelated task completion.

## Stop Conditions

- Stop preview posting if the selected service is not verified as HTTP.
- Stop preview posting if signing inputs are incomplete.
- Stop preview posting if posting would require a port outside the allowed set.
- Stop and ask for operator help if the task requires public unauthenticated
  preview access, Paperclip core auth changes, arbitrary port exposure, or
  changing live agent skill attachments.

## Verification

- Run `node scripts/preview-handoff.test.mjs` after changing helper behavior.
- Validate `SKILL.md` frontmatter before importing: the folder slug, `name`,
  and file location must all be `preview-handoff`.
- For Paperclip import, verify the company skill library contains
  `preview-handoff` after the write.
- For live use, verify the posted comment opens through the signed preview
  gateway before marking preview handoff work complete.
