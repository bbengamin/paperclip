---
title: Creating an Adapter
summary: Guide to building a custom adapter
---

Build a custom adapter to connect Paperclip to any agent runtime.

<Tip>
If you're using Claude Code, the `.agents/skills/create-agent-adapter` skill can guide you through the full adapter creation process interactively. Just ask Claude to create a new adapter and it will walk you through each step.
</Tip>

## Two Paths

| | Built-in | External Plugin |
|---|---|---|
| Source | Inside `paperclip-fork` | Separate npm package |
| Distribution | Ships with Paperclip | Independent npm publish |
| UI parser | Static import | Dynamic load from API |
| Registration | Edit 3 registries | Auto-loaded at startup |
| Best for | Core adapters, contributors | Third-party adapters, internal tools |

For most cases, **build an external adapter plugin**. It's cleaner, independently versioned, and doesn't require modifying Paperclip's source. See [External Adapters](/adapters/external-adapters) for the full guide.

The rest of this page covers the shared internals that both paths use.

## Package Structure

```
packages/adapters/<name>/    # built-in
  ── or ──
my-adapter/                   # external plugin
  package.json
  tsconfig.json
  src/
    index.ts            # Shared metadata
    server/
      index.ts          # Server exports (createServerAdapter)
      execute.ts        # Core execution logic
      parse.ts          # Output parsing
      test.ts           # Environment diagnostics
    ui/
      index.ts          # UI exports (built-in only)
      parse-stdout.ts   # Transcript parser (built-in only)
      build-config.ts   # Config builder
    ui-parser.ts        # Self-contained UI parser (external — see [UI Parser Contract](/adapters/adapter-ui-parser))
    cli/
      index.ts          # CLI exports
      format-event.ts   # Terminal formatter
```

## Step 1: Root Metadata

`src/index.ts` is imported by all three consumers. Keep it dependency-free.

```ts
export const type = "my_agent";        // snake_case, globally unique
export const label = "My Agent (local)";
export const models = [
  { id: "model-a", label: "Model A" },
];
export const agentConfigurationDoc = `# my_agent configuration
Use when: ...
Don't use when: ...
Core fields: ...
`;

// Required for external adapters (plugin-loader convention)
export { createServerAdapter } from "./server/index.js";
```

## Step 2: Server Execute

`src/server/execute.ts` is the core. It receives an `AdapterExecutionContext` and returns an `AdapterExecutionResult`.

Key responsibilities:

1. Read config using safe helpers (`asString`, `asNumber`, etc.) from `@paperclipai/adapter-utils/server-utils`
2. Build environment with `buildPaperclipEnv(agent)` plus context vars
3. Resolve session state from `runtime.sessionParams`
4. Render prompt with `renderTemplate(template, data)`
5. Spawn the process with `runChildProcess()` or call via `fetch()`
6. Parse output for usage, costs, session state, errors
7. Handle unknown session errors (retry fresh, set `clearSession: true`)

### Available Helpers

| Helper | Source | Purpose |
|--------|--------|---------|
| `runChildProcess(cmd, opts)` | `@paperclipai/adapter-utils/server-utils` | Spawn with timeout, grace, streaming |
| `buildPaperclipEnv(agent)` | `@paperclipai/adapter-utils/server-utils` | Inject `PAPERCLIP_*` env vars |
| `renderTemplate(tpl, data)` | `@paperclipai/adapter-utils/server-utils` | `{{variable}}` substitution |
| `asString(v)` | `@paperclipai/adapter-utils` | Safe config value extraction |
| `asNumber(v)` | `@paperclipai/adapter-utils` | Safe number extraction |

### AdapterExecutionContext

```ts
interface AdapterExecutionContext {
  runId: string;
  agent: { id: string; companyId: string; name: string; adapterConfig: unknown };
  runtime: { sessionId: string | null; sessionParams: Record<string, unknown> | null };
  config: Record<string, unknown>;      // agent's adapterConfig
  context: Record<string, unknown>;      // task, wake reason, etc.
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onMeta?: (meta: AdapterInvocationMeta) => Promise<void>;
  onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
}
```

### AdapterExecutionResult

```ts
interface AdapterExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  errorMessage?: string | null;
  usage?: { inputTokens: number; outputTokens: number };
  sessionParams?: Record<string, unknown> | null;  // persist across heartbeats
  sessionDisplayId?: string | null;
  provider?: string | null;
  model?: string | null;
  costUsd?: number | null;
  clearSession?: boolean;  // set true to force fresh session on next wake
}
```

