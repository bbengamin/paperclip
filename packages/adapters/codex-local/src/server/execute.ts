import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inferOpenAiCompatibleBiller, type AdapterExecutionContext, type AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetShellCommand,
  runAdapterExecutionTargetProcess,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  parseObject,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  resolvePaperclipDesiredSkillNames,
  renderTemplate,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  joinPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import {
  parseCodexJsonl,
  extractCodexRetryNotBefore,
  isCodexTransientUpstreamError,
  isCodexUnknownSessionError,
} from "./parse.js";
import { pathExists, prepareManagedCodexHome, prepareRemoteCodexHomeAsset, resolveManagedCodexHomeDir, resolveSharedCodexHomeDir } from "./codex-home.js";
import { resolveCodexDesiredSkillNames } from "./skills.js";
import { buildCodexExecArgs } from "./codex-args.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const CODEX_ROLLOUT_NOISE_RE =
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+ERROR\s+codex_core::rollout::list:\s+state db missing rollout path for thread\s+[a-z0-9-]+$/i;

function stripCodexRolloutNoise(text: string): string {
  const parts = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      kept.push(part);
      continue;
    }
    if (CODEX_ROLLOUT_NOISE_RE.test(trimmed)) continue;
    kept.push(part);
  }
  return kept.join("\n");
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function sanitizeCodexProgressMessage(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/x-access-token:[^@\s]+@/gi, "x-access-token:[redacted]@")
    .replace(/\b(?:github_pat|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]+/g, "[redacted-token]")
    .replace(/\b(?:PAPERCLIP_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|GH_TOKEN)=\S+/g, "$1=[redacted]")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 500)
    .trim();
}

function summarizeCodexProgressMessage(text: string): string {
  const sanitized = sanitizeCodexProgressMessage(text);
  if (sanitized.length <= 100) return sanitized;
  return `${sanitized.slice(0, 100).trimEnd()}...`;
}

function readCodexProgressFromJsonLine(line: string): string | null {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = parseObject(event);
  const type = asString(parsed.type, "");

  if (type === "turn.started") {
    return "Codex turn started";
  }
  if (type === "turn.completed") {
    return "Codex turn completed";
  }

  if (type !== "item.started" && type !== "item.completed") {
    return null;
  }

  const item = parseObject(parsed.item);
  const itemType = asString(item.type, "");
  if (itemType === "agent_message") {
    return summarizeCodexProgressMessage(asString(item.text, ""));
  }
  if (itemType === "command_execution") {
    return type === "item.started" ? "Running a shell command" : "Shell command completed";
  }
  if (itemType === "file_change" && type === "item.completed") {
    return "Applied file changes";
  }
  if (itemType === "tool_use") {
    const name = summarizeCodexProgressMessage(asString(item.name, "tool"));
    return type === "item.started" ? `Using ${name}` : `${name} completed`;
  }

  return null;
}

function collectCodexProgressMessages(input: { buffer: string; chunk: string }): {
  buffer: string;
  messages: string[];
} {
  const combined = input.buffer + input.chunk;
  const lines = combined.split(/\r?\n/);
  const nextBuffer = lines.pop() ?? "";
  const messages = lines
    .map((line) => readCodexProgressFromJsonLine(line.trim()))
    .filter((message): message is string => Boolean(message));
  return { buffer: nextBuffer, messages };
}

function buildCodexSyntheticProgressJsonl(input: { id: number; message: string }): string {
  return `${JSON.stringify({
    type: "item.completed",
    item: {
      id: `paperclip_progress_${input.id}`,
      type: "agent_message",
      text: input.message,
    },
  })}\n`;
}

