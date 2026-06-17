# Cloudflare Codex Remote Handoff - 2026-06-16

## Goal

Make Paperclip run Codex Remote agents from local Windows Paperclip into an ephemeral Cloudflare sandbox. The sandbox should:

- start on demand,
- join Tailscale,
- receive the local Codex configuration/auth,
- reach the configured Codex model provider through Tailscale,
- eventually run agent work remotely.

The user wants to avoid raw API keys if possible and prefers using their Codex/ChatGPT subscription or their existing `cliproxyapi` provider setup from `C:\Users\Windows\.codex\config.toml`.

## Local Context

- Repo: `C:\projects\ai-setup\paperclip`
- Paperclip server: `http://localhost:3100`
- Company: `f97ccce9-522b-42e4-b812-5f83bee99e56`
- Codex Remote agent: `cdf3c055-41b5-46a7-9016-82433b86f8ed` (`DT worker`)
- Cloudflare environment: `7084ebfc-c668-4190-8293-70ba00f2d02e` (`Claudflare`)
- Server logs: `C:\Users\Windows\.paperclip\instances\default\logs\server.log`

## Important User Preferences

- User is non-technical; explain simply.
- Do not expose secrets.
- Do not require sending Anthropic/OpenAI API keys if there is a subscription/proxy path.
- User wants local Windows Paperclip controlling remote Cloudflare sandbox.
- User moved away from Daytona because Tailscale install/networking was unreliable there.

## Relevant Previous Work

The larger branch already had many dirty files from previous work. Do not revert unrelated changes.

There are modified files in:

- Daytona plugin
- Cloudflare plugin
- Codex adapter
- shared environment support
- plugin loader/secrets
- command managed runtime

Check `git status --short` before making changes.

## Cloudflare Plugin Work Already Done

Package:

- `packages/plugins/sandbox-providers/cloudflare`

Important changes already present:

- local plugin manifest/build path fixed so Paperclip can install it;
- build scripts changed to Windows-compatible Node cleanup instead of `rm`;
- bridge template upgraded to `cloudflare/sandbox:0.12.1`;
- bridge template installs:
  - `curl`
  - `git`
  - `iproute2`
  - `procps`
  - `tailscale`
  - global `@openai/codex`
- `tailscale-up.sh` added in:
  - `packages/plugins/sandbox-providers/cloudflare/bridge-template/tailscale-up.sh`
- Cloudflare bridge supports secrets/vars:
  - `BRIDGE_AUTH_TOKEN`
  - `TAILSCALE_AUTHKEY`
  - optional `TAILSCALE_HOSTNAME`
  - optional `TAILSCALE_EXTRA_ARGS`
- when `TAILSCALE_AUTHKEY` exists, the bridge runs `tailscale-up` inside each sandbox;
- sandbox exec commands get proxy env injected:
  - `HTTP_PROXY=http://127.0.0.1:1056`
  - `HTTPS_PROXY=http://127.0.0.1:1056`
  - `ALL_PROXY=socks5://127.0.0.1:1055`
  - `NO_PROXY` keeps localhost values.

Rationale: Cloudflare sandbox uses userspace Tailscale, so Node raw TCP may not work, but HTTP tools that respect proxy env can reach Tailscale services.

## Codex Adapter Work Already Done

Package:

- `packages/adapters/codex-local`

Important files:

- `packages/adapters/codex-local/src/server/test.ts`
- `packages/adapters/codex-local/src/server/test.remote.test.ts`
- `packages/adapters/codex-local/src/server/codex-home.ts`
- `packages/adapters/codex-local/src/server/codex-home.test.ts`

Adapter environment test now adds remote diagnostics:

- checks remote `CODEX_HOME`;
- reports `auth.json`, `config.toml`, `config.json`, `instructions.md`;
- checks Codex path and version;
- reads auth mode from `auth.json`;
- checks `codex exec --help`;
- checks Tailscale status;
- reads model provider from copied `config.toml`;
- probes provider with:
  - raw TCP via Node,
  - HTTP `/models` via `curl`.

It also detects `token_invalidated` as an auth problem.

## Current Diagnostic Result

The latest API test returned HTTP 200 with `status: "warn"` instead of 500.

Key output:

```text
Working directory is valid: /workspace/paperclip
codex already on PATH; skipped install.
Command is executable: codex
Remote Codex auth file is present.
CODEX_HOME=/workspace/paperclip/.paperclip-runtime/codex/home; auth.json=4686 bytes
config.toml=3912; config.json=missing; instructions.md=missing
path=/usr/local/bin/codex; version=codex-cli 0.140.0
auth_mode=chatgpt
tailscale_ip=100.88.125.70
model_provider=cliproxyapi
base_url=http://100.114.28.103:8317/v1
wire_api=responses
provider_tcp=timeout
provider_http=status:401
```

Interpretation:

- Cloudflare sandbox starts.
- Tailscale joins.
- Codex CLI exists.
- Codex home/config/auth are copied.
- `cliproxyapi` config is detected.
- Raw TCP timeout is expected with userspace Tailscale/proxy.
- HTTP status 401 proves the sandbox reaches the provider URL through the HTTP proxy path.

## Current Problem

The user says the last fix did not help.

Before the last change, the UI/API often returned:

```text
Internal server error
RPC call "environmentExecute" timed out after 150000ms
```

This happened because after diagnostics, the adapter test ran a real:

```text
codex exec ...
```

That conversation probe could hang 2-4 minutes. Logs showed Codex sometimes reached the provider and got:

```text
token_invalidated
Your authentication token has been invalidated. Please try signing in again.
```

To avoid the API 500, I changed the environment test to skip the full hello probe for:

