import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PluginLogger,
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
  PluginStreamsClient,
} from "@paperclipai/plugin-sdk";
import { CloudflareBridgeError, createCloudflareBridgeClient } from "./bridge-client.js";
import {
  parseCloudflareDriverConfig,
  validateCloudflareDriverConfig,
} from "./config.js";

const SANDBOX_EXEC_CHANNEL_ENV = "PAPERCLIP_SANDBOX_EXEC_CHANNEL";
const SANDBOX_EXEC_CHANNEL_BRIDGE = "bridge";
const CLOUDFLARE_EXEC_STDOUT_PREFIX = "[cloudflare exec stdout]";
const CLOUDFLARE_EXEC_STDERR_PREFIX = "[cloudflare exec stderr]";

function isLostLeaseError(error: unknown): boolean {
  return error instanceof CloudflareBridgeError && (error.status === 404 || error.status === 409);
}

function bridgeClientFor(rawConfig: Record<string, unknown>) {
  const config = parseCloudflareDriverConfig(rawConfig);
  return {
    config,
    client: createCloudflareBridgeClient({ config }),
  };
}

function lostLeaseExecuteResult(error: CloudflareBridgeError): PluginEnvironmentExecuteResult {
  return {
    exitCode: 1,
    timedOut: false,
    signal: null,
    stdout: "",
    stderr:
      error.message.trim().length > 0
        ? `${error.message}\n`
        : "Cloudflare sandbox lease is no longer available.\n",
  };
}

function readIssueId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveWorkspaceIssueId(params: PluginEnvironmentRealizeWorkspaceParams): string | null {
  const directIssueId = readIssueId(params.issueId);
  if (directIssueId) return directIssueId;

  const request = params.workspace.metadata?.workspaceRealizationRequest;
  if (!request || typeof request !== "object" || Array.isArray(request)) return null;
  return readIssueId((request as { issueId?: unknown }).issueId);
}

