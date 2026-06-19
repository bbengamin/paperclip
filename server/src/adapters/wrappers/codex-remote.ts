import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import {
  deriveRemoteGitSandboxSpec,
  prepareRemoteGitSandbox,
  type RemoteGitSandboxSafetyPolicy,
} from "@paperclipai/adapter-utils/remote-git-sandbox";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";

export const CODEX_REMOTE_TYPE = "codex_remote";

const DEFAULT_WORKSPACE_REALIZATION = {
  workspaceStrategy: "git_clone",
} as const;

const DEFAULT_REMOTE_TIMEOUT_SEC = 300;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asStringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(asRecord(value))) {
    if (typeof raw === "string" && raw.length > 0) out[key] = raw;
  }
  return out;
}

type CodexRemoteSandboxTarget = AdapterSandboxExecutionTarget & {
  runner: CommandManagedRuntimeRunner;
};

interface GitHubRepoCredential {
  owner: string;
  repo: string;
  token: string;
}

interface RemoteGitPullRequestResult {
  created: boolean;
  url: string | null;
  skippedReason: string | null;
}

interface PaperclipCloseoutResult {
  attempted: boolean;
  ok: boolean;
  skippedReason: string | null;
  error: string | null;
}

function requireSandboxTarget(ctx: AdapterExecutionContext): CodexRemoteSandboxTarget {
  const target = ctx.executionTarget;
  if (!target || target.kind !== "remote" || target.transport !== "sandbox") {
    throw new Error("codex_remote requires a sandbox execution target.");
  }
  if (!target.runner) {
    throw new Error("codex_remote requires a sandbox runner from the environment provider.");
  }
  return target as CodexRemoteSandboxTarget;
}

function readRemoteGitApprovedEnv(config: Record<string, unknown>): Record<string, string> {
  const remoteGit = asRecord(config.remoteGitSandbox);
  const safety = asRecord(remoteGit.safety);
  const configEnv = asStringRecord(config.env);
  return {
    ...(configEnv.GITHUB_TOKEN ? { GITHUB_TOKEN: configEnv.GITHUB_TOKEN } : {}),
    ...(configEnv.GH_TOKEN ? { GH_TOKEN: configEnv.GH_TOKEN } : {}),
    ...asStringRecord(remoteGit.env),
    ...asStringRecord(safety.approvedEnv),
  };
}

function readRemoteGitSafetyPolicy(config: Record<string, unknown>): RemoteGitSandboxSafetyPolicy | null {
  const remoteGit = asRecord(config.remoteGitSandbox);
  const safety = asRecord(remoteGit.safety);
  const approvedEnv = readRemoteGitApprovedEnv(config);
  return {
    ...(Array.isArray(safety.allowedRepoUrls)
      ? { allowedRepoUrls: safety.allowedRepoUrls.filter((value): value is string => typeof value === "string") }
      : {}),
    ...(Array.isArray(safety.protectedBranches)
      ? { protectedBranches: safety.protectedBranches.filter((value): value is string => typeof value === "string") }
      : {}),
    ...(Array.isArray(safety.requiredCredentialEnv)
      ? { requiredCredentialEnv: safety.requiredCredentialEnv.filter((value): value is string => typeof value === "string") }
      : {}),
    ...(Object.keys(approvedEnv).length > 0 ? { approvedEnv } : {}),
    ...(Array.isArray(safety.redactedSecrets)
      ? { redactedSecrets: safety.redactedSecrets.filter((value): value is string => typeof value === "string") }
      : {}),
  };
}

function failureResult(error: unknown, prefix: string): AdapterExecutionResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: `${prefix}: ${message}`,
    resultJson: {
      error: message,
      phase: prefix,
    },
  };
}

function readGitHubRepoCredential(repoUrl: string, env: Record<string, string> = {}): GitHubRepoCredential | null {
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== "github.com") return null;
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 2) return null;
  const owner = parts[0]?.trim();
  const repo = parts[1]?.replace(/\.git$/i, "").trim();
  const token = (
    env.GITHUB_TOKEN ??
    env.GH_TOKEN ??
    decodeURIComponent(parsed.password || parsed.username || "")
  ).trim();
  if (!owner || !repo || !token) return null;
  return { owner, repo, token };
}

