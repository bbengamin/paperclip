import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, ServerAdapterModule } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

import {
  applyCodexRemoteDefaults,
  CODEX_REMOTE_TYPE,
  createCodexRemoteAdapter,
} from "./codex-remote.js";

function ok(stdout = ""): RunProcessResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "",
    pid: null,
    startedAt: "2026-06-11T00:00:00.000Z",
  };
}

function fail(stderr: string): RunProcessResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr,
    pid: null,
    startedAt: "2026-06-11T00:00:00.000Z",
  };
}

function createRunner(handler?: (script: string) => RunProcessResult) {
  const scripts: string[] = [];
  const envs: Array<Record<string, string> | undefined> = [];
  return {
    scripts,
    envs,
    runner: {
      execute: vi.fn(async (input: { args?: string[]; env?: Record<string, string> }) => {
        const script = input.args?.[1] ?? "";
        scripts.push(script);
        envs.push(input.env);
        return handler?.(script) ?? ok("workspace\n");
      }),
    },
  };
}

function createContext(input: {
  config?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
  handler?: (script: string) => RunProcessResult;
  authToken?: string;
} = {}): AdapterExecutionContext & {
  runnerScripts: string[];
  runnerEnvs: Array<Record<string, string> | undefined>;
} {
  const { runner, scripts, envs } = createRunner(input.handler);
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
    config: input.config ?? {},
    context: {
      paperclipWorkspace: {
        repoUrl: "https://github.com/example/repo",
        repoRef: "main",
        name: "paperclip",
        ...(input.workspace ?? {}),
      },
      paperclipIssue: {
        id: "issue-201",
        identifier: "RL-201",
      },
    },
    executionTarget: {
      kind: "remote",
      transport: "sandbox",
      providerKey: "cloudflare",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd: "/workspace/paperclip",
      shellCommand: "bash",
      runner,
    },
    onLog: async () => {},
    authToken: input.authToken,
    runnerScripts: scripts,
    runnerEnvs: envs,
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
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("defaults to sandbox runtime without requesting Git clone realization", () => {
    expect(applyCodexRemoteDefaults({
      model: "gpt-5.3-codex",
      workspaceRealization: {
        workBranch: "paperclip/RL-203",
      },
    })).toEqual({
      model: "gpt-5.3-codex",
      timeoutSec: 300,
      dangerouslyBypassApprovalsAndSandbox: true,
      remoteWorkspaceSync: false,
      workspaceRealization: {
        workBranch: "paperclip/RL-203",
      },
    });
  });

  it("preserves explicit timeoutSec values and defaults disabled values for testing", () => {
    expect(applyCodexRemoteDefaults({ timeoutSec: 1800 })).toMatchObject({ timeoutSec: 1800 });
    expect(applyCodexRemoteDefaults({ timeoutSec: 0 })).toMatchObject({ timeoutSec: 300 });
  });

  it("verifies sandbox cwd and delegates to Codex without Git finalization", async () => {
    const execute = vi.fn<ServerAdapterModule["execute"]>(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      resultJson: { codex: "ok" },
    }));
    const adapter = createCodexRemoteAdapter({ base: createBaseAdapter(execute) });
    const ctx = createContext({ config: { model: "gpt-5.3-codex" } });

    const result = await adapter.execute(ctx);

    expect(adapter.type).toBe(CODEX_REMOTE_TYPE);
    expect(execute).toHaveBeenCalledTimes(1);
    const delegatedCtx = execute.mock.calls[0]?.[0];
    expect(delegatedCtx?.config).toMatchObject({
      model: "gpt-5.3-codex",
      dangerouslyBypassApprovalsAndSandbox: true,
      remoteWorkspaceSync: false,
    });
    expect(delegatedCtx?.config.workspaceRealization).toBeUndefined();
    expect(delegatedCtx?.config.remoteGitSandbox).toBeUndefined();
    expect(delegatedCtx?.executionTarget).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace/paperclip",
    });
    expect(delegatedCtx?.context.paperclipWorkspace).toMatchObject({
      repoUrl: "https://github.com/example/repo",
      repoRef: "main",
    });
    expect(result.resultJson).toMatchObject({ codex: "ok" });

    const scripts = ctx.runnerScripts.join("\n");
    expect(scripts).toContain("WORKSPACE_OK");
    expect(scripts).toContain("BRIDGE_SESSION_OK");
    expect(scripts).not.toMatch(/git clone|git checkout|git commit|git push|git status/);
    expect(scripts).not.toMatch(/\btar\b|base64|workspace-upload|workspace-download/);
  });

  it("uses the bridge channel for the bridge warmup probe", async () => {
    const adapter = createCodexRemoteAdapter({ base: createBaseAdapter() });
    const ctx = createContext();

    await adapter.execute(ctx);

    expect(ctx.runnerEnvs).toContainEqual({ PAPERCLIP_SANDBOX_EXEC_CHANNEL: "bridge" });
  });

  it("surfaces sandbox warmup failures before running Codex", async () => {
    const execute = vi.fn<ServerAdapterModule["execute"]>();
    const adapter = createCodexRemoteAdapter({ base: createBaseAdapter(execute) });
    const ctx = createContext({
      handler: (script) => script.includes("WORKSPACE_OK") ? fail("workspace unavailable") : ok(),
    });

    const result = await adapter.execute(ctx);

    expect(execute).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("codex_remote_prepare_failed");
    expect(result.errorMessage).toContain("workspace unavailable");
  });

  it("does not call GitHub or host Paperclip close-out APIs", async () => {
    vi.stubEnv("PAPERCLIP_API_URL", "http://paperclip.local/");
    const fetchMock = vi.fn(async () => new Response("unexpected", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const execute = vi.fn<ServerAdapterModule["execute"]>(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
    }));
    const adapter = createCodexRemoteAdapter({ base: createBaseAdapter(execute) });
    const ctx = createContext({
      authToken: "run-jwt-token",
      config: {
        env: {
          GITHUB_TOKEN: "ghp_testtoken",
        },
      },
    });

    await adapter.execute(ctx);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
