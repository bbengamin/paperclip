import type { RunProcessResult } from "./server-utils.js";

export interface RemoteGitSandboxRunner {
  execute(input: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string;
    timeoutMs?: number;
    onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
  }): Promise<RunProcessResult>;
}

export interface RemoteGitSandboxWorkspaceContext {
  repoUrl?: string | null;
  repoRef?: string | null;
  defaultRef?: string | null;
  name?: string | null;
  cwd?: string | null;
  setupCommand?: string | null;
  cleanupCommand?: string | null;
}

export interface RemoteGitSandboxIssueContext {
  id?: string | null;
  identifier?: string | null;
  issueNumber?: number | null;
}

export interface RemoteGitSandboxSpec {
  repoUrl: string;
  baseRef: string;
  workBranch: string;
  remoteCwd: string;
  setupCommand: string | null;
  cleanupCommand: string | null;
}

export interface PreparedRemoteGitSandbox {
  spec: RemoteGitSandboxSpec;
  runInRepo(command: string, options?: { timeoutMs?: number }): Promise<RunProcessResult>;
  finalize(options?: RemoteGitSandboxFinalizeOptions): Promise<RemoteGitSandboxFinalizeResult>;
  cleanup(): Promise<void>;
}

export interface RemoteGitSandboxFinalizeOptions {
  commitMessage?: string | null;
  push?: boolean;
  timeoutMs?: number;
}

export interface RemoteGitSandboxFinalizeResult {
  dirty: boolean;
  status: string;
  commitSha: string | null;
  pushed: boolean;
  pushedBranch: string | null;
}

export interface RemoteGitSandboxCleanupHook {
  (spec: RemoteGitSandboxSpec): Promise<void>;
}

const DEFAULT_BASE_REF = "main";
const DEFAULT_WORK_BRANCH_PREFIX = "paperclip";

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function shArgs(script: string): string[] {
  return ["-lc", script];
}

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeBranchPart(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^[/.]+|[/.]+$/g, "")
    .replace(/\.lock$/i, "lock");
}

