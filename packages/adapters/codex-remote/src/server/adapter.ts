/**
 * External adapter entry point.
 *
 * Paperclip's adapter-plugin store loads an external adapter package by
 * importing its main entry and calling `createServerAdapter()`, which must
 * return a complete `ServerAdapterModule`. This module assembles the
 * standalone codex_remote adapter from the package's own building blocks plus
 * the sandbox preflight / remote-default behavior that previously lived in a
 * host-side registry wrapper — so nothing needs to change in upstream
 * Paperclip to register this adapter.
 */
import {
  buildSandboxNpmInstallCommand,
  getAdapterSessionManagement,
  type AdapterExecutionContext,
  type AdapterExecutionResult,
  type AdapterRuntimeCommandSpec,
  type ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import type {
  AdapterExecutionTarget,
  AdapterSandboxExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";

import { execute as baseExecute } from "./execute.js";
import { testEnvironment as baseTestEnvironment } from "./test.js";
import { listCodexSkills, syncCodexSkills } from "./skills.js";
import { sessionCodec, getQuotaWindows } from "./index.js";
import { models, modelProfiles, agentConfigurationDoc, type } from "../index.js";

export const CODEX_REMOTE_TYPE = type;

const DEFAULT_REMOTE_TIMEOUT_SEC = 1_800;
const CODEX_RUNTIME_PACKAGE = "@openai/codex";
const CODEX_RUNTIME_FALLBACK_COMMAND = "codex";

type CodexRemoteSandboxTarget = AdapterSandboxExecutionTarget & {
  runner: CommandManagedRuntimeRunner;
};

type CodexRemoteExecutionTarget = Extract<AdapterExecutionTarget, { kind: "remote" }>;

function requireRemoteTarget(ctx: AdapterExecutionContext): CodexRemoteExecutionTarget {
  const target = ctx.executionTarget;
  if (!target || target.kind !== "remote") {
    throw new Error("codex_remote requires a remote execution target.");
  }
  if (target.transport === "sandbox" && !target.runner) {
    throw new Error("codex_remote requires a sandbox runner from the environment provider.");
  }
  return target;
}

function isSandboxTarget(target: CodexRemoteExecutionTarget): target is CodexRemoteSandboxTarget {
  return target.transport === "sandbox";
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
    dangerouslyBypassApprovalsAndSandbox: true,
    // Codex Remote is sandbox-runtime only. The agent owns repository cloning
    // and Git finalization when the task requires them, so do not upload the
    // host workspace or request provider Git-clone realization.
    remoteWorkspaceSync: false,
  };
}

async function verifySandboxWorkspace(input: {
  ctx: AdapterExecutionContext;
  target: CodexRemoteSandboxTarget;
  bridgeChannel?: boolean;
}): Promise<void> {
  const shell = input.target.shellCommand === "sh" ? "sh" : "bash";
  const marker = input.bridgeChannel ? "BRIDGE_SESSION_OK" : "WORKSPACE_OK";
  const label = input.bridgeChannel ? "bridge channel" : "main session";
  const result = await input.target.runner.execute({
    command: shell,
    args: [
      "-c",
      `mkdir -p ${JSON.stringify(input.target.remoteCwd)} && ls -la ${JSON.stringify(input.target.remoteCwd)} 2>&1 && echo ${marker}`,
    ],
    cwd: "/",
    env: input.bridgeChannel ? { PAPERCLIP_SANDBOX_EXEC_CHANNEL: "bridge" } : undefined,
    timeoutMs: input.bridgeChannel ? 90_000 : 30_000,
  });
  if (result.timedOut || (result.exitCode ?? 1) !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(
      `codex_remote sandbox workspace verify (${label}) failed with exit=${result.exitCode ?? "null"} timedOut=${result.timedOut}${detail ? `: ${detail}` : ""}`,
    );
  }
  await input.ctx.onLog(
    "stdout",
    `[paperclip] codex_remote workspace verify (${label}): exit=${result.exitCode} timedOut=${result.timedOut}\n${result.stdout || ""}\n${result.stderr || ""}`,
  );
}

async function executeCodexRemote(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const target = requireRemoteTarget(ctx);
  const config = applyCodexRemoteDefaults(ctx.config);
  const codexRunTimeoutMs =
    typeof config.timeoutSec === "number" && config.timeoutSec > 0
      ? config.timeoutSec * 1_000
      : DEFAULT_REMOTE_TIMEOUT_SEC * 1_000;

  if (isSandboxTarget(target)) {
    try {
      await verifySandboxWorkspace({ ctx, target });
      await verifySandboxWorkspace({ ctx, target, bridgeChannel: true });
    } catch (error) {
      return failureResult(error, "codex_remote_prepare_failed");
    }
  }

  try {
    return await baseExecute({
      ...ctx,
      executionTarget: isSandboxTarget(target)
        ? {
            ...target,
            timeoutMs: codexRunTimeoutMs,
          }
        : target,
      config,
    });
  } catch (error) {
    return failureResult(error, "codex_remote_execute_failed");
  }
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readConfiguredCommand(config: Record<string, unknown>): string {
  const value = typeof config.command === "string" ? config.command.trim() : "";
  return value.length > 0 ? value : CODEX_RUNTIME_FALLBACK_COMMAND;
}

function buildRuntimeCommandSpec(config: Record<string, unknown>): AdapterRuntimeCommandSpec {
  const command = readConfiguredCommand(config);
  const canSelfInstall = !hasPathSeparator(command) && command === CODEX_RUNTIME_FALLBACK_COMMAND;
  const installLine = buildSandboxNpmInstallCommand(CODEX_RUNTIME_PACKAGE);
  return {
    command,
    detectCommand: command,
    installCommand: canSelfInstall
      ? `if ! command -v ${shellQuote(command)} >/dev/null 2>&1; then ${installLine}; fi`
      : null,
  };
}

export function createServerAdapter(): ServerAdapterModule {
  return {
    type: CODEX_REMOTE_TYPE,
    execute: (ctx) => executeCodexRemote(ctx),
    testEnvironment: (ctx) =>
      baseTestEnvironment({
        ...ctx,
        adapterType: CODEX_REMOTE_TYPE,
        config: applyCodexRemoteDefaults(ctx.config),
      }),
    listSkills: listCodexSkills,
    syncSkills: syncCodexSkills,
    sessionCodec,
    sessionManagement: getAdapterSessionManagement(CODEX_REMOTE_TYPE) ?? undefined,
    models,
    modelProfiles,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: false,
    getRuntimeCommandSpec: (config) => buildRuntimeCommandSpec(config),
    getQuotaWindows,
    agentConfigurationDoc,
  };
}
