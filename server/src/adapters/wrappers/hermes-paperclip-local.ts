import type { AdapterExecutionContext, ServerAdapterModule } from "@paperclipai/adapter-utils";
import {
  applyPaperclipRuntimeEnv,
  composePaperclipPromptGuard,
} from "@paperclipai/adapter-utils";

export const HERMES_PAPERCLIP_LOCAL_TYPE = "hermes_paperclip_local";

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

export function normalizeHermesPaperclipConfig<T extends { config?: unknown; agent?: unknown }>(ctx: T): T {
  const config = asRecord(ctx.config);
  const agent = asRecord(ctx.agent);
  const agentAdapterConfig = asRecord(agent.adapterConfig);
  const configCommand = typeof config.command === "string" && config.command.length > 0 ? config.command : null;
  const agentCommand =
    typeof agentAdapterConfig.command === "string" && agentAdapterConfig.command.length > 0
      ? agentAdapterConfig.command
      : null;

  if (configCommand && !config.hermesCommand) config.hermesCommand = configCommand;
  if (agentCommand && !agentAdapterConfig.hermesCommand) agentAdapterConfig.hermesCommand = agentCommand;

  return ctx;
}

export function patchHermesPaperclipExecutionContext(ctx: AdapterExecutionContext): AdapterExecutionContext {
  const normalizedCtx = normalizeHermesPaperclipConfig({
    ...ctx,
    config: { ...ctx.config },
    agent: {
      ...ctx.agent,
      adapterConfig: { ...asRecord(ctx.agent.adapterConfig) },
    },
  });
  const existingConfig = asRecord(normalizedCtx.agent.adapterConfig);
  const promptTemplate = typeof existingConfig.promptTemplate === "string" ? existingConfig.promptTemplate : "";
  const env = applyPaperclipRuntimeEnv({
    env: asStringRecord(existingConfig.env),
    runId: normalizedCtx.runId,
    authToken: normalizedCtx.authToken,
  });
  const patchedConfig: Record<string, unknown> = {
    ...existingConfig,
    env,
    promptTemplate: composePaperclipPromptGuard({
      promptTemplate,
      mode: "prepend_when_present",
    }),
  };

  return {
    ...normalizedCtx,
    config: {
      ...normalizedCtx.config,
      env: {
        ...asRecord(normalizedCtx.config.env),
        ...env,
      },
      promptTemplate: typeof normalizedCtx.config.promptTemplate === "string"
        ? composePaperclipPromptGuard({
            promptTemplate: normalizedCtx.config.promptTemplate,
            mode: "prepend_when_present",
          })
        : normalizedCtx.config.promptTemplate,
    },
    agent: {
      ...normalizedCtx.agent,
      adapterConfig: patchedConfig,
    },
  };
}

export function createHermesPaperclipLocalAdapter(input: {
  base: ServerAdapterModule;
  agentConfigurationDoc?: string;
}): ServerAdapterModule {
  const base = input.base;
  return {
    ...base,
    type: HERMES_PAPERCLIP_LOCAL_TYPE,
    execute: (ctx) => base.execute(patchHermesPaperclipExecutionContext(ctx)),
    testEnvironment: (ctx) => base.testEnvironment(normalizeHermesPaperclipConfig(ctx) as never),
    agentConfigurationDoc: input.agentConfigurationDoc ?? base.agentConfigurationDoc,
  };
}
