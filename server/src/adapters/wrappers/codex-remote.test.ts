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
  return {
    scripts,
    runner: {
      execute: vi.fn(async (input: { args?: string[] }) => {
        const script = input.args?.[1] ?? "";
        scripts.push(script);
        return handler?.(script) ?? ok();
      }),
    },
  };
}

function createContext(input: {
  config?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
  handler?: (script: string) => RunProcessResult;
  authToken?: string;
} = {}): AdapterExecutionContext & { runnerScripts: string[] } {
  const { runner, scripts } = createRunner(input.handler);
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
      providerKey: "daytona",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd: "/home/daytona/paperclip-workspace",
      shellCommand: "bash",
      runner,
    },
    onLog: async () => {},
    authToken: input.authToken,
    runnerScripts: scripts,
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

  it("defaults workspace realization to Git clone without dropping existing config", () => {
    expect(applyCodexRemoteDefaults({
      model: "gpt-5.3-codex",
      workspaceRealization: {
        workBranch: "paperclip/RL-203",
      },
    })).toEqual({
      model: "gpt-5.3-codex",
      timeoutSec: 300,
      dangerouslyBypassApprovalsAndSandbox: true,
      workspaceRealization: {
        workspaceStrategy: "git_clone",
        workBranch: "paperclip/RL-203",
      },
    });
  });

  it("preserves explicit timeoutSec values and defaults disabled values for testing", () => {
    expect(applyCodexRemoteDefaults({ timeoutSec: 1800 })).toMatchObject({ timeoutSec: 1800 });
    expect(applyCodexRemoteDefaults({ timeoutSec: 0 })).toMatchObject({ timeoutSec: 300 });
  });

  it("prepares Git workspace, runs Codex remotely, commits, and pushes", async () => {
    const execute = vi.fn<ServerAdapterModule["execute"]>(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      resultJson: { codex: "ok" },
    }));
    const adapter = createCodexRemoteAdapter({ base: createBaseAdapter(execute) });
    const ctx = createContext({
      config: { model: "gpt-5.3-codex" },
      handler: (script) => {
        if (script === "git status --porcelain=v1") return ok(" M README.md\n");
        if (script === "git rev-parse HEAD") return ok("abc123\n");
        return ok();
      },
    });

    const result = await adapter.execute(ctx);

    expect(adapter.type).toBe(CODEX_REMOTE_TYPE);
    expect(execute).toHaveBeenCalledTimes(1);
    const delegatedCtx = execute.mock.calls[0]?.[0];
    expect(delegatedCtx?.config).toMatchObject({
      model: "gpt-5.3-codex",
      dangerouslyBypassApprovalsAndSandbox: true,
      workspaceRealization: {
        workspaceStrategy: "git_clone",
      },
      remoteGitSandbox: {
        enabled: true,
        workBranch: "paperclip/daytona/RL-201",
        remoteCwd: "/home/daytona/paperclip-workspace",
      },
    });
    expect(delegatedCtx?.executionTarget).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/home/daytona/paperclip-workspace",
    });
    expect(result.resultJson).toMatchObject({
      codex: "ok",
      remoteGit: {
        dirty: true,
        commitSha: "abc123",
        pushed: true,
        pushedBranch: "paperclip/daytona/RL-201",
        pullRequestSkippedReason: "missing_github_repo_credential",
      },
    });
    expect(ctx.runnerScripts.join("\n")).toContain("git clone --no-checkout");
    expect(ctx.runnerScripts.join("\n")).toContain("git checkout -B 'paperclip/daytona/RL-201' FETCH_HEAD");
    expect(ctx.runnerScripts.join("\n")).toContain("git push origin HEAD:refs/heads/'paperclip/daytona/RL-201'");
    expect(ctx.runnerScripts.join("\n")).not.toMatch(/\btar\b|base64|workspace-upload|workspace-download/);
  });

  it("surfaces clone failures before running Codex", async () => {
    const execute = vi.fn<ServerAdapterModule["execute"]>();
    const adapter = createCodexRemoteAdapter({ base: createBaseAdapter(execute) });
    const ctx = createContext({
      handler: (script) => script.includes("git clone") ? fail("repository not found") : ok(),
    });

    const result = await adapter.execute(ctx);

    expect(execute).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("codex_remote_prepare_failed");
    expect(result.errorMessage).toContain("repository not found");
  });

  it("finalizes after Codex execution fails so dirty work is still observable", async () => {
    const execute = vi.fn<ServerAdapterModule["execute"]>(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Codex auth failed",
    }));
    const adapter = createCodexRemoteAdapter({ base: createBaseAdapter(execute) });
    const ctx = createContext();

    const result = await adapter.execute(ctx);

    expect(result.errorMessage).toBe("Codex auth failed");
    expect(ctx.runnerScripts.join("\n")).toContain("git status --porcelain=v1");
    expect(ctx.runnerScripts.join("\n")).not.toContain("git push origin");
  });

  it("creates a GitHub pull request after pushing a dirty branch", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ html_url: "https://github.com/example/repo/pull/42" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const execute = vi.fn<ServerAdapterModule["execute"]>(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
    }));
    const adapter = createCodexRemoteAdapter({ base: createBaseAdapter(execute) });
    const ctx = createContext({
      workspace: {
        repoUrl: "https://x-access-token:ghp_testtoken@github.com/example/repo.git",
      },
      handler: (script) => {
        if (script === "git status --porcelain=v1") return ok(" M README.md\n");
        if (script === "git rev-parse HEAD") return ok("abc123\n");
        return ok();
      },
    });

    const result = await adapter.execute(ctx);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/example/repo/pulls",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer ghp_testtoken",
        }),
      }),
    );
    expect(result.resultJson).toMatchObject({
      remoteGit: {
        pullRequestUrl: "https://github.com/example/repo/pull/42",
        pullRequestCreated: true,
      },
    });
  });

  it("marks the Paperclip issue done from the host after opening a pull request", async () => {
    vi.stubEnv("PAPERCLIP_API_URL", "http://paperclip.local/");
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === "https://api.github.com/repos/example/repo/pulls") {
        return new Response(JSON.stringify({ html_url: "https://github.com/example/repo/pull/42" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "http://paperclip.local/api/issues/issue-201") {
        return new Response(JSON.stringify({ id: "issue-201", status: "done" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected url", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const execute = vi.fn<ServerAdapterModule["execute"]>(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
    }));
    const adapter = createCodexRemoteAdapter({ base: createBaseAdapter(execute) });
    const ctx = createContext({
      authToken: "run-jwt-token",
      workspace: {
        repoUrl: "https://x-access-token:ghp_testtoken@github.com/example/repo.git",
      },
      handler: (script) => {
        if (script === "git status --porcelain=v1") return ok(" M README.md\n");
        if (script === "git rev-parse HEAD") return ok("abc123\n");
        return ok();
      },
    });

    const result = await adapter.execute(ctx);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://paperclip.local/api/issues/issue-201",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({
          authorization: "Bearer run-jwt-token",
          "content-type": "application/json",
        }),
        body: expect.any(String),
      }),
    );
    const patchCall = fetchMock.mock.calls.find(([url]) => url === "http://paperclip.local/api/issues/issue-201");
    const patchBody = JSON.parse(String((patchCall?.[1] as RequestInit | undefined)?.body));
    expect(patchBody).toMatchObject({ status: "done" });
    expect(patchBody.comment).toContain("https://github.com/example/repo/pull/42");
    expect(patchBody.comment).toContain("paperclip/daytona/RL-201");
    expect(result.resultJson).toMatchObject({
      remoteGit: {
        paperclipCloseout: {
          attempted: true,
          ok: true,
        },
      },
    });
  });

  it("reports success when host close-out succeeds after the base adapter failed late", async () => {
    vi.stubEnv("PAPERCLIP_API_URL", "http://paperclip.local");
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === "https://api.github.com/repos/example/repo/pulls") {
        return new Response(JSON.stringify({ html_url: "https://github.com/example/repo/pull/43" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "http://paperclip.local/api/issues/issue-201") {
        return new Response(JSON.stringify({ id: "issue-201", status: "done" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected url", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const execute = vi.fn<ServerAdapterModule["execute"]>(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "callback bridge timed out after finishing",
      errorCode: "sandbox_callback_timeout",
    }));
    const adapter = createCodexRemoteAdapter({ base: createBaseAdapter(execute) });
    const ctx = createContext({
      authToken: "run-jwt-token",
      workspace: {
        repoUrl: "https://x-access-token:ghp_testtoken@github.com/example/repo.git",
      },
      handler: (script) => {
        if (script === "git status --porcelain=v1") return ok(" M README.md\n");
        if (script === "git rev-parse HEAD") return ok("def456\n");
        return ok();
      },
    });

    const result = await adapter.execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.errorMessage).toBeNull();
    expect(result.errorCode).toBeNull();
    expect(result.resultJson).toMatchObject({
      codexRemoteOriginalResult: {
        exitCode: 1,
        errorMessage: "callback bridge timed out after finishing",
        errorCode: "sandbox_callback_timeout",
      },
      remoteGit: {
        commitSha: "def456",
        pullRequestUrl: "https://github.com/example/repo/pull/43",
        paperclipCloseout: {
          ok: true,
        },
      },
    });
  });

  it("surfaces push failures after Codex succeeds", async () => {
    const execute = vi.fn<ServerAdapterModule["execute"]>(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
    }));
    const adapter = createCodexRemoteAdapter({ base: createBaseAdapter(execute) });
    const ctx = createContext({
      handler: (script) => {
        if (script === "git status --porcelain=v1") return ok(" M README.md\n");
        if (script === "git rev-parse HEAD") return ok("abc123\n");
        if (script.includes("git push origin")) return fail("permission denied");
        return ok();
      },
    });

    const result = await adapter.execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("codex_remote_finalize_failed");
    expect(result.errorMessage).toContain("permission denied");
  });
});
