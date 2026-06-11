# Codex Remote

`codex_remote` runs the Codex adapter in a remote sandbox workflow. It is intended for Daytona or similar Git-backed sandboxes where the sandbox should clone/fetch the repository directly.

Use it when:

- the agent should work inside a remote sandbox environment
- the project has a configured Git `repoUrl`
- the sandbox can clone and push the repository
- you want to avoid full workspace archive upload/download

Use `codex_local` when:

- Codex should run on the Paperclip host
- Codex should run over the normal SSH workspace flow
- the project is not Git-backed
- the sandbox provider is not configured for Git-clone realization

## Daytona Git-Clone Flow

When the UI creates a `codex_remote` agent, its adapter config includes:

```json
{
  "workspaceRealization": {
    "workspaceStrategy": "git_clone"
  }
}
```

During a run, Paperclip passes that hint to the environment provider as workspace metadata. The Daytona provider treats it as `workspaceStrategy: "git_clone"` and clones or fetches the project repo inside the sandbox instead of creating a workspace folder for archive sync.

The expected flow is:

1. Agent wakes up.
2. Paperclip acquires a Daytona sandbox lease.
3. Daytona clones/fetches the project repo in the sandbox.
4. Daytona checks out a work branch such as `paperclip/daytona/<issue>`.
5. Codex runs in that sandbox checkout.
6. Remote work is committed and pushed through the Git-backed sandbox flow.
7. The sandbox lease is released according to the environment policy.

## Operator Setup

Create or select a sandbox environment backed by the Daytona provider.

The Daytona environment must have:

- API access configured
- repo credentials available to the sandbox
- `workspaceStrategy: "git_clone"` in provider config, or a provider version that honors the adapter metadata hint
- a project workspace with `repoUrl` metadata

Manual connection testing is still required before migrating live agents.

## Migration

Do not bulk-change existing `codex_local` agents.

1. Create one new `codex_remote` test agent.
2. Assign one low-risk issue.
3. Confirm the run metadata shows `workspaceStrategy: "git_clone"`.
4. Confirm no archive upload/download commands appear in provider logs.
5. Confirm the pushed branch contains the agent's work.
6. Move one live agent only after the test run is clean.

Rollback is simply switching the agent back to `codex_local` or assigning it to a local/SSH environment.
