import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";

export const CODEX_REMOTE_TYPE = "codex_remote";

const DEFAULT_REMOTE_TIMEOUT_SEC = 300;

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

export function patchCodexRemoteExecutionContext(ctx: AdapterExecutionContext): AdapterExecutionContext {
  return {
    ...ctx,
    config: applyCodexRemoteDefaults(ctx.config),
  };
}

async function verifySandboxWorkspace(input: {
  ctx: AdapterExecutionContext;
  target: CodexRemoteSandboxTarget;
  bridgeChannel?: boolean;
}) {
  const shell = input.target.shellCommand === "sh" ? "sh" : "bash";
  const marker = input.bridgeChannel ? "BRIDGE_SESSION_OK" : "WORKSPACE_OK";
  const label = input.bridgeChannel ? "bridge channel" : "main session";
  const result = await input.target.runner.execute({
    command: shell,
    args: ["-c", `mkdir -p ${JSON.stringify(input.target.remoteCwd)} && ls -la ${JSON.stringify(input.target.remoteCwd)} 2>&1 && echo ${marker}`],
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

export async function executeCodexRemote(input: {
  base: ServerAdapterModule;
  ctx: AdapterExecutionContext;
}): Promise<AdapterExecutionResult> {
  const target = requireSandboxTarget(input.ctx);
  const config = applyCodexRemoteDefaults(input.ctx.config);
  const codexRunTimeoutMs =
    typeof config.timeoutSec === "number" && config.timeoutSec > 0
      ? config.timeoutSec * 1_000
      : DEFAULT_REMOTE_TIMEOUT_SEC * 1_000;

  try {
    await verifySandboxWorkspace({ ctx: input.ctx, target });
    await verifySandboxWorkspace({ ctx: input.ctx, target, bridgeChannel: true });
  } catch (error) {
    return failureResult(error, "codex_remote_prepare_failed");
  }

  try {
    return await input.base.execute(patchCodexRemoteExecutionContext({
      ...input.ctx,
      executionTarget: {
        ...target,
        timeoutMs: codexRunTimeoutMs,
      },
      config,
    }));
  } catch (error) {
    return failureResult(error, "codex_remote_execute_failed");
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
