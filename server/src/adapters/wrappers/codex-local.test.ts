import { describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, ServerAdapterModule } from "@paperclipai/adapter-utils";
import {
  createWrappedCodexLocalAdapter,
  patchCodexLocalExecutionContext,
  resolveCodexPaperclipRuntimeState,
} from "./codex-local.js";

function createContext(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Codex",
      adapterType: "codex_local",
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

function createBaseAdapter(execute = vi.fn<ServerAdapterModule["execute"]>(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
}))): ServerAdapterModule {
  return {
    type: "codex_local",
    execute,
    testEnvironment: async () => ({
      adapterType: "codex_local",
      status: "pass",
      checks: [],
      testedAt: "2026-06-19T00:00:00.000Z",
    }),
    supportsLocalAgentJwt: true,
  };
}

describe("codex_local Paperclip runtime wrapper", () => {
  it("preserves native runtime state by default for SSH targets", () => {
    const result = resolveCodexPaperclipRuntimeState({
      target: {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/repo",
        spec: {
          host: "devbox",
          port: 22,
          username: "paperclip",
          remoteWorkspacePath: "/repo",
          remoteCwd: "/repo",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: false,
        },
      },
      config: {},
    });

    expect(result).toMatchObject({
      strategy: "native",
      managed: false,
    });
  });

  it("uses managed runtime state for sandbox and credential-isolated Codex runs", () => {
    expect(resolveCodexPaperclipRuntimeState({
      target: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "cloudflare",
        leaseId: "sandbox-1",
        remoteCwd: "/repo",
        timeoutMs: 1000,
      },
      config: {},
    })).toMatchObject({ strategy: "managed" });

    expect(resolveCodexPaperclipRuntimeState({
      target: null,
      config: {
        env: {
          OPENAI_API_KEY: "sk-test",
        },
      },
    })).toMatchObject({ strategy: "managed" });
  });

  it("patches Paperclip env and prompt policy before delegation", async () => {
    const execute = vi.fn<ServerAdapterModule["execute"]>(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
    }));
    const adapter = createWrappedCodexLocalAdapter(createBaseAdapter(execute));

    await adapter.execute(createContext({
      config: {
        env: {
          PAPERCLIP_API_KEY: "explicit-token",
        },
        promptTemplate: "Do the issue work.",
      },
    }));

    const delegatedCtx = execute.mock.calls[0]?.[0] as AdapterExecutionContext | undefined;
    expect(adapter.type).toBe("codex_local");
    expect(delegatedCtx?.config.env).toMatchObject({
      PAPERCLIP_API_KEY: "explicit-token",
      PAPERCLIP_RUN_ID: "run-1",
    });
    expect(delegatedCtx?.config.promptTemplate).toContain("Paperclip API safety rule:");
    expect(delegatedCtx?.config.promptTemplate).toContain("Do the issue work.");
  });

  it("records runtime-state decision on the delegated config", () => {
    const patched = patchCodexLocalExecutionContext(createContext({
      config: {
        paperclipManagedCodexHome: true,
      },
    }));

    expect(patched.config.paperclipRuntimeStateStrategy).toBe("managed");
    expect(patched.config.paperclipRuntimeStateReason).toContain("explicitly requested");
  });
});