function resolveHostPaperclipApiUrl(): string | null {
  const apiUrl = process.env.PAPERCLIP_API_URL?.trim();
  return apiUrl && apiUrl.length > 0 ? apiUrl.replace(/\/+$/, "") : null;
}

function buildPaperclipCloseoutComment(input: {
  branch: string;
  prUrl: string;
  commitSha: string | null;
}) {
  return [
    `Completed the remote sandbox work and opened the GitHub PR: ${input.prUrl}`,
    "",
    `Branch: ${input.branch}`,
    input.commitSha ? `Commit: ${input.commitSha}` : null,
  ].filter((line): line is string => line !== null).join("\n");
}

function resultSucceeded(result: AdapterExecutionResult): boolean {
  return result.exitCode === 0 && !result.timedOut && !result.errorMessage && !result.errorCode;
}

function completedResultFromHostCloseout(input: {
  result: AdapterExecutionResult;
  prUrl: string;
}): AdapterExecutionResult {
  if (resultSucceeded(input.result)) return input.result;
  return {
    ...input.result,
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    errorCode: null,
    errorFamily: null,
    retryNotBefore: null,
    errorMeta: undefined,
    summary: input.result.summary ?? `Completed remote work and opened ${input.prUrl}`,
    resultJson: {
      ...(input.result.resultJson ?? {}),
      codexRemoteOriginalResult: {
        exitCode: input.result.exitCode,
        signal: input.result.signal,
        timedOut: input.result.timedOut,
        errorMessage: input.result.errorMessage ?? null,
        errorCode: input.result.errorCode ?? null,
        errorFamily: input.result.errorFamily ?? null,
        retryNotBefore: input.result.retryNotBefore ?? null,
        errorMeta: input.result.errorMeta ?? null,
      },
    },
  };
}

async function closeOutPaperclipIssueFromHost(input: {
  ctx: AdapterExecutionContext;
  issueId: string | null;
  prUrl: string | null;
  branch: string;
  commitSha: string | null;
}): Promise<PaperclipCloseoutResult> {
  if (!input.issueId) {
    return { attempted: false, ok: false, skippedReason: "missing_issue_id", error: null };
  }
  if (!input.prUrl) {
    return { attempted: false, ok: false, skippedReason: "missing_pull_request_url", error: null };
  }
  const authToken = input.ctx.authToken?.trim();
  if (!authToken) {
    return { attempted: false, ok: false, skippedReason: "missing_auth_token", error: null };
  }
  const apiUrl = resolveHostPaperclipApiUrl();
  if (!apiUrl) {
    return { attempted: false, ok: false, skippedReason: "missing_paperclip_api_url", error: null };
  }

  const body = {
    status: "done",
    comment: buildPaperclipCloseoutComment({
      branch: input.branch,
      prUrl: input.prUrl,
      commitSha: input.commitSha,
    }),
  };

  try {
    const response = await fetch(`${apiUrl}/api/issues/${encodeURIComponent(input.issueId)}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return {
        attempted: true,
        ok: false,
        skippedReason: null,
        error: `Paperclip close-out failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
      };
    }
    return { attempted: true, ok: true, skippedReason: null, error: null };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      skippedReason: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function createOrReuseGitHubPullRequest(input: {
  repoUrl: string;
  env?: Record<string, string>;
  baseRef: string;
  workBranch: string;
  title: string;
  body: string;
}): Promise<RemoteGitPullRequestResult> {
  const credential = readGitHubRepoCredential(input.repoUrl, input.env);
  if (!credential) {
    return {
      created: false,
      url: null,
      skippedReason: "missing_github_repo_credential",
    };
  }

  const apiBase = `https://api.github.com/repos/${encodeURIComponent(credential.owner)}/${encodeURIComponent(credential.repo)}`;
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${credential.token}`,
    "content-type": "application/json",
    "user-agent": "paperclip-codex-remote",
    "x-github-api-version": "2022-11-28",
  };
  const response = await fetch(`${apiBase}/pulls`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: input.title,
      head: input.workBranch,
      base: input.baseRef,
      body: input.body,
    }),
  });
  if (response.ok) {
    const payload = await response.json() as { html_url?: unknown };
    return {
      created: response.status === 201,
      url: typeof payload.html_url === "string" ? payload.html_url : null,
      skippedReason: null,
    };
  }

  if (response.status === 422) {
    const head = `${credential.owner}:${input.workBranch}`;
    const existing = await fetch(
      `${apiBase}/pulls?state=open&head=${encodeURIComponent(head)}&base=${encodeURIComponent(input.baseRef)}`,
      { headers },
    );
    if (existing.ok) {
      const payload = await existing.json() as Array<{ html_url?: unknown }>;
      const url = payload.find((entry) => typeof entry.html_url === "string")?.html_url;
      if (typeof url === "string") {
        return {
          created: false,
          url,
          skippedReason: null,
        };
      }
    }
  }

  const detail = await response.text().catch(() => "");
  throw new Error(
    `GitHub PR creation failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
  );
}

