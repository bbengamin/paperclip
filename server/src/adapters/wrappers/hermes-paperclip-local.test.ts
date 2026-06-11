import { describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, ServerAdapterModule } from "@paperclipai/adapter-utils";
import {
  HERMES_PAPERCLIP_LOCAL_TYPE,
  createHermesPaperclipLocalAdapter,
  normalizeHermesPaperclipConfig,
  patchHermesPaperclipExecutionContext,
} from "./hermes-paperclip-local.js";

function createContext(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: HERMES_PAPERCLIP_LOCAL_TYPE,
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {},
    context: {},
    onLog: async () => undefined,
    authToken: "agent-token",
    ...overrides,
  };
}

describe("hermes paperclip wrapper", () => {
  it("normalizes command to hermesCommand for legacy Hermes config shape", () => {
    const ctx = normalizeHermesPaperclipConfig({
      config: { command: "hermes-dev" },
      agent: { adapterConfig: { command: "hermes-agent" } },
    });

    expect(ctx.config).toMatchObject({ hermesCommand: "hermes-dev" });
    expect(ctx.agent.adapterConfig).toMatchObject({ hermesCommand: "hermes-agent" });
  });

  it("injects run env without overwriting an explicit API key", () => {
    const patched = patchHermesPaperclipExecutionContext(createContext({
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Hermes",
        adapterType: HERMES_PAPERCLIP_LOCAL_TYPE,
        adapterConfig: {
          env: {
            PAPERCLIP_API_KEY: "explicit-token",
          },
        },
      },
    }));

    expect((patched.agent.adapterConfig as Record<string, unknown>).env).toMatchObject({
      PAPERCLIP_API_KEY: "explicit-token",
      PAPERCLIP_RUN_ID: "run-1",
    });
  });

  it("prepends the Paperclip prompt guard only when a Hermes prompt template exists", () => {
    const patched = patchHermesPaperclipExecutionContext(createContext({
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Hermes",
        adapterType: HERMES_PAPERCLIP_LOCAL_TYPE,
        adapterConfig: {
          promptTemplate: "Do the issue work.",
        },
      },
    }));
    const patchedConfig = patched.agent.adapterConfig as Record<string, unknown>;

    expect(patchedConfig.promptTemplate).toContain("Paperclip API safety rule:");
    expect(patchedConfig.promptTemplate).toContain("Do the issue work.");

    const emptyPrompt = patchHermesPaperclipExecutionContext(createContext());
    expect((emptyPrompt.agent.adapterConfig as Record<string, unknown>).promptTemplate).toBe("");
  });

  it("delegates execution to the base Hermes adapter with patched context", async () => {
    const execute = vi.fn<ServerAdapterModule["execute"]>(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
    }));
    const base: ServerAdapterModule = {
      type: "hermes_local",
      execute,
      testEnvironment: async () => ({
        adapterType: "hermes_local",
        status: "pass",
        checks: [],
        testedAt: "2026-06-11T00:00:00.000Z",
      }),
      supportsLocalAgentJwt: true,
    };
    const adapter = createHermesPaperclipLocalAdapter({ base });

    await adapter.execute(createContext());

    expect(adapter.type).toBe(HERMES_PAPERCLIP_LOCAL_TYPE);
    expect(execute).toHaveBeenCalledTimes(1);
    const delegatedCtx = execute.mock.calls[0]?.[0] as AdapterExecutionContext | undefined;
    expect((delegatedCtx?.agent.adapterConfig as Record<string, unknown>).env).toMatchObject({
      PAPERCLIP_API_KEY: "agent-token",
      PAPERCLIP_RUN_ID: "run-1",
    });
  });
});