function wrapWorkspacePreparationError(remoteCwd: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Failed to prepare Cloudflare sandbox workspace at ${remoteCwd}: ${message}`);
}

function resolveRemoteCwd(
  config: ReturnType<typeof parseCloudflareDriverConfig>,
  params: PluginEnvironmentRealizeWorkspaceParams,
): string {
  const leaseRemoteCwd =
    typeof params.lease.metadata?.remoteCwd === "string" && params.lease.metadata.remoteCwd.trim().length > 0
      ? params.lease.metadata.remoteCwd.trim()
      : null;
  return leaseRemoteCwd ?? params.workspace.remotePath ?? params.workspace.localPath ?? config.requestedCwd;
}

// Bridge-channel commands (queue polling, response writes, alive pings) run on
// a dedicated session so they are isolated from the long-lived adapter command
// (the Codex exec). This matters because `executeInSandbox` deletes the *named
// session* when a command times out: if the bridge polled on the same session
// as the running Codex exec, a single slow poll would tear down the Codex
// session and kill an otherwise-healthy run. A separate session also prevents
// bridge traffic from serializing behind the long exec.
const BRIDGE_SESSION_SUFFIX = "-bridge";

function resolveExecuteSession(
  config: ReturnType<typeof parseCloudflareDriverConfig>,
  env: Record<string, string> | undefined,
) {
  const isBridgeChannel = env?.[SANDBOX_EXEC_CHANNEL_ENV] === SANDBOX_EXEC_CHANNEL_BRIDGE;
  const sessionId =
    isBridgeChannel && config.sessionStrategy === "named"
      ? `${config.sessionId}${BRIDGE_SESSION_SUFFIX}`
      : config.sessionId;
  return {
    sessionStrategy: config.sessionStrategy,
    sessionId,
  } as const;
}

export function isValidSandboxEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

export function sanitizeExecuteEnv(env: Record<string, string> | undefined) {
  if (!env) return env;
  const nextEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    // Strip the internal channel marker — it controls host-side routing only
    // and must never reach the sandbox.
    if (key === SANDBOX_EXEC_CHANNEL_ENV) continue;
    // Drop keys that are not valid POSIX shell identifiers. Windows hosts
    // expose variables like `CommonProgramFiles(x86)` and `ProgramFiles(x86)`
    // whose names contain characters that are illegal in a Linux sandbox shell.
    // Forwarding them makes the sandbox reject the entire exec with
    // "Invalid sandbox environment variable key", so we silently omit them —
    // they are meaningless inside the Linux container anyway.
    if (!isValidSandboxEnvKey(key)) continue;
    nextEnv[key] = value;
  }
  return nextEnv;
}

function logCloudflareExecChunk(
  logger: PluginLogger | null,
  stream: "stdout" | "stderr",
  chunk: string,
) {
  if (!logger || chunk.length === 0) return;
  const lines = chunk
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  for (const line of lines) {
    if (stream === "stderr") {
      logger.warn(`${CLOUDFLARE_EXEC_STDERR_PREFIX} ${line}`);
    } else {
      // Per-line exec stdout (e.g. every Codex JSONL event) is the single
      // largest source of console noise during a run, and it is already
      // forwarded verbatim to the run log via the stream channel below. Keep it
      // only at debug so the info-level console stays a readable lifecycle view.
      logger.debug(`${CLOUDFLARE_EXEC_STDOUT_PREFIX} ${line}`);
    }
  }
}

let pluginLogger: PluginLogger | null = null;
let pluginStreams: PluginStreamsClient | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    pluginLogger = ctx.logger;
    pluginStreams = ctx.streams;
    ctx.logger.info("Cloudflare sandbox provider plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "Cloudflare sandbox provider plugin healthy" };
  },

  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    const config = parseCloudflareDriverConfig(params.config);
    const errors = validateCloudflareDriverConfig(config);
    if (errors.length > 0) {
      return { ok: false, errors };
    }
    return {
      ok: true,
      normalizedConfig: { ...config },
    };
  },

  async onEnvironmentProbe(
    params: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    const { config, client } = bridgeClientFor(params.config);
    try {
      const result = await client.probe(
        {
          requestedCwd: config.requestedCwd,
          keepAlive: config.keepAlive,
          sleepAfter: config.sleepAfter,
          normalizeId: config.normalizeId,
          sessionStrategy: config.sessionStrategy,
          sessionId: config.sessionId,
          timeoutMs: config.timeoutMs,
        },
        { environmentId: params.environmentId, issueId: params.issueId },
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        summary: "Cloudflare sandbox bridge probe failed.",
        metadata: {
          provider: "cloudflare",
          error: message,
        },
      };
    }
  },

  async onEnvironmentAcquireLease(
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const { config, client } = bridgeClientFor(params.config);
    return await client.acquireLease(
      {
        environmentId: params.environmentId,
        runId: params.runId,
        issueId: params.issueId,
        reuseLease: config.reuseLease,
        keepAlive: config.keepAlive,
        sleepAfter: config.sleepAfter,
        normalizeId: config.normalizeId,
        requestedCwd: params.requestedCwd?.trim() || config.requestedCwd,
        sessionStrategy: config.sessionStrategy,
        sessionId: config.sessionId,
        timeoutMs: config.timeoutMs,
      },
      { environmentId: params.environmentId, runId: params.runId, issueId: params.issueId },
    );
  },

  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const { config, client } = bridgeClientFor(params.config);
    try {
      return await client.resumeLease(
        {
          providerLeaseId: params.providerLeaseId,
          requestedCwd:
            typeof params.leaseMetadata?.remoteCwd === "string" && params.leaseMetadata.remoteCwd.trim().length > 0
              ? params.leaseMetadata.remoteCwd.trim()
              : config.requestedCwd,
          sessionStrategy: config.sessionStrategy,
          sessionId: config.sessionId,
          keepAlive: config.keepAlive,
          sleepAfter: config.sleepAfter,
          normalizeId: config.normalizeId,
          timeoutMs: config.timeoutMs,
        },
        { environmentId: params.environmentId, issueId: params.issueId },
      );
    } catch (error) {
      if (isLostLeaseError(error)) {
        return {
          providerLeaseId: null,
          metadata: {
            provider: "cloudflare",
            expired: true,
          },
        };
      }
      throw error;
    }
  },

  async onEnvironmentReleaseLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const { config, client } = bridgeClientFor(params.config);
    await client.releaseLease(
      {
        providerLeaseId: params.providerLeaseId,
        reuseLease: config.reuseLease,
        keepAlive: config.keepAlive,
      },
      { environmentId: params.environmentId, issueId: params.issueId },
    );
  },

  async onEnvironmentDestroyLease(
    params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const { client } = bridgeClientFor(params.config);
    await client.destroyLease(params.providerLeaseId, {
      environmentId: params.environmentId,
      issueId: params.issueId,
    });
  },

  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const { config, client } = bridgeClientFor(params.config);
    const remoteCwd = resolveRemoteCwd(config, params);
    const issueId = resolveWorkspaceIssueId(params);

    if (params.lease.providerLeaseId) {
      try {
        await client.execute(
          {
            providerLeaseId: params.lease.providerLeaseId,
            command: "mkdir",
            args: ["-p", remoteCwd],
            cwd: "/",
            timeoutMs: config.timeoutMs,
            sessionStrategy: config.sessionStrategy,
            sessionId: config.sessionId,
          },
          { environmentId: params.environmentId, issueId },
        );
      } catch (error) {
        throw wrapWorkspacePreparationError(remoteCwd, error);
      }
    }

    return {
      cwd: remoteCwd,
      metadata: {
        provider: "cloudflare",
        remoteCwd,
      },
    };
  },

  async onEnvironmentExecute(
    params: PluginEnvironmentExecuteParams,
  ): Promise<PluginEnvironmentExecuteResult> {
    if (!params.lease.providerLeaseId) {
      return {
        exitCode: 1,
        timedOut: false,
        signal: null,
        stdout: "",
        stderr: "No provider lease ID available for execution.\n",
      };
    }

    const { config, client } = bridgeClientFor(params.config);
    const session = resolveExecuteSession(config, params.env);
    try {
      // Bridge-channel commands carry machine-consumed stdout (JSON, base64,
      // file contents). The @cloudflare/sandbox SDK's streaming mode can drop
      // the final stdout chunk when the inner shell exits the same tick as it
      // writes (e.g. `cat ready.json && exit 0`), so we never stream for
      // bridge control traffic — only adapter sessions get live log forwarding.
      const isBridgeChannel = params.env?.[SANDBOX_EXEC_CHANNEL_ENV] === SANDBOX_EXEC_CHANNEL_BRIDGE;
      const streamChannel = !isBridgeChannel && params.lease.providerLeaseId
        ? `environment-execute:${params.lease.providerLeaseId}`
        : null;
      if (streamChannel) {
        pluginStreams?.open(streamChannel, params.companyId);
      }
      const streamingOptions = !isBridgeChannel && (pluginLogger || pluginStreams)
        ? {
            onOutput: async (stream: "stdout" | "stderr", chunk: string) => {
              logCloudflareExecChunk(pluginLogger, stream, chunk);
              if (streamChannel) {
                pluginStreams?.emit(streamChannel, { stream, chunk });
              }
            },
            onActivity: async () => {
              if (streamChannel) {
                pluginStreams?.emit(streamChannel, { type: "activity" });
              }
            },
          }
        : undefined;
      try {
        return await client.execute(
          {
            providerLeaseId: params.lease.providerLeaseId,
            command: params.command,
            args: params.args,
            cwd: params.cwd,
            env: sanitizeExecuteEnv(params.env),
            stdin: params.stdin ?? null,
            timeoutMs: params.timeoutMs ?? config.timeoutMs,
            sessionStrategy: session.sessionStrategy,
            sessionId: session.sessionId,
          },
          { environmentId: params.environmentId, issueId: params.issueId },
          streamingOptions,
        );
      } finally {
        if (streamChannel) {
          pluginStreams?.close(streamChannel);
        }
      }
    } catch (error) {
      if (error instanceof CloudflareBridgeError && isLostLeaseError(error)) {
        return lostLeaseExecuteResult(error);
      }
      throw error;
    }
  },
});

export default plugin;