## Step 3: Environment Test

`src/server/test.ts` validates the adapter config before running.

Return structured diagnostics:

| Level | Meaning | Effect |
|-------|---------|--------|
| `error` | Invalid or unusable setup | Blocks execution |
| `warn` | Non-blocking issue | Shown with yellow indicator |
| `info` | Successful check | Shown in test results |

```ts
export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  return {
    adapterType: ctx.adapterType,
    status: "pass",  // "pass" | "warn" | "fail"
    checks: [
      { level: "info", message: "CLI v1.2.0 detected", code: "cli_detected" },
      { level: "warn", message: "No API key found", hint: "Set ANTHROPIC_API_KEY", code: "no_key" },
    ],
    testedAt: new Date().toISOString(),
  };
}
```

## Step 4: UI Module (Built-in Only)

For built-in adapters registered in Paperclip's source:

- `parse-stdout.ts` — converts stdout lines to `TranscriptEntry[]` for the run viewer
- `build-config.ts` — converts form values to `adapterConfig` JSON
- Config fields React component in `ui/src/adapters/<name>/config-fields.tsx`

For external adapters, use a self-contained `ui-parser.ts` instead. See the [UI Parser Contract](/adapters/adapter-ui-parser).

## Step 5: CLI Module

`format-event.ts` — pretty-prints stdout for `paperclipai run --watch` using `picocolors`.

```ts
export function formatStdoutEvent(line: string, debug: boolean): void {
  if (line.startsWith("[tool-done]")) {
    console.log(chalk.green(`  ✓ ${line}`));
  } else {
    console.log(`  ${line}`);
  }
}
```

## Step 6: Register (Built-in Only)

Add the adapter to all three registries:

1. `server/src/adapters/registry.ts`
2. `ui/src/adapters/registry.ts`
3. `cli/src/adapters/registry.ts`

For external adapters, registration is automatic — the plugin loader handles it.

## Session Persistence

If your agent runtime supports conversation continuity across heartbeats:

1. Return `sessionParams` from `execute()` (e.g., `{ sessionId: "abc123" }`)
2. Read `runtime.sessionParams` on the next wake to resume
3. Optionally implement a `sessionCodec` for validation and display

```ts
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) { /* validate raw session data */ },
  serialize(params) { /* serialize for storage */ },
  getDisplayId(params) { /* human-readable session label */ },
};
```

## Capability Flags

Adapters can declare what "local" capabilities they support by setting optional fields on the `ServerAdapterModule`. The server and UI use these flags to decide which features to enable for agents using the adapter (instructions bundle editor, skills sync, JWT auth, etc.).

| Flag | Type | Default | What it controls |
|------|------|---------|------------------|
| `supportsLocalAgentJwt` | `boolean` | `false` | Whether heartbeat generates a local JWT for the agent |
| `supportsInstructionsBundle` | `boolean` | `false` | Managed instructions bundle (AGENTS.md) — server-side resolution + UI editor |
| `instructionsPathKey` | `string` | `"instructionsFilePath"` | The `adapterConfig` key that holds the instructions file path |
| `requiresMaterializedRuntimeSkills` | `boolean` | `false` | Whether runtime skill entries must be written to disk before execution |

These flags are exposed via `GET /api/adapters` in a `capabilities` object, along with a derived `supportsSkills` flag (true when `listSkills` or `syncSkills` is defined).

### Example

```ts
export function createServerAdapter(): ServerAdapterModule {
  return {
    type: "my_k8s_adapter",
    execute: myExecute,
    testEnvironment: myTestEnvironment,
    listSkills: myListSkills,
    syncSkills: mySyncSkills,

    // Capability flags
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: true,
  };
}
```

With these flags set, the Paperclip UI will automatically show the instructions bundle editor, skills management tab, and working directory field for agents using this adapter — no Paperclip source changes required.

If capability flags are not set, the server falls back to legacy hardcoded lists for built-in adapter types. External adapters that omit the flags will default to `false` for all capabilities.

## Remote Git Sandbox Utilities

Remote adapters that intentionally run in an ephemeral hosted sandbox can use `@paperclipai/adapter-utils/remote-git-sandbox` instead of uploading and downloading a full workspace archive.

Use this layer only for explicit remote Git adapters, such as a future Codex Remote adapter. It is provider-agnostic: the adapter owns sandbox creation, credentials, and shutdown, while the shared helper owns the Git workflow inside the sandbox.

