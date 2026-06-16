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
  committerName?: string | null;
  committerEmail?: string | null;
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

export interface RemoteGitSandboxSafetyPolicy {
  allowedRepoUrls?: string[];
  protectedBranches?: string[];
  requiredCredentialEnv?: string[];
  approvedEnv?: Record<string, string | null | undefined>;
  redactedSecrets?: string[];
}

export interface RemoteGitSandboxSafetyResult {
  env: Record<string, string>;
  redactedSecrets: string[];
}

const DEFAULT_BASE_REF = "main";
const DEFAULT_COMMITTER_NAME = "Paperclip Agent";
const DEFAULT_COMMITTER_EMAIL = "paperclip-agent@users.noreply.github.com";
const DEFAULT_WORK_BRANCH_PREFIX = "paperclip";
const DEFAULT_PROTECTED_BRANCHES = ["main", "master", "develop", "development", "trunk", "release"];

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

function normalizeRepoUrlForComparison(value: string): string {
  return value
    .trim()
    .replace(/\/\/[^/@]+@/g, "//")
    .replace(/\.git$/i, "")
    .replace(/\/+$/g, "")
    .toLowerCase();
}

function normalizeBranchForComparison(value: string): string {
  return value.trim().replace(/^refs\/heads\//, "").toLowerCase();
}

function isProtectedBranch(branch: string, protectedBranches: string[]): boolean {
  const normalizedBranch = normalizeBranchForComparison(branch);
  return protectedBranches.some((protectedBranch) => {
    const normalizedProtectedBranch = normalizeBranchForComparison(protectedBranch);
    return normalizedBranch === normalizedProtectedBranch || normalizedBranch.startsWith(`${normalizedProtectedBranch}/`);
  });
}

export function redactRemoteGitSandboxSecrets(input: string, secrets: string[] = []): string {
  let redacted = input.replace(/(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, "$1[redacted]@");
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

export function validateRemoteGitSandboxSafety(input: {
  spec: RemoteGitSandboxSpec;
  policy?: RemoteGitSandboxSafetyPolicy | null;
}): RemoteGitSandboxSafetyResult {
  const policy = input.policy ?? {};
  const approvedEnv = Object.fromEntries(
    Object.entries(policy.approvedEnv ?? {}).filter((entry): entry is [string, string] => {
      const [key, value] = entry;
      return /^[A-Z_][A-Z0-9_]*$/i.test(key) && typeof value === "string" && value.length > 0;
    }),
  );

  const redactedSecrets = [
    ...Object.values(approvedEnv).filter((value) => value.length >= 8),
    ...(policy.redactedSecrets ?? []).filter((value) => value.length > 0),
  ];

  const allowedRepoUrls = policy.allowedRepoUrls ?? [];
  if (allowedRepoUrls.length > 0) {
    const normalizedActual = normalizeRepoUrlForComparison(input.spec.repoUrl);
    const repoMatches = allowedRepoUrls.some((repoUrl) => normalizeRepoUrlForComparison(repoUrl) === normalizedActual);
    if (!repoMatches) {
      throw new Error(`Remote Git sandbox repo is not allowed: ${redactRemoteGitSandboxSecrets(input.spec.repoUrl, redactedSecrets)}`);
    }
  }

  const protectedBranches = policy.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES;
  if (isProtectedBranch(input.spec.workBranch, protectedBranches)) {
    throw new Error(`Remote Git sandbox refuses to push protected branch: ${input.spec.workBranch}`);
  }

  for (const envName of policy.requiredCredentialEnv ?? []) {
    if (!approvedEnv[envName]) {
      throw new Error(`Remote Git sandbox missing required credential env: ${envName}`);
    }
  }

  return {
    env: approvedEnv,
    redactedSecrets,
  };
}

export function deriveRemoteGitSandboxSpec(input: {
  workspace: RemoteGitSandboxWorkspaceContext;
  issue?: RemoteGitSandboxIssueContext | null;
  remoteRootDir: string;
  remoteCwd?: string | null;
  workBranch?: string | null;
  workBranchPrefix?: string | null;
  committerName?: string | null;
  committerEmail?: string | null;
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
    committerName: trimOrNull(input.committerName) ?? DEFAULT_COMMITTER_NAME,
    committerEmail: trimOrNull(input.committerEmail) ?? DEFAULT_COMMITTER_EMAIL,
  };
}

function requireSuccess(result: RunProcessResult, action: string, redactedSecrets: string[] = []): RunProcessResult {
  if (result.exitCode === 0 && !result.timedOut) return result;
  const redactedAction = redactRemoteGitSandboxSecrets(action, redactedSecrets);
  const stderr = redactRemoteGitSandboxSecrets(result.stderr.trim(), redactedSecrets);
  const detail = stderr.length > 0 ? `: ${stderr}` : "";
  throw new Error(`${redactedAction} failed with exit code ${result.exitCode ?? "null"}${detail}`);
}

export async function prepareRemoteGitSandbox(input: {
  runner: RemoteGitSandboxRunner;
  spec: RemoteGitSandboxSpec;
  shellCommand?: "bash" | "sh";
  timeoutMs?: number;
  cleanupHooks?: RemoteGitSandboxCleanupHook[];
  safety?: RemoteGitSandboxSafetyPolicy | null;
}): Promise<PreparedRemoteGitSandbox> {
  const shellCommand = input.shellCommand ?? "bash";
  const timeoutMs = input.timeoutMs ?? 300_000;
  const safety = validateRemoteGitSandboxSafety({
    spec: input.spec,
    policy: input.safety,
  });
  const runShell = async (script: string, cwd = "/", runTimeoutMs = timeoutMs) =>
    requireSuccess(
      await input.runner.execute({
        command: shellCommand,
        args: shArgs(script),
        cwd,
        env: safety.env,
        timeoutMs: runTimeoutMs,
      }),
      script,
      safety.redactedSecrets,
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

  // Keep the Paperclip runtime overlay out of git. The bridge and the synced
  // CODEX_HOME (auth.json, config.toml — which can hold provider bearer tokens)
  // live under `<repo>/.paperclip-runtime`. Without this local exclude, the
  // finalize step's `git add -A` would stage and push those secrets to the
  // remote. Using `.git/info/exclude` avoids mutating the repo's tracked files.
  await runShell(
    [
      `mkdir -p ${shellQuote(`${gitDir}/info`)}`,
      `grep -qxF '/.paperclip-runtime/' ${shellQuote(`${gitDir}/info/exclude`)} 2>/dev/null ` +
        `|| printf '%s\\n' '/.paperclip-runtime/' >> ${shellQuote(`${gitDir}/info/exclude`)}`,
    ].join("\n"),
    input.spec.remoteCwd,
  );

  // Set a repo-local git identity. A fresh sandbox has no global git config, so
  // `git commit` aborts with "Author identity unknown" — which silently fails
  // the finalize step (and any commit the agent makes) even after the task work
  // is done. Scoped to this repo so it never touches global config.
  await runShell(
    [
      `git config user.email ${shellQuote(trimOrNull(input.spec.committerEmail) ?? DEFAULT_COMMITTER_EMAIL)}`,
      `git config user.name ${shellQuote(trimOrNull(input.spec.committerName) ?? DEFAULT_COMMITTER_NAME)}`,
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
      env: safety.env,
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
  safety?: RemoteGitSandboxSafetyPolicy | null;
  work: (sandbox: PreparedRemoteGitSandbox) => Promise<T>;
}): Promise<T> {
  const sandbox = await prepareRemoteGitSandbox(input);
  try {
    return await input.work(sandbox);
  } finally {
    await sandbox.cleanup();
  }
}