async function runSandboxPaperclipPreflight(input: {
  runId: string;
  target: ReturnType<typeof readAdapterExecutionTarget>;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}): Promise<AdapterExecutionResult | null> {
  if (!input.target || input.target.kind !== "remote" || input.target.transport !== "sandbox") {
    return null;
  }

  const script = [
    "set -eu",
    "mkdir -p .paperclip-runtime/codex",
    "probe_file=.paperclip-runtime/codex/preflight-write-check",
    "printf '%s\\n' paperclip-preflight > \"$probe_file\"",
    "rm -f \"$probe_file\"",
    "if [ -n \"${PAPERCLIP_API_URL:-}\" ] && [ -n \"${PAPERCLIP_API_KEY:-}\" ] && [ -n \"${PAPERCLIP_TASK_ID:-}\" ]; then",
    "  curl -fsS -H \"Authorization: Bearer $PAPERCLIP_API_KEY\" \"$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/heartbeat-context\" >/dev/null",
    "fi",
  ].join("\n");

  const result = await runAdapterExecutionTargetShellCommand(
    input.runId,
    input.target,
    script,
    {
      cwd: input.cwd,
      env: input.env,
      timeoutSec: Math.min(Math.max(input.timeoutSec, 1), 30),
      onLog: input.onLog,
    },
  );

  if (!result.timedOut && result.exitCode === 0) return null;

  const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
  const message = result.timedOut
    ? "Codex sandbox preflight timed out before starting Codex."
    : `Codex sandbox preflight failed before starting Codex${detail ? `: ${detail}` : "."}`;
  return {
    exitCode: result.exitCode ?? 1,
    signal: result.signal,
    timedOut: result.timedOut,
    errorMessage: message,
    errorCode: "codex_sandbox_preflight_failed",
    resultJson: {
      phase: "codex_sandbox_preflight",
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    },
  };
}

function resolveCodexBillingType(env: Record<string, string>): "api" | "subscription" {
  // Codex uses API-key auth when OPENAI_API_KEY is present; otherwise rely on local login/session auth.
  return hasNonEmptyEnvValue(env, "OPENAI_API_KEY") ? "api" : "subscription";
}

function resolveCodexBiller(env: Record<string, string>, billingType: "api" | "subscription"): string {
  const openAiCompatibleBiller = inferOpenAiCompatibleBiller(env, "openai");
  if (openAiCompatibleBiller === "openrouter") return "openrouter";
  return billingType === "subscription" ? "chatgpt" : openAiCompatibleBiller ?? "openai";
}

async function isLikelyPaperclipRepoRoot(candidate: string): Promise<boolean> {
  const [hasWorkspace, hasPackageJson, hasServerDir, hasAdapterUtilsDir] = await Promise.all([
    pathExists(path.join(candidate, "pnpm-workspace.yaml")),
    pathExists(path.join(candidate, "package.json")),
    pathExists(path.join(candidate, "server")),
    pathExists(path.join(candidate, "packages", "adapter-utils")),
  ]);

  return hasWorkspace && hasPackageJson && hasServerDir && hasAdapterUtilsDir;
}

async function isLikelyPaperclipRuntimeSkillPath(
  candidate: string,
  skillName: string,
  options: { requireSkillMarkdown?: boolean } = {},
): Promise<boolean> {
  if (path.basename(candidate) !== skillName) return false;
  const skillsRoot = path.dirname(candidate);
  if (path.basename(skillsRoot) !== "skills") return false;
  if (options.requireSkillMarkdown !== false && !(await pathExists(path.join(candidate, "SKILL.md")))) {
    return false;
  }

  let cursor = path.dirname(skillsRoot);
  for (let depth = 0; depth < 6; depth += 1) {
    if (await isLikelyPaperclipRepoRoot(cursor)) return true;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  return false;
}

async function pruneBrokenUnavailablePaperclipSkillSymlinks(
  skillsHome: string,
  allowedSkillNames: Iterable<string>,
  onLog: AdapterExecutionContext["onLog"],
) {
  const allowed = new Set(Array.from(allowedSkillNames));
  const entries = await fs.readdir(skillsHome, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (allowed.has(entry.name) || !entry.isSymbolicLink()) continue;

    const target = path.join(skillsHome, entry.name);
    const linkedPath = await fs.readlink(target).catch(() => null);
    if (!linkedPath) continue;

    const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
    if (await pathExists(resolvedLinkedPath)) continue;
    if (
      !(await isLikelyPaperclipRuntimeSkillPath(resolvedLinkedPath, entry.name, {
        requireSkillMarkdown: false,
      }))
    ) {
      continue;
    }

    await fs.unlink(target).catch(() => {});
    await onLog(
      "stdout",
      `[paperclip] Removed stale Codex skill "${entry.name}" from ${skillsHome}\n`,
    );
  }
}

function resolveCodexSkillsDir(codexHome: string): string {
  return path.join(codexHome, "skills");
}

type EnsureCodexSkillsInjectedOptions = {
  skillsHome?: string;
  skillsEntries?: Array<{ key: string; runtimeName: string; source: string }>;
  desiredSkillNames?: string[];
  injectionMode?: "symlink" | "copy";
  linkSkill?: (source: string, target: string) => Promise<void>;
};

function isFilesystemPermissionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "EPERM" || code === "EACCES";
}

