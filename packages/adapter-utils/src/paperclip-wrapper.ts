import type { AdapterExecutionTarget } from "./execution-target.js";

export const PAPERCLIP_API_KEY_ENV = "PAPERCLIP_API_KEY";
export const PAPERCLIP_RUN_ID_ENV = "PAPERCLIP_RUN_ID";

export const DEFAULT_PAPERCLIP_API_SAFETY_PROMPT = [
  "Paperclip API safety rule:",
  "Use Authorization: Bearer $PAPERCLIP_API_KEY on every Paperclip API request.",
  "Use X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID on every Paperclip API request that writes or mutates data, including comments and issue updates.",
  "Never use a board, browser, or local-board session for Paperclip API writes.",
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

export interface PaperclipRuntimeStateStrategyInput {
  target?: AdapterExecutionTarget | null;
  configuredPath?: string | null;
  forceManaged?: boolean;
  injectsCredentials?: boolean;
  sandboxManagedByDefault?: boolean;
  preserveSshNativeByDefault?: boolean;
}

export type PaperclipRuntimeStateStrategy = "native" | "configured" | "managed";

export interface PaperclipRuntimeStateStrategyResult {
  strategy: PaperclipRuntimeStateStrategy;
  managed: boolean;
  reason: string;
}

function hasNonEmptyValue(env: Record<string, string>, key: string): boolean {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function applyPaperclipRuntimeEnv(input: PaperclipRuntimeEnvInput): Record<string, string> {
  const apiKeyEnvKey = input.apiKeyEnvKey?.trim() || PAPERCLIP_API_KEY_ENV;
  const runIdEnvKey = input.runIdEnvKey?.trim() || PAPERCLIP_RUN_ID_ENV;
  const env = { ...input.env };
  const runId = input.runId.trim();
  if (runId) {
    env[runIdEnvKey] = runId;
  }

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
    const sandboxManagedByDefault = input.sandboxManagedByDefault ?? true;
    return sandboxManagedByDefault
      ? {
          strategy: "managed",
          managed: true,
          reason: "sandbox execution uses managed runtime state by default",
        }
      : {
          strategy: "native",
          managed: false,
          reason: "sandbox execution was configured to preserve native runtime state",
        };
  }

  if (input.target?.kind === "remote" && input.target.transport === "ssh") {
    const preserveSshNativeByDefault = input.preserveSshNativeByDefault ?? true;
    return preserveSshNativeByDefault
      ? {
          strategy: "native",
          managed: false,
          reason: "SSH execution preserves native remote runtime state by default",
        }
      : {
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