export function applyCodexRemoteDefaults(config: Record<string, unknown>): Record<string, unknown> {
  const hasExplicitTimeout =
    typeof config.timeoutSec === "number" && Number.isFinite(config.timeoutSec) && config.timeoutSec > 0;
  return {
    ...config,
    timeoutSec: hasExplicitTimeout ? config.timeoutSec : DEFAULT_REMOTE_TIMEOUT_SEC,
    dangerouslyBypassApprovalsAndSandbox: true,
    workspaceRealization: {
      ...DEFAULT_WORKSPACE_REALIZATION,
      ...asRecord(config.workspaceRealization),
    },
  };
}

export function patchCodexRemoteExecutionContext(ctx: AdapterExecutionContext): AdapterExecutionContext {
  return {
    ...ctx,
    config: applyCodexRemoteDefaults(ctx.config),
  };
}

export async function executeCodexRemote(input: {
  base: ServerAdapterModule;
  ctx: AdapterExecutionContext;
}): Promise<AdapterExecutionResult> {
  const target = requireSandboxTarget(input.ctx);
  const config = applyCodexRemoteDefaults(input.ctx.config);
  const workspaceRealization = asRecord(config.workspaceRealization);
  const remoteGit = asRecord(config.remoteGitSandbox);
  const remoteGitEnv = readRemoteGitApprovedEnv(config);
  const workspaceContext = asRecord(input.ctx.context.paperclipWorkspace);
  const issueContext = asRecord(input.ctx.context.paperclipIssue);
  const issueId = readString(issueContext.id) ?? readString(input.ctx.context.issueId);
  const issueIdentifier = readString(issueContext.identifier) ?? readString(input.ctx.context.issueIdentifier);
  const timeoutMs =
    typeof remoteGit.timeoutMs === "number" && Number.isFinite(remoteGit.timeoutMs) && remoteGit.timeoutMs > 0
      ? Math.trunc(remoteGit.timeoutMs)
      : target.timeoutMs ?? 300_000;
  const spec = deriveRemoteGitSandboxSpec({
    workspace: {
      repoUrl: readString(workspaceContext.repoUrl) ?? readString(remoteGit.repoUrl),
      repoRef: readString(workspaceContext.repoRef) ?? readString(remoteGit.repoRef),
      defaultRef: readString(workspaceContext.defaultRef) ?? readString(remoteGit.defaultRef),
      name: readString(workspaceContext.name) ?? readString(remoteGit.workspaceName),
      setupCommand: readString(remoteGit.setupCommand),
      cleanupCommand: readString(remoteGit.cleanupCommand),
    },
    issue: {
      id: issueId,
      identifier: issueIdentifier,
    },
    remoteRootDir: readString(remoteGit.remoteRootDir) ?? (target.remoteCwd.replace(/\/+[^/]*$/, "") || "/workspaces"),
    remoteCwd: readString(workspaceRealization.remoteCwd) ?? readString(remoteGit.remoteCwd) ?? target.remoteCwd,
    workBranch: readString(workspaceRealization.workBranch) ?? readString(remoteGit.workBranch),
    workBranchPrefix: readString(remoteGit.workBranchPrefix) ?? "paperclip/cloudflare",
  });

  let sandbox: Awaited<ReturnType<typeof prepareRemoteGitSandbox>>;
  try {
    sandbox = await prepareRemoteGitSandbox({
      runner: target.runner,
      spec,
      shellCommand: target.shellCommand === "sh" ? "sh" : "bash",
      timeoutMs,
      safety: readRemoteGitSafetyPolicy(config),
    });
  } catch (error) {
    return failureResult(error, "codex_remote_prepare_failed");
  }

  // Verify the workspace is accessible from the main (paperclip) session.
  try {
    const verifyResult = await target.runner.execute({
      command: target.shellCommand === "sh" ? "sh" : "bash",
      args: ["-c", `ls -la ${JSON.stringify(sandbox.spec.remoteCwd)} 2>&1 && echo WORKSPACE_OK`],
      cwd: "/",
      timeoutMs: 30_000,
    });
    await input.ctx.onLog(
      "stdout",
      `[paperclip] codex_remote workspace verify (main session): exit=${verifyResult.exitCode} timedOut=${verifyResult.timedOut}\n${verifyResult.stdout || ""}\n${verifyResult.stderr || ""}`,
    );
  } catch (verifyError) {
    await input.ctx.onLog("stderr", `[paperclip] codex_remote workspace verify failed: ${verifyError instanceof Error ? verifyError.message : String(verifyError)}\n`);
  }

  // Pre-warm the bridge channel and verify the workspace is visible there.
  // Cloudflare bridge-channel commands now run in the configured execution
  // session so the localhost callback bridge is reachable to the agent process.
  // This still catches cold-start latency before the polling loop starts.
  try {
    const bridgeVerifyResult = await target.runner.execute({
      command: target.shellCommand === "sh" ? "sh" : "bash",
      args: ["-c", `ls -la ${JSON.stringify(sandbox.spec.remoteCwd)} 2>&1 && echo BRIDGE_SESSION_OK`],
      cwd: "/",
      env: { PAPERCLIP_SANDBOX_EXEC_CHANNEL: "bridge" },
      timeoutMs: 90_000,
    });
    await input.ctx.onLog(
      "stdout",
      `[paperclip] codex_remote workspace verify (bridge channel): exit=${bridgeVerifyResult.exitCode} timedOut=${bridgeVerifyResult.timedOut}\n${bridgeVerifyResult.stdout || ""}\n${bridgeVerifyResult.stderr || ""}`,
    );
  } catch (bridgeVerifyError) {
    await input.ctx.onLog("stderr", `[paperclip] codex_remote bridge channel verify failed: ${bridgeVerifyError instanceof Error ? bridgeVerifyError.message : String(bridgeVerifyError)}\n`);
  }

  // Keep the default remote test loop short. Operators can still configure a
  // larger timeoutSec for real work, but the fallback should fail fast enough
  // to debug sandbox/bridge regressions without 15-minute waits.
  const DEFAULT_CODEX_REMOTE_RUN_TIMEOUT_MS = 5 * 60 * 1_000;
  const codexRunTimeoutMs =
    typeof config.timeoutSec === "number" && config.timeoutSec > 0
      ? config.timeoutSec * 1_000
      : DEFAULT_CODEX_REMOTE_RUN_TIMEOUT_MS;

  try {
    const patchedCtx = patchCodexRemoteExecutionContext({
      ...input.ctx,
      executionTarget: {
        ...target,
        remoteCwd: sandbox.spec.remoteCwd,
        timeoutMs: codexRunTimeoutMs,
      },
      config: {
        ...config,
        remoteGitSandbox: {
          ...remoteGit,
          enabled: true,
          repoUrl: sandbox.spec.repoUrl,
          baseRef: sandbox.spec.baseRef,
          workBranch: sandbox.spec.workBranch,
          remoteCwd: sandbox.spec.remoteCwd,
        },
      },
    });
    let result: AdapterExecutionResult;
    try {
      result = await input.base.execute(patchedCtx);
    } catch (error) {
      result = failureResult(error, "codex_remote_execute_failed");
    }

    let finalize;
    let pullRequest: RemoteGitPullRequestResult | null = null;
    let closeout: PaperclipCloseoutResult | null = null;
    try {
      finalize = await sandbox.finalize({
        commitMessage: readString(remoteGit.commitMessage) ?? `Paperclip Codex Remote ${sandbox.spec.workBranch}`,
        push: remoteGit.push !== false,
        timeoutMs,
      });
      if (finalize.pushed && remoteGit.createPr !== false) {
        pullRequest = await createOrReuseGitHubPullRequest({
          repoUrl: sandbox.spec.repoUrl,
          env: remoteGitEnv,
          baseRef: sandbox.spec.baseRef,
          workBranch: sandbox.spec.workBranch,
          title: readString(remoteGit.prTitle) ?? `Paperclip remote work ${sandbox.spec.workBranch}`,
          body: readString(remoteGit.prBody) ??
            [
              "Automated Paperclip remote sandbox work.",
              "",
              `Run: ${input.ctx.runId}`,
              `Branch: ${sandbox.spec.workBranch}`,
            ].join("\n"),
        });
      }
      closeout = await closeOutPaperclipIssueFromHost({
        ctx: input.ctx,
        issueId,
        prUrl: pullRequest?.url ?? null,
        branch: sandbox.spec.workBranch,
        commitSha: finalize.commitSha,
      });
    } catch (error) {
      return failureResult(error, "codex_remote_finalize_failed");
    }

    await input.ctx.onLog(
      "stdout",
      `[paperclip] git finalize: dirty=${finalize.dirty} pushed=${finalize.pushed} branch=${finalize.pushedBranch ?? "none"} sha=${finalize.commitSha ?? "none"}\n`,
    );
    if (closeout?.ok) {
      await input.ctx.onLog("stdout", "[paperclip] host close-out marked the Paperclip issue done.\n");
    } else if (closeout?.attempted && closeout.error) {
      await input.ctx.onLog("stderr", `[paperclip] host close-out failed: ${closeout.error}\n`);
    }

    const finalResult = closeout?.ok && pullRequest?.url
      ? completedResultFromHostCloseout({ result, prUrl: pullRequest.url })
      : result;

    return {
      ...finalResult,
      resultJson: {
        ...(finalResult.resultJson ?? {}),
        remoteGit: {
          dirty: finalize.dirty,
          status: finalize.status,
          commitSha: finalize.commitSha,
          pushed: finalize.pushed,
          pushedBranch: finalize.pushedBranch,
          pullRequestUrl: pullRequest?.url ?? null,
          pullRequestCreated: pullRequest?.created ?? false,
          pullRequestSkippedReason: pullRequest?.skippedReason ?? null,
          paperclipCloseout: closeout,
          repoUrl: sandbox.spec.repoUrl,
          baseRef: sandbox.spec.baseRef,
          workBranch: sandbox.spec.workBranch,
          remoteCwd: sandbox.spec.remoteCwd,
        },
      },
    };
  } finally {
    try {
      await sandbox.cleanup();
    } catch (error) {
      await input.ctx.onLog(
        "stderr",
        `[paperclip] codex_remote cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}

export function createCodexRemoteAdapter(input: {
  base: ServerAdapterModule;
  agentConfigurationDoc?: string;
}): ServerAdapterModule {
  const base = input.base;
  return {
    ...base,
    type: CODEX_REMOTE_TYPE,
    execute: (ctx) => executeCodexRemote({ base, ctx }),
    testEnvironment: (ctx) => base.testEnvironment({
      ...ctx,
      adapterType: CODEX_REMOTE_TYPE,
      config: applyCodexRemoteDefaults(ctx.config),
    }),
    agentConfigurationDoc: input.agentConfigurationDoc ?? base.agentConfigurationDoc,
  };
}