async function copyCodexSkillFallback(
  source: string,
  target: string,
  options: { repairExisting?: boolean } = {},
): Promise<"created" | "repaired" | "skipped"> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing?.isSymbolicLink()) {
    await fs.unlink(target);
  } else if (existing?.isDirectory() && options.repairExisting === true) {
    await fs.rm(target, { recursive: true, force: true });
  } else if (existing) {
    return "skipped";
  }
  await fs.cp(source, target, { recursive: true, dereference: true });
  return existing ? "repaired" : "created";
}

type CodexTransientFallbackMode =
  | "same_session"
  | "safer_invocation"
  | "fresh_session"
  | "fresh_session_safer_invocation";

function readCodexTransientFallbackMode(context: Record<string, unknown>): CodexTransientFallbackMode | null {
  const value = asString(context.codexTransientFallbackMode, "").trim();
  switch (value) {
    case "same_session":
    case "safer_invocation":
    case "fresh_session":
    case "fresh_session_safer_invocation":
      return value;
    default:
      return null;
  }
}

function fallbackModeUsesSaferInvocation(mode: CodexTransientFallbackMode | null): boolean {
  return mode === "safer_invocation" || mode === "fresh_session_safer_invocation";
}

function fallbackModeUsesFreshSession(mode: CodexTransientFallbackMode | null): boolean {
  return mode === "fresh_session" || mode === "fresh_session_safer_invocation";
}

