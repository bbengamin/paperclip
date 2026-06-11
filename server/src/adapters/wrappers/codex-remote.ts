import type { AdapterExecutionContext, ServerAdapterModule } from "@paperclipai/adapter-utils";

export const CODEX_REMOTE_TYPE = "codex_remote";

const DEFAULT_WORKSPACE_REALIZATION = {
  workspaceStrategy: "git_clone",
} as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function applyCodexRemoteDefaults(config: Record<string, unknown>): Record<string, unknown> {
  return {
    ...config,
    workspaceRealization: {
      ...DEFAULT_WORKSPACE_REALIZATION,
      ...asRecord(config.workspaceRealization),
    },
  };
}

export function patchCodexRemoteExecutionContext(ctx: AdapterExecutionContext): AdapterExecutionContext {
  return {
    ...ctx,
    config: applyCodexRemoteDefaults(ctx.config),
  };
}

export function createCodexRemoteAdapter(input: {
  base: ServerAdapterModule;
  agentConfigurationDoc?: string;
}): ServerAdapterModule {
  const base = input.base;
  return {
    ...base,
    type: CODEX_REMOTE_TYPE,
    execute: (ctx) => base.execute(patchCodexRemoteExecutionContext(ctx)),
    testEnvironment: (ctx) => base.testEnvironment({
      ...ctx,
      adapterType: CODEX_REMOTE_TYPE,
      config: applyCodexRemoteDefaults(ctx.config),
    }),
    agentConfigurationDoc: input.agentConfigurationDoc ?? base.agentConfigurationDoc,
  };
}