- remote sandbox target,
- provider reachable,
- auth mode `chatgpt`,
- no explicit API key.

It now returns a warning:

```text
Skipped Codex hello probe for ChatGPT-mode auth in a remote sandbox.
```

But this only avoids the test timeout. It does not prove a real Codex remote run works.

## Suspected Root Cause

Most likely remaining issue is auth/provider behavior, not Cloudflare/Tailscale.

Facts:

- `config.toml` uses:

```toml
model_provider = "cliproxyapi"

[model_providers.cliproxyapi]
base_url = "http://100.114.28.103:8317/v1"
name = "cliproxyapi"
wire_api = "responses"
requires_openai_auth = true
```

- Provider HTTP probe gets `401`.
- Since `requires_openai_auth = true`, Codex still expects usable OpenAI/Codex auth.
- Copied `auth.json` is ChatGPT subscription mode.
- ChatGPT-mode auth copied to another machine/container may be invalidated or require interactive refresh.

Likely next investigation:

1. Determine whether `cliproxyapi` should require OpenAI auth from Codex.
2. If proxy should handle auth itself, set or test:

```toml
requires_openai_auth = false
```

3. If proxy expects Codex/OpenAI bearer auth, then copied ChatGPT subscription tokens may not be enough in remote sandbox.
4. Need a real run log, not only environment test.

## Commands Already Verified

Codex adapter:

```powershell
pnpm --filter @paperclipai/adapter-codex-local exec vitest run src/server/test.remote.test.ts --reporter=verbose
pnpm --filter @paperclipai/adapter-codex-local build
```

Result:

```text
3 tests passed
build passed
```

Cloudflare plugin:

```powershell
cd C:\projects\ai-setup\paperclip\packages\plugins\sandbox-providers\cloudflare
pnpm test
pnpm build
```

Result:

```text
32 tests passed
build passed
```

Local API test command:

```powershell
$companyId='f97ccce9-522b-42e4-b812-5f83bee99e56'
$agentId='cdf3c055-41b5-46a7-9016-82433b86f8ed'
$envId='7084ebfc-c668-4190-8293-70ba00f2d02e'
$agents=(Invoke-RestMethod "http://localhost:3100/api/companies/$companyId/agents")
$agent=$agents | Where-Object { $_.id -eq $agentId } | Select-Object -First 1
$body=@{ adapterConfig=$agent.adapterConfig; environmentId=$envId } | ConvertTo-Json -Depth 20
Invoke-RestMethod -Method Post -Uri "http://localhost:3100/api/companies/$companyId/adapters/codex_remote/test-environment" -ContentType 'application/json' -Body $body -TimeoutSec 220 | ConvertTo-Json -Depth 20
```

## Possible Next Steps

### Step 1: Collect Real Run Failure

Run a tiny real task with Codex Remote and inspect:

- server log,
- agent run transcript,
- Cloudflare bridge logs.

Look for:

- `token_invalidated`
- `401`
- provider request details
- whether `HTTP_PROXY`/`HTTPS_PROXY` are present in the actual execution command, not only diagnostics.

### Step 2: Test Provider Auth Mode

Create a temporary copy of Codex config for sandbox with:

```toml
requires_openai_auth = false
```

Then run:

```sh
codex exec --json --skip-git-repo-check "Respond with hello"
```

inside the sandbox environment.

Expected outcomes:

- If it works: proxy handles auth, and Paperclip should support/allow `requires_openai_auth=false` in copied config.
- If it still 401s: proxy itself needs credentials or the provider URL is not the right target from sandbox.

### Step 3: Improve Error Surface

If real runs fail with auth, make the adapter surface a direct error:

```text
Codex reached your configured provider, but the provider rejected auth.
```

Avoid generic `Internal server error`.

### Step 4: Consider a Remote Auth Strategy

Options:

- use API key only inside proxy, not in sandbox;
- configure `cliproxyapi` to accept no Codex bearer auth from sandbox;
- provide sandbox with a short-lived provider token via Paperclip secret;
- keep ChatGPT auth local only and do not expect copied subscription auth to work in remote containers.

## Files Most Relevant To Continue

Codex adapter:

- `packages/adapters/codex-local/src/server/test.ts`
- `packages/adapters/codex-local/src/server/execute.ts`
- `packages/adapters/codex-local/src/server/codex-home.ts`
- `packages/adapters/codex-local/src/server/codex-args.ts`

Remote execution:

- `packages/adapter-utils/src/execution-target.ts`
- `server/src/services/environment-runtime.ts`
- `server/src/services/plugin-environment-driver.ts`
- `server/src/services/plugin-worker-manager.ts`

Cloudflare provider:

- `packages/plugins/sandbox-providers/cloudflare/src/plugin.ts`
- `packages/plugins/sandbox-providers/cloudflare/src/bridge-client.ts`
- `packages/plugins/sandbox-providers/cloudflare/bridge-template/src/routes.ts`
- `packages/plugins/sandbox-providers/cloudflare/bridge-template/src/sandboxes.ts`
- `packages/plugins/sandbox-providers/cloudflare/bridge-template/tailscale-up.sh`
- `packages/plugins/sandbox-providers/cloudflare/bridge-template/Dockerfile`

Docs:

- `packages/plugins/sandbox-providers/cloudflare/README.md`
- `packages/plugins/sandbox-providers/cloudflare/bridge-template/README.md`

## Warnings

- Do not revert unrelated dirty files.
- Do not print or commit secrets.
- Do not assume `provider_tcp=timeout` means broken networking; in this setup, `provider_http=status:401` is stronger evidence that Tailscale/proxy path works.
- The current `warn` environment test result is not enough. Need real agent run debugging.

