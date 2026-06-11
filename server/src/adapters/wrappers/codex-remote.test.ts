import { describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, ServerAdapterModule } from "@paperclipai/adapter-utils";

import {
  applyCodexRemoteDefaults,
  CODEX_REMOTE_TYPE,
  createCodexRemoteAdapter,
} from "./codex-remote.js";

function createContext(config: Record<string, unknown> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Codex Remote",
      adapterType: CODEX_REMOTE_TYPE,
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {},
    onLog: async () => {},
  };
}

function createBaseAdapter(execute = vi.fn<ServerAdapterModule["execute"]>(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
}))): ServerAdapterModule {
  return {
    type: "codex_local",
    execute,
    testEnvironment: async (ctx) => ({
      adapterType: ctx.adapterType,
      status: "pass",
      checks: [],
      testedAt: new Date(0).toISOString(),
    }),
    supportsLocalAgentJwt: true,
  };
}

describe("codex_remote wrapper", () => {
  it("defaults workspace realization to Git clone without dropping existing config", () => {
    expect(applyCodexRemoteDefaults({
      model: "gpt-5.3-codex",
      workspaceRealization: {
        workBranch: "paperclip/RL-203",
      },
    })).toEqual({
      model: "gpt-5.3-codex",
      workspaceRealization: {
        workspaceStrategy: "git_clone",
        workBranch: "paperclip/RL-203",
      },
    });
  });

  it("delegates execution to Codex local with remote defaults applied", async () => {
    const execute = vi.fn<ServerAdapterModule["execute"]>(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
    }));
    const adapter = createCodexRemoteAdapter({ base: createBaseAdapter(execute) });

    await adapter.execute(createContext({ model: "gpt-5.3-codex" }));

    expect(adapter.type).toBe(CODEX_REMOTE_TYPE);
    expect(execute).toHaveBeenCalledTimes(1);
    const delegatedCtx = execute.mock.calls[0]?.[0];
    expect(delegatedCtx?.config).toMatchObject({
      model: "gpt-5.3-codex",
      workspaceRealization: {
        workspaceStrategy: "git_clone",
      },
    });
  });
});
