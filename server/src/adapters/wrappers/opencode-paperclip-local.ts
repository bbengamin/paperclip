import type {
  AdapterExecutionContext,
  PaperclipRuntimeStateStrategyResult,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import {
  applyPaperclipRuntimeEnv,
  composePaperclipPromptGuard,
  resolvePaperclipRuntimeStateStrategy,
} from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

export const OPENCODE_PAPERCLIP_LOCAL_TYPE = "opencode_paperclip_local";

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

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function resolveOpenCodePaperclipRuntimeState(input: {
  target?: AdapterExecutionTarget | null;
  config?: Record<string, unknown> | null;
}): PaperclipRuntimeStateStrategyResult {
  const config = input.config ?? {};
  const env = asRecord(config.env);
  return resolvePaperclipRuntimeStateStrategy({
    target: input.target,
    configuredPath: readString(env.XDG_CONFIG_HOME),
    forceManaged: config.paperclipManagedOpenCodeConfig === true,
    injectsCredentials:
      readString(env.OPENAI_API_KEY) != null ||
      readString(env.ANTHROPIC_API_KEY) != null ||
      readString(env.GOOGLE_API_KEY) != null,
    sandboxManagedByDefault: true,
    preserveSshNativeByDefault: true,
  });
}

export function patchOpenCodePaperclipExecutionContext(ctx: AdapterExecutionContext): AdapterExecutionContext {
  const config = { ...ctx.config };
  const env = applyPaperclipRuntimeEnv({
    env: asStringRecord(config.env),
    runId: ctx.runId,
    authToken: ctx.authToken,
  });
  const runtimeState = resolveOpenCodePaperclipRuntimeState({
    target: ctx.executionTarget,
    config,
  });
  const promptTemplate = typeof config.promptTemplate === "string" ? config.promptTemplate : "";

  return {
    ...ctx,
    config: {
      ...config,
      env,
      promptTemplate: composePaperclipPromptGuard({
        promptTemplate,
        mode: promptTemplate.trim().length > 0 ? "prepend" : "none",
      }),
      paperclipRuntimeStateStrategy: runtimeState.strategy,
      paperclipRuntimeStateReason: runtimeState.reason,
    },
  };
}

export function createOpenCodePaperclipLocalAdapter(input: {
  base: ServerAdapterModule;
  agentConfigurationDoc?: string;
}): ServerAdapterModule {
  const base = input.base;
  return {
    ...base,
    type: OPENCODE_PAPERCLIP_LOCAL_TYPE,
    execute: (ctx) => base.execute(patchOpenCodePaperclipExecutionContext(ctx)),
    testEnvironment: (ctx) => base.testEnvironment({
      ...ctx,
      adapterType: OPENCODE_PAPERCLIP_LOCAL_TYPE,
    }),
    agentConfigurationDoc: input.agentConfigurationDoc ?? base.agentConfigurationDoc,
  };
}