function buildCodexTransientHandoffNote(input: {
  previousSessionId: string | null;
  fallbackMode: CodexTransientFallbackMode;
  continuationSummaryBody: string | null;
}): string {
  return [
    "Paperclip session handoff:",
    input.previousSessionId ? `- Previous session: ${input.previousSessionId}` : "",
    "- Rotation reason: repeated Codex transient remote-compaction failures",
    `- Fallback mode: ${input.fallbackMode}`,
    input.continuationSummaryBody
      ? `- Issue continuation summary: ${input.continuationSummaryBody.slice(0, 1_500)}`
      : "",
    "Continue from the current task state. Rebuild only the minimum context you need.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function ensureCodexSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  options: EnsureCodexSkillsInjectedOptions = {},
) {
  const allSkillsEntries = options.skillsEntries ?? await readPaperclipRuntimeSkillEntries({}, __moduleDir);
  const desiredSkillNames =
    options.desiredSkillNames ?? allSkillsEntries.map((entry) => entry.key);
  const desiredSet = new Set(desiredSkillNames);
  const skillsEntries = allSkillsEntries.filter((entry) => desiredSet.has(entry.key));
  if (skillsEntries.length === 0) return;

  const skillsHome = options.skillsHome ?? resolveCodexSkillsDir(resolveSharedCodexHomeDir());
  await fs.mkdir(skillsHome, { recursive: true });
  const linkSkill = options.linkSkill;
  const injectionMode = options.injectionMode ?? "symlink";
  for (const entry of skillsEntries) {
    const target = path.join(skillsHome, entry.runtimeName);

    try {
      if (injectionMode === "copy") {
        const result = await copyCodexSkillFallback(entry.source, target, { repairExisting: true });
        if (result === "skipped") continue;
        await onLog(
          "stdout",
          `[paperclip] ${result === "repaired" ? "Repaired" : "Copied"} Codex skill "${entry.runtimeName}" into ${skillsHome}\n`,
        );
        continue;
      }

      const existing = await fs.lstat(target).catch(() => null);
      if (existing?.isSymbolicLink()) {
        const linkedPath = await fs.readlink(target).catch(() => null);
        const resolvedLinkedPath = linkedPath
          ? path.resolve(path.dirname(target), linkedPath)
          : null;
        if (
          resolvedLinkedPath &&
          resolvedLinkedPath !== entry.source &&
          (await isLikelyPaperclipRuntimeSkillPath(resolvedLinkedPath, entry.runtimeName))
        ) {
          await fs.unlink(target);
          if (linkSkill) {
            await linkSkill(entry.source, target);
          } else {
            await fs.symlink(entry.source, target);
          }
          await onLog(
            "stdout",
            `[paperclip] Repaired Codex skill "${entry.runtimeName}" into ${skillsHome}\n`,
          );
          continue;
        }
      }

      const result = await ensurePaperclipSkillSymlink(entry.source, target, linkSkill);
      if (result === "skipped") continue;

      await onLog(
        "stdout",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} Codex skill "${entry.runtimeName}" into ${skillsHome}\n`,
      );
    } catch (err) {
      if (!linkSkill && isFilesystemPermissionError(err)) {
        try {
          const result = await copyCodexSkillFallback(entry.source, target);
          if (result !== "skipped") {
            await onLog(
              "stdout",
              `[paperclip] ${result === "repaired" ? "Repaired" : "Copied"} Codex skill "${entry.runtimeName}" into ${skillsHome} because symlinks are unavailable\n`,
            );
            continue;
          }
        } catch {
          // Fall through to the original diagnostic below.
        }
      }
      await onLog(
        "stderr",
        `[paperclip] Failed to inject Codex skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  await pruneBrokenUnavailablePaperclipSkillSymlinks(
    skillsHome,
    skillsEntries.map((entry) => entry.runtimeName),
    onLog,
  );
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "codex");
  const model = asString(config.model, "");

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const workspaceBranch = asString(workspaceContext.branchName, "");
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServiceIntents = Array.isArray(context.paperclipRuntimeServiceIntents)
    ? context.paperclipRuntimeServiceIntents.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServices = Array.isArray(context.paperclipRuntimeServices)
    ? context.paperclipRuntimeServices.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimePrimaryUrl = asString(context.paperclipRuntimePrimaryUrl, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  const envConfig = parseObject(config.env);
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);
  const executionTargetIsSandbox =
    executionTarget?.kind === "remote" && executionTarget.transport === "sandbox";
  const remoteGitSandboxConfig = parseObject(config.remoteGitSandbox);
  const providerRealizedRemoteGitWorkspace =
    executionTargetIsRemote && remoteGitSandboxConfig.enabled === true;
  const configuredCodexHome =
    typeof envConfig.CODEX_HOME === "string" && envConfig.CODEX_HOME.trim().length > 0
      ? path.resolve(envConfig.CODEX_HOME.trim())
      : null;
  const codexSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = resolveCodexDesiredSkillNames(config, codexSkillEntries);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  const configuredOpenAiApiKey =
    typeof envConfig.OPENAI_API_KEY === "string" && envConfig.OPENAI_API_KEY.trim().length > 0
      ? envConfig.OPENAI_API_KEY.trim()
      : null;
  const preparedManagedCodexHome =
    configuredCodexHome
      ? null
      : await prepareManagedCodexHome(process.env, onLog, agent.companyId, {
          apiKey: configuredOpenAiApiKey,
        });
  const defaultCodexHome = resolveManagedCodexHomeDir(process.env, agent.companyId);
  const effectiveCodexHome = configuredCodexHome ?? preparedManagedCodexHome ?? defaultCodexHome;
  await fs.mkdir(effectiveCodexHome, { recursive: true });
  // Inject skills into the same CODEX_HOME that Codex will actually run with
  // (managed home in the default case, or an explicit override from adapter config).
  const codexSkillsDir = resolveCodexSkillsDir(effectiveCodexHome);
  await ensureCodexSkillsInjected(
    onLog,
    {
      skillsHome: codexSkillsDir,
      skillsEntries: codexSkillEntries,
      desiredSkillNames,
      injectionMode: executionTargetIsSandbox ? "copy" : "symlink",
    },
  );
  const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
    executionTarget,
    asNumber(config.timeoutSec, 0),
  );
  const graceSec = asNumber(config.graceSec, 20);
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  // For remote runs, sync a sandbox-sanitized copy of the Codex home so the
  // sandbox does not inherit host-only config.toml sections (notably
  // `mcp_servers`, which point at host binaries and stall Codex for each
  // server's startup_timeout_sec on every run).
  const remoteCodexHomeAsset = executionTargetIsRemote
    ? await prepareRemoteCodexHomeAsset(effectiveCodexHome)
    : null;
  const remoteCodexHomeAssetDir = remoteCodexHomeAsset?.dir ?? effectiveCodexHome;
  const preparedExecutionTargetRuntime = executionTargetIsRemote
    ? await (async () => {
        await onLog(
          "stdout",
          providerRealizedRemoteGitWorkspace
            ? `[paperclip] Syncing CODEX_HOME to ${describeAdapterExecutionTarget(executionTarget)}; using provider-realized remote Git workspace at ${effectiveExecutionCwd} (skipping workspace archive sync).\n`
            : `[paperclip] Syncing workspace and CODEX_HOME to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
        );
        return await prepareAdapterExecutionTargetRuntime({
          runId,
          target: executionTarget,
          adapterKey: "codex",
          timeoutSec,
          workspaceLocalDir: cwd,
          // For a provider-realized remote Git workspace, the repo is already
          // cloned at the remote cwd. Anchor the runtime (and thus the synced
          // CODEX_HOME asset) there without overwriting the clone.
          ...(providerRealizedRemoteGitWorkspace
            ? { workspaceRemoteDir: effectiveExecutionCwd, syncWorkspace: false }
            : {}),
          installCommand: SANDBOX_INSTALL_COMMAND,
          detectCommand: command,
          assets: [
            {
              key: "home",
              localDir: remoteCodexHomeAssetDir,
              followSymlinks: true,
            },
          ],
        });
      })().catch(async (error) => {
        await remoteCodexHomeAsset?.cleanup();
        throw error;
      })
    : null;
  if (preparedExecutionTargetRuntime?.workspaceRemoteDir) {
    effectiveExecutionCwd = preparedExecutionTargetRuntime.workspaceRemoteDir;
  }
  const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
  const restoreRemoteWorkspace = preparedExecutionTargetRuntime
    ? () => preparedExecutionTargetRuntime.restoreWorkspace()
    : null;
  let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;
  let codexProgressBuffer = "";
  let latestCodexProgressMessage: string | null = null;
  let lastEmittedCodexProgressMessage: string | null = null;
  let bridgeAliveWithoutCodexOutputEmitted = false;
  let syntheticProgressId = 0;
  const remoteCodexHome = executionTargetIsRemote
    ? preparedExecutionTargetRuntime?.assetDirs.home ??
      path.posix.join(effectiveExecutionCwd, ".paperclip-runtime", "codex", "home")
    : null;
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (wakeTaskId) {
    env.PAPERCLIP_TASK_ID = wakeTaskId;
  }
  if (issueWorkMode) {
    env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  }
  if (wakeReason) {
    env.PAPERCLIP_WAKE_REASON = wakeReason;
  }
  if (wakeCommentId) {
    env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  }
  if (approvalId) {
    env.PAPERCLIP_APPROVAL_ID = approvalId;
  }
  if (approvalStatus) {
    env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  }
  if (linkedIssueIds.length > 0) {
    env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  }
  if (wakePayloadJson) {
    env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  }
  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceStrategy,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceBranch,
    workspaceWorktreePath,
    workspaceHints,
    agentHome,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  if (runtimeServiceIntents.length > 0) {
    env.PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON = JSON.stringify(runtimeServiceIntents);
  }
  if (runtimeServices.length > 0) {
    env.PAPERCLIP_RUNTIME_SERVICES_JSON = JSON.stringify(runtimeServices);
  }
  if (runtimePrimaryUrl) {
    env.PAPERCLIP_RUNTIME_PRIMARY_URL = runtimePrimaryUrl;
  }
  // Point Codex at the synced remote home (which carries config.toml — including
  // the model_provider/base_url and any bearer token — plus auth.json) so a
  // provider-realized remote Git sandbox uses the configured provider instead of
  // falling back to the default api.openai.com endpoint. `remoteCodexHome` is the
  // remote location of the synced `effectiveCodexHome` (which already reflects an
  // explicit CODEX_HOME override), so this remapping preserves configured homes.
  env.CODEX_HOME = remoteCodexHome ?? effectiveCodexHome;
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(runtimeExecutionTarget)) {
    paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
      runId,
      target: runtimeExecutionTarget,
      runtimeRootDir: preparedExecutionTargetRuntime?.runtimeRootDir,
      adapterKey: "codex",
      timeoutSec,
      hostApiToken: env.PAPERCLIP_API_KEY,
      onLog,
      onActivity: async (activity) => {
        if (activity.source !== "sandbox_bridge" || activity.status !== "alive") return;
        const progress = latestCodexProgressMessage
          ? summarizeCodexProgressMessage(latestCodexProgressMessage)
          : "";
        if (!progress) {
          if (bridgeAliveWithoutCodexOutputEmitted) return;
          bridgeAliveWithoutCodexOutputEmitted = true;
          syntheticProgressId += 1;
          await onLog("stdout", buildCodexSyntheticProgressJsonl({
            id: syntheticProgressId,
            message: "Sandbox bridge alive; waiting for Codex output",
          }));
          return;
        }
        if (progress === lastEmittedCodexProgressMessage) return;
        lastEmittedCodexProgressMessage = progress;
        const message = `Still working: ${progress}`;
        syntheticProgressId += 1;
        await onLog("stdout", buildCodexSyntheticProgressJsonl({
          id: syntheticProgressId,
          message,
        }));
      },
    });
    if (paperclipBridge) {
      Object.assign(env, paperclipBridge.env);
    }
  }
  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const billingType = resolveCodexBillingType(effectiveEnv);
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv(effectiveEnv)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  await ensureAdapterExecutionTargetRuntimeCommandInstalled({
    runId,
    target: executionTarget,
    installCommand: ctx.runtimeCommandSpec?.installCommand,
    detectCommand: ctx.runtimeCommandSpec?.detectCommand,
    cwd,
    env: runtimeEnv,
    timeoutSec,
    graceSec,
    onLog,
  });
  await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv);
  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(effectiveExecutionCwd)) &&
    adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
  const codexTransientFallbackMode = readCodexTransientFallbackMode(context);
  const forceSaferInvocation = fallbackModeUsesSaferInvocation(codexTransientFallbackMode);
  const forceFreshSession = fallbackModeUsesFreshSession(codexTransientFallbackMode);
  const sessionId = canResumeSession && !forceFreshSession ? runtimeSessionId : null;
  if (executionTargetIsRemote && runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Codex session "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh remote session.\n`,
    );
  } else if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Codex session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".\n`,
    );
  }
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  let instructionsChars = 0;
  if (instructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
      instructionsChars = instructionsPrefix.length;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }
  const repoAgentsNote =
    "Codex exec automatically applies repo-scoped AGENTS.md instructions from the current workspace; Paperclip does not currently suppress that discovery.";
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
  const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
  const promptInstructionsPrefix = shouldUseResumeDeltaPrompt ? "" : instructionsPrefix;
  instructionsChars = promptInstructionsPrefix.length;
  const continuationSummary = parseObject(context.paperclipContinuationSummary);
  const continuationSummaryBody = asString(continuationSummary.body, "").trim() || null;
  const codexFallbackHandoffNote =
    forceFreshSession
      ? buildCodexTransientHandoffNote({
          previousSessionId: runtimeSessionId || runtime.sessionId || null,
          fallbackMode: codexTransientFallbackMode ?? "fresh_session",
          continuationSummaryBody,
        })
      : "";
  const commandNotes = (() => {
    if (!instructionsFilePath) {
      const notes = [repoAgentsNote];
      if (forceSaferInvocation) {
        notes.push("Codex transient fallback requested safer invocation settings for this retry.");
      }
      if (forceFreshSession) {
        notes.push("Codex transient fallback forced a fresh session with a continuation handoff.");
      }
      return notes;
    }
    if (instructionsPrefix.length > 0) {
      if (shouldUseResumeDeltaPrompt) {
        const notes = [
          `Loaded agent instructions from ${instructionsFilePath}`,
          "Skipped stdin instruction reinjection because an existing Codex session is being resumed with a wake delta.",
          repoAgentsNote,
        ];
        if (forceSaferInvocation) {
          notes.push("Codex transient fallback requested safer invocation settings for this retry.");
        }
        if (forceFreshSession) {
          notes.push("Codex transient fallback forced a fresh session with a continuation handoff.");
        }
        return notes;
      }
      const notes = [
        `Loaded agent instructions from ${instructionsFilePath}`,
        `Prepended instructions + path directive to stdin prompt (relative references from ${instructionsDir}).`,
        repoAgentsNote,
      ];
      if (forceSaferInvocation) {
        notes.push("Codex transient fallback requested safer invocation settings for this retry.");
      }
      if (forceFreshSession) {
        notes.push("Codex transient fallback forced a fresh session with a continuation handoff.");
      }
      return notes;
    }
    const notes = [
      `Configured instructionsFilePath ${instructionsFilePath}, but file could not be read; continuing without injected instructions.`,
      repoAgentsNote,
    ];
    if (forceSaferInvocation) {
      notes.push("Codex transient fallback requested safer invocation settings for this retry.");
    }
    if (forceFreshSession) {
      notes.push("Codex transient fallback forced a fresh session with a continuation handoff.");
    }
    return notes;
  })();
  if (executionTargetIsSandbox) {
    commandNotes.push(
      "Added --skip-git-repo-check for sandbox execution because Codex requires an explicit trust bypass in headless remote workspaces.",
    );
  }
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([
    promptInstructionsPrefix,
    renderedBootstrapPrompt,
    wakePrompt,
    codexFallbackHandoffNote,
    sessionHandoffNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    instructionsChars,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const execArgs = buildCodexExecArgs(
      forceSaferInvocation ? { ...config, fastMode: false } : config,
      {
        resumeSessionId,
        skipGitRepoCheck: executionTargetIsSandbox,
        isolatePaperclipTaskSystem: executionTargetIsSandbox,
      },
    );
    const args = execArgs.args;
    const commandNotesWithFastMode =
      execArgs.fastModeIgnoredReason == null
        ? commandNotes
        : [...commandNotes, execArgs.fastModeIgnoredReason];
    if (onMeta) {
      await onMeta({
        adapterType: "codex_local",
        command: resolvedCommand,
        cwd: effectiveExecutionCwd,
        commandNotes: commandNotesWithFastMode,
        commandArgs: args.map((value, idx) => {
          if (idx === args.length - 1 && value !== "-") return `<prompt ${prompt.length} chars>`;
          return value;
        }),
        env: loggedEnv,
        prompt,
        promptMetrics,
        context,
      });
    }

    const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
      cwd,
      env,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog: async (stream, chunk) => {
        if (stream === "stdout") {
          const collected = collectCodexProgressMessages({ buffer: codexProgressBuffer, chunk });
          codexProgressBuffer = collected.buffer;
          for (const message of collected.messages) {
            latestCodexProgressMessage = message;
          }
        }
        if (stream !== "stderr") {
          await onLog(stream, chunk);
          return;
        }
        const cleaned = stripCodexRolloutNoise(chunk);
        if (!cleaned.trim()) return;
        await onLog(stream, cleaned);
      },
    });
    const cleanedStderr = stripCodexRolloutNoise(proc.stderr);
    return {
      proc: {
        ...proc,
        stderr: cleanedStderr,
      },
      rawStderr: proc.stderr,
      parsed: parseCodexJsonl(proc.stdout),
    };
  };

  const toResult = (
    attempt: { proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string }; rawStderr: string; parsed: ReturnType<typeof parseCodexJsonl> },
    clearSessionOnMissingSession = false,
    isRetry = false,
  ): AdapterExecutionResult => {
    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        clearSession: clearSessionOnMissingSession,
      };
    }

    const canFallbackToRuntimeSession = !isRetry && !forceFreshSession;
    const resolvedSessionId =
      attempt.parsed.sessionId ??
      (canFallbackToRuntimeSession ? (runtimeSessionId ?? runtime.sessionId ?? null) : null);
    const resolvedSessionParams = resolvedSessionId
      ? ({
        sessionId: resolvedSessionId,
        cwd: effectiveExecutionCwd,
        ...(executionTargetIsRemote
          ? {
              remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget),
            }
          : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      } as Record<string, unknown>)
      : null;
    const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
    const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
    const fallbackErrorMessage =
      parsedError ||
      stderrLine ||
      `Codex exited with code ${attempt.proc.exitCode ?? -1}`;
    const transientRetryNotBefore =
      (attempt.proc.exitCode ?? 0) !== 0
        ? extractCodexRetryNotBefore({
            stdout: attempt.proc.stdout,
            stderr: attempt.proc.stderr,
            errorMessage: fallbackErrorMessage,
          })
        : null;
    const transientUpstream =
      (attempt.proc.exitCode ?? 0) !== 0 &&
      isCodexTransientUpstreamError({
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
        errorMessage: fallbackErrorMessage,
      });

    return {
      exitCode: attempt.proc.exitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage:
        (attempt.proc.exitCode ?? 0) === 0
          ? null
          : fallbackErrorMessage,
      errorCode:
        transientUpstream
          ? "codex_transient_upstream"
          : null,
      errorFamily: transientUpstream ? "transient_upstream" : null,
      retryNotBefore: transientRetryNotBefore ? transientRetryNotBefore.toISOString() : null,
      usage: attempt.parsed.usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "openai",
      biller: resolveCodexBiller(effectiveEnv, billingType),
      model,
      billingType,
      costUsd: null,
      resultJson: {
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
        ...(transientUpstream ? { errorFamily: "transient_upstream" } : {}),
        ...(transientRetryNotBefore ? { retryNotBefore: transientRetryNotBefore.toISOString() } : {}),
        ...(transientRetryNotBefore ? { transientRetryNotBefore: transientRetryNotBefore.toISOString() } : {}),
      },
      summary: attempt.parsed.summary,
      clearSession: Boolean((clearSessionOnMissingSession || forceFreshSession) && !resolvedSessionId),
    };
  };

  try {
    const preflightFailure = await runSandboxPaperclipPreflight({
      runId,
      target: runtimeExecutionTarget ?? null,
      cwd: effectiveExecutionCwd,
      env: runtimeEnv,
      timeoutSec,
      onLog,
    });
    if (preflightFailure) return preflightFailure;

    const initial = await runAttempt(sessionId);
    if (
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      isCodexUnknownSessionError(initial.proc.stdout, initial.rawStderr)
    ) {
      await onLog(
        "stdout",
        `[paperclip] Codex resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
      );
      const retry = await runAttempt(null);
      return toResult(retry, true, true);
    }

    return toResult(initial, false, false);
  } finally {
    if (paperclipBridge) {
      await paperclipBridge.stop();
    }
    if (restoreRemoteWorkspace) {
      await onLog(
        "stdout",
        `[paperclip] Restoring workspace changes from ${describeAdapterExecutionTarget(executionTarget)}.\n`,
      );
      await restoreRemoteWorkspace();
    }
    await remoteCodexHomeAsset?.cleanup();
  }
}