The supported flow:

- Derive the repo URL, base ref, work branch, and sandbox cwd with `deriveRemoteGitSandboxSpec()`.
- Pass a `safety` policy that lists allowed repo URLs, protected branch names, required credential env vars, and the exact approved env values that may enter the sandbox.
- Prepare the sandbox repo with `prepareRemoteGitSandbox()`, which validates the safety policy, clones or fetches, checks out the work branch, and runs an optional setup command.
- Run the adapter inside `sandbox.spec.remoteCwd`.
- Finalize with `sandbox.finalize()`, which reads `git status`, commits dirty work when present, and pushes the work branch when enabled.
- Wrap execution in `withRemoteGitSandbox()` when cleanup commands or provider cleanup hooks must run even after agent, commit, or push failures.

This layer does not include Daytona or any other provider API. Provider-specific wrappers should pass a generic runner that can execute shell commands in the sandbox and cleanup hooks that stop or release the sandbox lease.

Credential and safety rules:

- Do not copy host env wholesale into the sandbox. Build sandbox env from explicit approved values only.
- Git clone/push credentials must be scoped to the intended repo and provided through named env vars required by the adapter's safety policy.
- Paperclip writes from the sandbox must use agent/run-scoped credentials, never board-user browser/session credentials.
- Pushes to protected/default branches are rejected by default. Remote adapters should push issue work branches and let review/merge happen elsewhere.
- If repo auth, push target, or runtime auth is ambiguous, stop the run and surface the reason. Do not fall back to local credentials.
- Redact configured secret values and embedded URL credentials from command errors before surfacing them in run output.

## Skills Injection

Make Paperclip skills discoverable to your agent runtime without writing to the agent's working directory:

1. **Best: tmpdir + flag** — create tmpdir, symlink skills, pass via CLI flag, clean up after
2. **Acceptable: global config dir** — symlink to the runtime's global plugins directory
3. **Acceptable: env var** — point a skills path env var at the repo's `skills/` directory
4. **Last resort: prompt injection** — include skill content in the prompt template

## Cross-run workspace persistence (no-remote-git contract)

The local execution-workspace cwd is the **only** persistence boundary across runs. No adapter may depend on a git remote for cross-run state.

Exception: an adapter type that explicitly documents itself as a remote Git sandbox adapter may use the remote Git sandbox utilities above. That opt-in path treats the pushed branch as the handoff artifact and must not silently change the behavior of existing local or SSH adapter types.

The supported round-trip:

- **Per-run, on the remote side.** `prepareWorkspaceForSshExecution` (in `packages/adapter-utils/src/ssh.ts`) git-bundles the local worktree and ships it to the run's remote dir. No `git remote` is set anywhere; the bundle is the transport.
- **End-of-run, in the adapter's `finally` block.** The adapter invokes `restoreRemoteWorkspace` (e.g. claude-local's `execute.ts`), which calls `restoreWorkspaceFromSshExecution` → `exportGitWorkspaceFromSsh` → `integrateImportedGitHead`. Remote commits made during the run land back in the local Mac worktree with no `git push` and no remote configured.

The invariant adapters must preserve:

- **Never `git push`** from adapter or runtime code. Operator-supplied configuration may opt in, but the default contract is no remote operations.
- **Never assume a remote exists.** The local cwd is the source of truth between runs.
- **Surface restore failures.** A failed sync-back must propagate as a run-level error, not a silent warning. The heartbeat records a `workspace_finalize` row (`succeeded`/`failed`) around `adapter.execute` so dependent issues do not wake on a stale worktree.

The invariant is pinned by the "no-remote-git contract" case in `packages/adapter-utils/src/ssh-fixture.test.ts`: it asserts `git remote` is empty before and after the round-trip and that a remote-only commit still lands locally via restore alone.

## Security

- Treat agent output as untrusted (parse defensively, never execute)
- Inject secrets via environment variables, not prompts
- Configure network access controls if the runtime supports them
- Always enforce timeout and grace period
- The UI parser module runs in a browser sandbox — zero runtime imports, no side effects

## Next Steps

- [External Adapters](/adapters/external-adapters) — build a standalone adapter plugin
- [UI Parser Contract](/adapters/adapter-ui-parser) — ship a custom run-log parser
- [How Agents Work](/guides/agent-developer/how-agents-work) — the heartbeat lifecycle
