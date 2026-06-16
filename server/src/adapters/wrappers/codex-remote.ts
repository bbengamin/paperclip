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

// Remote sandbox runs have no natural process supervisor, so an un-capped run
// (timeoutSec = 0) only ends when the host RPC ceiling (15 min) fires, which
// surfaces as an opaque "environmentExecute timed out after 900000ms". Default
// to a sane cap so a stuck/wandering run fails fast with a clear "Timed out
// after Ns" instead. Agents can still override timeoutSec explicitly.
const DEFAULT_REMOTE_TIMEOUT_SEC = 600;

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

function readRemoteGitSafetyPolicy(config: Record<string, unknown>): RemoteGitSandboxSafetyPolicy | null {
  const remoteGit = asRecord(config.remoteGitSandbox);
  const safety = asRecord(remoteGit.safety);
  const approvedEnv = {
    ...asStringRecord(remoteGit.env),
    ...asStringRecord(safety.approvedEnv),
  };
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

export function applyCodexRemoteDefaults(config: Record<string, unknown>): Record<string, unknown> {
  const hasExplicitTimeout =
    typeof config.timeoutSec === "number" && Number.isFinite(config.timeoutSec) && config.timeoutSec > 0;
  return {
    ...config,
    timeoutSec: hasExplicitTimeout ? config.timeoutSec : DEFAULT_REMOTE_TIMEOUT_SEC,
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
  const workspaceContext = asRecord(input.ctx.context.paperclipWorkspace);
  const issueContext = asRecord(input.ctx.context.paperclipIssue);
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
      id: readString(issueContext.id) ?? readString(input.ctx.context.issueId),
      identifier: readString(issueContext.identifier) ?? readString(input.ctx.context.issueIdentifier),
    },
    remoteRootDir: readString(remoteGit.remoteRootDir) ?? (target.remoteCwd.replace(/\/+[^/]*$/, "") || "/workspaces"),
    remoteCwd: readString(workspaceRealization.remoteCwd) ?? readString(remoteGit.remoteCwd) ?? target.remoteCwd,
    workBranch: readString(workspaceRealization.workBranch) ?? readString(remoteGit.workBranch),
    workBranchPrefix: readString(remoteGit.workBranchPrefix) ?? "paperclip/daytona",
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

  try {
    const patchedCtx = patchCodexRemoteExecutionContext({
      ...input.ctx,
      executionTarget: {
        ...target,
        remoteCwd: sandbox.spec.remoteCwd,
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
    const result = await input.base.execute(patchedCtx);
    if (result.timedOut || (result.exitCode ?? 0) !== 0) {
      return result;
    }

    let finalize;
    try {
      finalize = await sandbox.finalize({
        commitMessage: readString(remoteGit.commitMessage) ?? `Paperclip Codex Remote ${sandbox.spec.workBranch}`,
        push: remoteGit.push !== false,
        timeoutMs,
      });
    } catch (error) {
      return failureResult(error, "codex_remote_finalize_failed");
    }

    return {
      ...result,
      resultJson: {
        ...(result.resultJson ?? {}),
        remoteGit: {
          dirty: finalize.dirty,
          status: finalize.status,
          commitSha: finalize.commitSha,
          pushed: finalize.pushed,
          pushedBranch: finalize.pushedBranch,
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
