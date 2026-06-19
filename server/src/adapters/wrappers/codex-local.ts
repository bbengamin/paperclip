import type {
  AdapterExecutionContext,
  PaperclipRuntimeStateStrategyResult,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import {
  patchPaperclipRuntimeExecutionContext,
  resolvePaperclipRuntimeStateStrategy,
} from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function resolveCodexPaperclipRuntimeState(input: {
  target?: AdapterExecutionTarget | null;
  config?: Record<string, unknown> | null;
}): PaperclipRuntimeStateStrategyResult {
  const config = input.config ?? {};
  const env = asRecord(config.env);
  return resolvePaperclipRuntimeStateStrategy({
    target: input.target,
    configuredPath: readString(env.CODEX_HOME),
    forceManaged: config.paperclipManagedCodexHome === true,
    injectsCredentials: readString(env.OPENAI_API_KEY) != null,
    sandboxManagedByDefault: true,
    preserveSshNativeByDefault: true,
  });
}

export function patchCodexLocalExecutionContext(ctx: AdapterExecutionContext): AdapterExecutionContext {
  return patchPaperclipRuntimeExecutionContext(ctx, {
    runtimeState: resolveCodexPaperclipRuntimeState({
      target: ctx.executionTarget,
      config: ctx.config,
    }),
  });
}

export function createWrappedCodexLocalAdapter(base: ServerAdapterModule): ServerAdapterModule {
  return {
    ...base,
    type: "codex_local",
    execute: (ctx) => base.execute(patchCodexLocalExecutionContext(ctx)),
    testEnvironment: (ctx) => base.testEnvironment({
      ...ctx,
      adapterType: "codex_local",
    }),
  };
}
