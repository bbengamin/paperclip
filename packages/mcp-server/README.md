# Paperclip MCP Server

Model Context Protocol server for Paperclip.

This package is a thin MCP wrapper over the existing Paperclip REST API. It does
not talk to the database directly and it does not reimplement business logic.

## Authentication

The server reads explicit environment variables first:

- `PAPERCLIP_API_URL` - Paperclip base URL, for example `http://localhost:3100`
- `PAPERCLIP_API_KEY` - bearer token used for `/api` requests
- `PAPERCLIP_COMPANY_ID` - default company for company-scoped tools
- `PAPERCLIP_AGENT_ID` - optional default agent for checkout helpers
- `PAPERCLIP_RUN_ID` - optional run id forwarded on mutating requests

If `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, or `PAPERCLIP_COMPANY_ID` is not set,
the server falls back to the active Paperclip CLI profile:

- context from `~/.paperclip/context.json` or `PAPERCLIP_CONTEXT`
- board credential from `~/.paperclip/auth.json` or `PAPERCLIP_AUTH_STORE`

The board credential is read in memory and sent only as the REST Authorization
header. The server does not print or copy token values.

Startup fails with setup instructions when CLI context or board auth is missing.
Run these before using a token-free MCP config:

```sh
paperclipai context set --api-base https://paperclip.right.link --company-id <company-id> --use
paperclipai auth login --api-base https://paperclip.right.link
```

## Usage

```sh
npx -y @bbengamin/paperclip-mcp-server
```

Or locally in this repo:

```sh
pnpm --filter @bbengamin/paperclip-mcp-server build
node packages/mcp-server/dist/stdio.js
```

Token-free MCP host config:

```json
{
  "mcpServers": {
    "paperclip": {
      "command": "npx",
      "args": ["-y", "@bbengamin/paperclip-mcp-server"]
    }
  }
}
```

Use explicit env vars when you want a host-local override:

```json
{
  "mcpServers": {
    "paperclip": {
      "command": "npx",
      "args": ["-y", "@bbengamin/paperclip-mcp-server"],
      "env": {
        "PAPERCLIP_API_URL": "https://paperclip.right.link",
        "PAPERCLIP_COMPANY_ID": "<company-id>"
      }
    }
  }
}
```

## Tool Surface

Read tools:

- `paperclipMe`
- `paperclipInboxLite`
- `paperclipListAgents`
- `paperclipGetAgent`
- `paperclipListIssues`
- `paperclipGetIssue`
- `paperclipGetHeartbeatContext`
- `paperclipListComments`
- `paperclipGetComment`
- `paperclipListIssueApprovals`
- `paperclipListDocuments`
- `paperclipGetDocument`
- `paperclipListDocumentRevisions`
- `paperclipListProjects`
- `paperclipGetProject`
- `paperclipGetIssueWorkspaceRuntime`
- `paperclipWaitForIssueWorkspaceService`
- `paperclipListGoals`
- `paperclipGetGoal`
- `paperclipListApprovals`
- `paperclipGetApproval`
- `paperclipGetApprovalIssues`
- `paperclipListApprovalComments`

Write tools:

- `paperclipCreateIssue`
- `paperclipUpdateIssue`
- `paperclipCheckoutIssue`
- `paperclipReleaseIssue`
- `paperclipAddComment`
- `paperclipSuggestTasks`
- `paperclipAskUserQuestions`
- `paperclipRequestConfirmation`
- `paperclipUpsertIssueDocument`
- `paperclipRestoreIssueDocumentRevision`
- `paperclipControlIssueWorkspaceServices`
- `paperclipCreateApproval`
- `paperclipLinkIssueApproval`
- `paperclipUnlinkIssueApproval`
- `paperclipApprovalDecision`
- `paperclipAddApprovalComment`

Escape hatch:

- `paperclipApiRequest`

`paperclipApiRequest` is limited to paths under `/api` and JSON bodies. It is
meant for endpoints that do not yet have a dedicated MCP tool.
