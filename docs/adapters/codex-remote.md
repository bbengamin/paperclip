# Codex Remote

`codex_remote` runs Codex inside a sandbox environment. It is a remote runtime
adapter, not a Git workflow adapter.

Use it when:

- the agent should run Codex in a Cloudflare sandbox environment
- Paperclip should provide the sandbox bridge, runtime env, Codex home sync, skills, and progress updates
- the agent can decide whether the assigned task requires repository work

Use `codex_local` when:

- Codex should run on the Paperclip host
- Codex should run over the normal local or SSH workspace flow
- the task needs Paperclip to use the existing local/remote filesystem workflow

## Sandbox Runtime Flow

The expected flow is:

1. Agent wakes up.
2. Paperclip acquires or resumes a sandbox lease.
3. Paperclip verifies the sandbox working directory and bridge channel.
4. Paperclip syncs Codex runtime assets such as `CODEX_HOME`, selected skills, and Paperclip API bridge env.
5. Codex runs in the sandbox working directory.
6. Plugin stream events send Codex stdout/stderr progress back to Paperclip while Codex runs.
7. Codex performs the assigned task. If repository work is needed, Codex clones the repository itself using Codebase metadata and available Git credentials.
8. Codex posts progress/final comments and updates the Paperclip issue status through the Paperclip API before exiting.
9. Paperclip releases the sandbox lease or allows it to sleep according to the environment policy.

`codex_remote` does not clone, fetch, checkout, commit, push, create pull
requests, or mark issues done from the host. Those actions belong to the agent
when the task requires them.

## Repository Metadata

When the assigned work has a Codebase, Paperclip exposes repository metadata to
the agent through the normal workspace context and environment, including:

- `PAPERCLIP_WORKSPACE_REPO_URL`
- `PAPERCLIP_WORKSPACE_REPO_REF`
- `context.paperclipWorkspace.repoUrl`
- `context.paperclipWorkspace.repoRef`

The sandbox may start in an empty/default working directory. The agent should
clone the repository only when that is necessary for the task.

## Operator Setup

Create or select a sandbox environment backed by a provider that supports command
execution and the Paperclip sandbox bridge.

The sandbox environment should have:

- provider API access configured
- a Codebase selected when tasks should expose repository metadata to the agent
- `GITHUB_TOKEN` or `GH_TOKEN` configured in the agent environment when tasks may require private repository access, pushing, or pull request creation
- Codex runtime credentials/config available to the remote Codex home sync path

Do not put board/browser credentials in the sandbox. Do not embed GitHub tokens
in repository URLs. Git credentials should be scoped to the repositories the
agent is allowed to access and supplied as environment variables.

## Migration

Do not bulk-change existing `codex_local` agents.

1. Create one new `codex_remote` test agent.
2. Assign one low-risk issue.
3. Confirm the run log shows sandbox workspace verification and bridge startup.
4. Confirm the agent can read Codebase metadata from env/context.
5. Confirm any Git clone, commit, push, or PR creation is performed by Codex itself only when the task asks for it.
6. Confirm the agent updates the Paperclip issue status before exiting.

Rollback is switching the agent back to `codex_local` or assigning it to a local
or SSH environment.
