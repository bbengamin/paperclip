import type { AdapterExecutionContext } from "./types.js";
import type { AdapterExecutionTarget } from "./execution-target.js";

export const PAPERCLIP_API_KEY_ENV = "PAPERCLIP_API_KEY";
export const PAPERCLIP_RUN_ID_ENV = "PAPERCLIP_RUN_ID";

export const DEFAULT_PAPERCLIP_API_SAFETY_PROMPT = [
  "Paperclip API safety rule:",
  "Paperclip is the exact task-management system for this run. Do not search for or use Jira, Atlassian, Linear, GitHub Issues, or any other task-management tool.",
  "Use Authorization: Bearer $PAPERCLIP_API_KEY on every Paperclip API request.",
  "Use X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID on every Paperclip API request that writes or mutates data, including comments and issue updates.",
  "Never use a board, browser, or local-board session for Paperclip API writes.",
  "Before ending the heartbeat, post a useful final comment and update the assigned Paperclip issue to the correct final status through the Paperclip API.",
].join("\n");

export type PaperclipPromptGuardMode = "prepend" | "prepend_when_present" | "none";

export interface PaperclipRuntimeEnvInput {
  env: Record<string, string>;
  runId: string;
  authToken?: string | null;
  apiKeyEnvKey?: string;
  runIdEnvKey?: string;
}

export interface PaperclipPromptGuardInput {
  promptTemplate?: string | null;
  guardPrompt?: string | null;
  mode?: PaperclipPromptGuardMode;
}

export type PaperclipRuntimeStateStrategy = "native" | "configured" | "managed";

export interface PaperclipRuntimeStateStrategyInput {
  target?: AdapterExecutionTarget | null;
  configuredPath?: string | null;
  forceManaged?: boolean;
  injectsCredentials?: boolean;
  sandboxManagedByDefault?: boolean;
  preserveSshNativeByDefault?: boolean;
}

export interface PaperclipRuntimeStateStrategyResult {
  strategy: PaperclipRuntimeStateStrategy;
  managed: boolean;
  reason: string;
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function hasNonEmptyValue(env: Record<string, string>, key: string): boolean {
  return nonEmpty(env[key]) !== null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(asRecord(value))) {
    if (typeof raw === "string") out[key] = raw;
  }
  return out;
}

export function applyPaperclipRuntimeEnv(input: PaperclipRuntimeEnvInput): Record<string, string> {
  const apiKeyEnvKey = input.apiKeyEnvKey?.trim() || PAPERCLIP_API_KEY_ENV;
  const runIdEnvKey = input.runIdEnvKey?.trim() || PAPERCLIP_RUN_ID_ENV;
  const env = { ...input.env };
  const runId = input.runId.trim();
  if (runId) env[runIdEnvKey] = runId;

  const authToken = nonEmpty(input.authToken);
  if (authToken && !hasNonEmptyValue(env, apiKeyEnvKey)) {
    env[apiKeyEnvKey] = authToken;
  }

  return env;
}

export function composePaperclipPromptGuard(input: PaperclipPromptGuardInput): string {
  const mode = input.mode ?? "prepend";
  const promptTemplate = input.promptTemplate ?? "";
  if (mode === "none") return promptTemplate;

  const guardPrompt = nonEmpty(input.guardPrompt) ?? DEFAULT_PAPERCLIP_API_SAFETY_PROMPT;
  if (mode === "prepend_when_present" && promptTemplate.trim().length === 0) {
    return promptTemplate;
  }
  if (promptTemplate.trim().length === 0) {
    return guardPrompt;
  }
  return `${guardPrompt}\n\n${promptTemplate}`;
}

export function resolvePaperclipRuntimeStateStrategy(
  input: PaperclipRuntimeStateStrategyInput,
): PaperclipRuntimeStateStrategyResult {
  if (input.forceManaged) {
    return {
      strategy: "managed",
      managed: true,
      reason: "managed runtime state was explicitly requested",
    };
  }

  if (nonEmpty(input.configuredPath)) {
    return {
      strategy: "configured",
      managed: false,
      reason: "adapter config provides an explicit runtime state path",
    };
  }

  if (input.injectsCredentials) {
    return {
      strategy: "managed",
      managed: true,
      reason: "Paperclip is injecting credentials and must isolate runtime state",
    };
  }

  if (input.target?.kind === "remote" && input.target.transport === "sandbox") {
    if (input.sandboxManagedByDefault ?? true) {
      return {
        strategy: "managed",
        managed: true,
        reason: "sandbox execution uses managed runtime state by default",
      };
    }
    return {
      strategy: "native",
      managed: false,
      reason: "sandbox execution was configured to preserve native runtime state",
    };
  }

  if (input.target?.kind === "remote" && input.target.transport === "ssh") {
    if (input.preserveSshNativeByDefault ?? true) {
      return {
        strategy: "native",
        managed: false,
        reason: "SSH execution preserves native remote runtime state by default",
      };
    }
    return {
      strategy: "managed",
      managed: true,
      reason: "SSH execution was configured to use managed runtime state",
    };
  }

  return {
    strategy: "native",
    managed: false,
    reason: "local execution preserves native runtime state by default",
  };
}

export function patchPaperclipRuntimeExecutionContext(
  ctx: AdapterExecutionContext,
  options: {
    promptGuardMode?: PaperclipPromptGuardMode;
    guardPrompt?: string | null;
    runtimeState?: PaperclipRuntimeStateStrategyResult | null;
  } = {},
): AdapterExecutionContext {
  const config = { ...ctx.config };
  const env = applyPaperclipRuntimeEnv({
    env: asStringRecord(config.env),
    runId: ctx.runId,
    authToken: ctx.authToken,
  });
  const promptTemplate = typeof config.promptTemplate === "string" ? config.promptTemplate : "";
  const nextConfig: Record<string, unknown> = {
    ...config,
    env,
    promptTemplate: composePaperclipPromptGuard({
      promptTemplate,
      guardPrompt: options.guardPrompt,
      mode: options.promptGuardMode ?? (promptTemplate.trim().length > 0 ? "prepend" : "none"),
    }),
  };

  if (options.runtimeState) {
    nextConfig.paperclipRuntimeStateStrategy = options.runtimeState.strategy;
    nextConfig.paperclipRuntimeStateReason = options.runtimeState.reason;
  }

  return {
    ...ctx,
    config: nextConfig,
  };
}