function sanitizePathPart(value: string): string {
  return sanitizeBranchPart(value).replace(/\//g, "-") || "workspace";
}

export function deriveRemoteGitSandboxSpec(input: {
  workspace: RemoteGitSandboxWorkspaceContext;
  issue?: RemoteGitSandboxIssueContext | null;
  remoteRootDir: string;
  remoteCwd?: string | null;
  workBranch?: string | null;
  workBranchPrefix?: string | null;
}): RemoteGitSandboxSpec {
  const repoUrl = trimOrNull(input.workspace.repoUrl);
  if (!repoUrl) {
    throw new Error("Remote Git sandbox requires a workspace repoUrl");
  }

  const baseRef = trimOrNull(input.workspace.repoRef) ?? trimOrNull(input.workspace.defaultRef) ?? DEFAULT_BASE_REF;
  const issueKey =
    trimOrNull(input.issue?.identifier) ??
    (typeof input.issue?.issueNumber === "number" ? `issue-${input.issue.issueNumber}` : null) ??
    trimOrNull(input.issue?.id) ??
    "work";
  const branchPrefix = trimOrNull(input.workBranchPrefix) ?? DEFAULT_WORK_BRANCH_PREFIX;
  const workBranch = sanitizeBranchPart(trimOrNull(input.workBranch) ?? `${branchPrefix}/${issueKey}`);
  if (!workBranch) {
    throw new Error("Remote Git sandbox requires a non-empty work branch");
  }

  const workspaceName = trimOrNull(input.workspace.name) ?? "workspace";
  const remoteRootDir = trimOrNull(input.remoteRootDir);
  if (!remoteRootDir) {
    throw new Error("Remote Git sandbox requires a remoteRootDir");
  }
  const remoteCwd =
    trimOrNull(input.remoteCwd) ??
    trimOrNull(input.workspace.cwd) ??
    `${remoteRootDir.replace(/\/+$/g, "")}/${sanitizePathPart(workspaceName)}`;

  return {
    repoUrl,
    baseRef,
    workBranch,
    remoteCwd,
    setupCommand: trimOrNull(input.workspace.setupCommand),
    cleanupCommand: trimOrNull(input.workspace.cleanupCommand),
  };
}

function requireSuccess(result: RunProcessResult, action: string): RunProcessResult {
  if (result.exitCode === 0 && !result.timedOut) return result;
  const stderr = result.stderr.trim();
  const detail = stderr.length > 0 ? `: ${stderr}` : "";
  throw new Error(`${action} failed with exit code ${result.exitCode ?? "null"}${detail}`);
}

export async function prepareRemoteGitSandbox(input: {
  runner: RemoteGitSandboxRunner;
  spec: RemoteGitSandboxSpec;
  shellCommand?: "bash" | "sh";
  timeoutMs?: number;
  cleanupHooks?: RemoteGitSandboxCleanupHook[];
}): Promise<PreparedRemoteGitSandbox> {
  const shellCommand = input.shellCommand ?? "bash";
  const timeoutMs = input.timeoutMs ?? 300_000;
  const runShell = async (script: string, cwd = "/", runTimeoutMs = timeoutMs) =>
    requireSuccess(
      await input.runner.execute({
        command: shellCommand,
        args: shArgs(script),
        cwd,
        timeoutMs: runTimeoutMs,
      }),
      script,
    );

  const gitDir = `${input.spec.remoteCwd.replace(/\/+$/g, "")}/.git`;
  await runShell(
    [
      `mkdir -p ${shellQuote(input.spec.remoteCwd.replace(/\/[^/]*$/g, "") || "/")}`,
      `if [ -d ${shellQuote(gitDir)} ]; then`,
      `  cd ${shellQuote(input.spec.remoteCwd)}`,
      `  git remote set-url origin ${shellQuote(input.spec.repoUrl)}`,
      "  git fetch origin --prune",
      "else",
      `  rm -rf ${shellQuote(input.spec.remoteCwd)}`,
      `  git clone --no-checkout ${shellQuote(input.spec.repoUrl)} ${shellQuote(input.spec.remoteCwd)}`,
      "fi",
    ].join("\n"),
  );

  await runShell(
    [
      `git fetch origin ${shellQuote(input.spec.baseRef)}`,
      `if git show-ref --verify --quiet refs/heads/${shellQuote(input.spec.workBranch)}; then`,
      `  git checkout ${shellQuote(input.spec.workBranch)}`,
      "else",
      `  git checkout -B ${shellQuote(input.spec.workBranch)} FETCH_HEAD`,
      "fi",
    ].join("\n"),
    input.spec.remoteCwd,
  );

  if (input.spec.setupCommand) {
    await runShell(input.spec.setupCommand, input.spec.remoteCwd);
  }

  const runInRepo = async (command: string, options: { timeoutMs?: number } = {}) =>
    input.runner.execute({
      command: shellCommand,
      args: shArgs(command),
      cwd: input.spec.remoteCwd,
      timeoutMs: options.timeoutMs ?? timeoutMs,
    });

  const cleanup = async () => {
    let firstError: unknown = null;
    if (input.spec.cleanupCommand) {
      try {
        await runShell(input.spec.cleanupCommand, input.spec.remoteCwd);
      } catch (error) {
        firstError ??= error;
      }
    }
    for (const hook of input.cleanupHooks ?? []) {
      try {
        await hook(input.spec);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  };

  const finalize = async (options: RemoteGitSandboxFinalizeOptions = {}): Promise<RemoteGitSandboxFinalizeResult> => {
    const statusResult = requireSuccess(await runInRepo("git status --porcelain=v1", options), "git status");
    const status = statusResult.stdout.trim();
    const dirty = status.length > 0;
    let commitSha: string | null = null;
    let pushed = false;
    let pushedBranch: string | null = null;

    if (dirty) {
      const commitMessage = trimOrNull(options.commitMessage) ?? `Paperclip remote work ${input.spec.workBranch}`;
      await runShell(
        `git add -A && git commit -m ${shellQuote(commitMessage)} && git rev-parse HEAD`,
        input.spec.remoteCwd,
        options.timeoutMs ?? timeoutMs,
      );
      const shaResult = requireSuccess(await runInRepo("git rev-parse HEAD", options), "git rev-parse HEAD");
      commitSha = shaResult.stdout.trim() || null;
    }

    if (options.push !== false && dirty) {
      await runShell(
        `git push origin HEAD:refs/heads/${shellQuote(input.spec.workBranch)}`,
        input.spec.remoteCwd,
        options.timeoutMs ?? timeoutMs,
      );
      pushed = true;
      pushedBranch = input.spec.workBranch;
    }

    return {
      dirty,
      status,
      commitSha,
      pushed,
      pushedBranch,
    };
  };

  return {
    spec: input.spec,
    runInRepo,
    finalize,
    cleanup,
  };
}

export async function withRemoteGitSandbox<T>(input: {
  runner: RemoteGitSandboxRunner;
  spec: RemoteGitSandboxSpec;
  shellCommand?: "bash" | "sh";
  timeoutMs?: number;
  cleanupHooks?: RemoteGitSandboxCleanupHook[];
  work: (sandbox: PreparedRemoteGitSandbox) => Promise<T>;
}): Promise<T> {
  const sandbox = await prepareRemoteGitSandbox(input);
  try {
    return await input.work(sandbox);
  } finally {
    await sandbox.cleanup();
  }
}
