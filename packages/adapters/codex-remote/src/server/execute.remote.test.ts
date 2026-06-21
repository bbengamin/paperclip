import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  syncDirectoryToSsh,
  startAdapterExecutionTargetPaperclipBridge,
  prepareAdapterExecutionTargetRuntimeMock,
  ensureAdapterExecutionTargetCommandResolvableMock,
  runAdapterExecutionTargetShellCommand,
  runAdapterExecutionTargetProcessMock,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "remote failure",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  syncDirectoryToSsh: vi.fn(async () => undefined),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({
    env: {
      PAPERCLIP_API_URL: "http://127.0.0.1:4310",
      PAPERCLIP_API_KEY: "bridge-token",
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
    },
    stop: async () => {},
  })),
  prepareAdapterExecutionTargetRuntimeMock: vi.fn(),
  ensureAdapterExecutionTargetCommandResolvableMock: vi.fn(),
  runAdapterExecutionTargetProcessMock: vi.fn(),
  runAdapterExecutionTargetShellCommand: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: null,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/ssh", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/ssh")>(
    "@paperclipai/adapter-utils/ssh",
  );
  return {
    ...actual,
    prepareWorkspaceForSshExecution,
    restoreWorkspaceFromSshExecution,
    syncDirectoryToSsh,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    prepareAdapterExecutionTargetRuntime: prepareAdapterExecutionTargetRuntimeMock.mockImplementation(
      actual.prepareAdapterExecutionTargetRuntime,
    ),
    ensureAdapterExecutionTargetCommandResolvable: ensureAdapterExecutionTargetCommandResolvableMock.mockImplementation(
      actual.ensureAdapterExecutionTargetCommandResolvable,
    ),
    runAdapterExecutionTargetProcess: runAdapterExecutionTargetProcessMock.mockImplementation(
      actual.runAdapterExecutionTargetProcess,
    ),
    runAdapterExecutionTargetShellCommand,
    startAdapterExecutionTargetPaperclipBridge,
  };
});

import { execute } from "./execute.js";

describe("codex remote execution", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("prepares the workspace, syncs CODEX_HOME, and restores workspace changes for remote SSH execution", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-1/workspace";
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(rootDir, "instructions.md"), "Use the remote workspace.\n", "utf8");
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");
    const alternateWorkspaceDir = path.join(rootDir, "alternate-workspace");
    await mkdir(alternateWorkspaceDir, { recursive: true });

    await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
          strategy: "git_worktree",
          workspaceId: "workspace-1",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
          repoRef: "main",
          branchName: "feature/remote-codex",
          worktreePath: workspaceDir,
        },
        paperclipWorkspaces: [
          {
            workspaceId: "workspace-1",
            cwd: workspaceDir,
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "main",
          },
          {
            workspaceId: "workspace-2",
            cwd: alternateWorkspaceDir,
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "feature/other",
          },
        ],
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledTimes(1);
    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      localDir: workspaceDir,
      remoteDir: managedRemoteWorkspace,
    }));
    expect(syncDirectoryToSsh).toHaveBeenCalledTimes(1);
    // Remote runs sync a throwaway, sandbox-sanitized copy of the Codex home
    // (host-only config.toml sections stripped), so localDir is a temp dir
    // rather than the managed home itself.
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      localDir: expect.any(String),
      remoteDir: `${managedRemoteWorkspace}/.paperclip-runtime/codex/home`,
      followSymlinks: true,
    }));

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[2]).not.toContain("--skip-git-repo-check");
    expect(call?.[3].env.CODEX_HOME).toBe(`${managedRemoteWorkspace}/.paperclip-runtime/codex/home`);
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_CWD).toBe(managedRemoteWorkspace);
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_WORKTREE_PATH).toBeUndefined();
    expect(JSON.parse(call?.[3].env.PAPERCLIP_WORKSPACES_JSON ?? "[]")).toEqual([
      {
        workspaceId: "workspace-1",
        cwd: managedRemoteWorkspace,
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        repoRef: "main",
      },
      {
        workspaceId: "workspace-2",
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        repoRef: "feature/other",
      },
    ]);
    expect(call?.[3].env.PAPERCLIP_API_URL).toBe("http://127.0.0.1:4310");
    expect(call?.[3].env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
    expect(call?.[3].remoteExecution?.remoteCwd).toBe(managedRemoteWorkspace);
    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      localDir: workspaceDir,
      remoteDir: managedRemoteWorkspace,
    }));
  });

  it("mirrors sandbox alive pings into Codex-compatible progress transcript lines", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-progress-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    (runChildProcess as unknown as {
      mockImplementationOnce: (fn: (...args: unknown[]) => Promise<{
        exitCode: number;
        signal: string | null;
        timedOut: boolean;
        stdout: string;
        stderr: string;
        pid: number | null;
        startedAt: string;
      }>) => void;
    }).mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[3] as {
        onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
      };
      await options.onLog?.(
        "stdout",
        `${JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_1",
            type: "agent_message",
            text: "Creating GitHub PR",
          },
        })}\n`,
      );
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: `${JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_1",
            type: "agent_message",
            text: "Creating GitHub PR",
          },
        })}\n`,
        stderr: "",
        pid: 123,
        startedAt: new Date().toISOString(),
      };
    });

    const chunks: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await execute({
      runId: "run-progress",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async (stream, chunk) => {
        chunks.push({ stream, chunk });
      },
    });

    const bridgeCalls = (startAdapterExecutionTargetPaperclipBridge as unknown as {
      mock: { calls: Array<[unknown]> };
    }).mock.calls;
    const bridgeOptions = bridgeCalls[0]?.[0] as
      | { onActivity?: (activity: { source: string | null; status: string | null }) => Promise<void> }
      | undefined;
    expect(bridgeOptions?.onActivity).toEqual(expect.any(Function));

    await bridgeOptions?.onActivity?.({
      source: "sandbox_bridge",
      status: "alive",
    });
    await bridgeOptions?.onActivity?.({
      source: "sandbox_bridge",
      status: "alive",
    });

    const progressChunks = chunks.filter((entry) =>
      entry.stream === "stdout" &&
      entry.chunk.includes("Still working: Creating GitHub PR")
    );
    expect(progressChunks).toHaveLength(1);
    expect(progressChunks[0]?.chunk).toContain('"type":"agent_message"');
  });

  it("emits one bridge-alive progress line while waiting for first Codex output", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-waiting-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    const chunks: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await execute({
      runId: "run-waiting",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async (stream, chunk) => {
        chunks.push({ stream, chunk });
      },
    });

    const bridgeCalls = (startAdapterExecutionTargetPaperclipBridge as unknown as {
      mock: { calls: Array<[unknown]> };
    }).mock.calls;
    const bridgeOptions = bridgeCalls[0]?.[0] as
      | { onActivity?: (activity: { source: string | null; status: string | null }) => Promise<void> }
      | undefined;

    await bridgeOptions?.onActivity?.({
      source: "sandbox_bridge",
      status: "alive",
    });
    await bridgeOptions?.onActivity?.({
      source: "sandbox_bridge",
      status: "alive",
    });

    const waitingChunks = chunks.filter((entry) =>
      entry.stream === "stdout" &&
      entry.chunk.includes("Sandbox bridge alive; waiting for Codex output")
    );
    expect(waitingChunks).toHaveLength(1);
    expect(waitingChunks[0]?.chunk).toContain('"type":"agent_message"');
  });

  it("finalizes a sandbox run when the issue is marked terminal through the bridge and Codex keeps running", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-terminal-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "config.toml"), "model = \"gpt-5\"\n", "utf8");

    const sandboxTarget = {
      kind: "remote" as const,
      transport: "sandbox" as const,
      providerKey: "cloudflare",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd: "/workspace/paperclip",
      timeoutMs: 30_000,
      runner: {
        execute: vi.fn(async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        })),
      },
    };

    prepareAdapterExecutionTargetRuntimeMock.mockImplementationOnce(async (input: {
      target: typeof sandboxTarget;
    }) => ({
      target: input.target,
      workspaceRemoteDir: "/workspace/paperclip",
      runtimeRootDir: "/workspace/paperclip/.paperclip-runtime/codex",
      assetDirs: {
        home: "/workspace/paperclip/.paperclip-runtime/codex/home",
      },
      restoreWorkspace: async () => {},
    }));
    ensureAdapterExecutionTargetCommandResolvableMock.mockResolvedValueOnce(undefined);
    runAdapterExecutionTargetProcessMock.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[4] as {
        onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
      };
      await options.onLog?.(
        "stdout",
        `${JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_1",
            type: "agent_message",
            text: "Blocked before implementation.",
          },
        })}\n`,
      );
      return await new Promise<never>(() => {});
    });

    const chunks: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const resultPromise = execute({
      runId: "run-terminal",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        taskId: "issue-1",
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTarget: sandboxTarget,
      onLog: async (stream, chunk) => {
        chunks.push({ stream, chunk });
      },
    });

    for (let i = 0; i < 300; i += 1) {
      if ((startAdapterExecutionTargetPaperclipBridge as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const bridgeCalls = (startAdapterExecutionTargetPaperclipBridge as unknown as {
      mock: { calls: Array<[unknown]> };
    }).mock.calls;
    const bridgeOptions = bridgeCalls[0]?.[0] as
      | { onActivity?: (activity: { source: string | null; status: string | null; at: string | null; payload: Record<string, unknown> }) => Promise<void> }
      | undefined;
    expect(bridgeOptions?.onActivity).toEqual(expect.any(Function));

    await bridgeOptions?.onActivity?.({
      source: "paperclip_issue",
      status: "terminal:blocked",
      at: "2026-06-20T14:23:59.000Z",
      payload: {
        issueId: "issue-1",
        issueKey: "LOC-48",
        status: "blocked",
      },
    });

    const result = await resultPromise;
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.errorMessage).toBeNull();
    expect(result.summary).toContain("LOC-48 was marked blocked");
    expect(chunks.some((entry) =>
      entry.chunk.includes("Codex did not exit after LOC-48 was marked blocked")
    )).toBe(true);
  }, 10_000);

  it("does not resume saved Codex sessions for remote SSH execution without a matching remote identity", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-resume-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    await execute({
      runId: "run-ssh-no-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-123",
        sessionParams: {
          sessionId: "session-123",
          cwd: "/remote/workspace",
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: {
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[2]).toEqual([
      "exec",
      "--json",
      "-",
    ]);
  });

  it("resumes saved Codex sessions for remote SSH execution when the remote identity matches", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-resume-match-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-ssh-resume/workspace";
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    await execute({
      runId: "run-ssh-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-123",
        sessionParams: {
          sessionId: "session-123",
          cwd: managedRemoteWorkspace,
          remoteExecution: {
            transport: "ssh",
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteCwd: managedRemoteWorkspace,
          },
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: {
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[2]).toEqual([
      "exec",
      "--json",
      "resume",
      "session-123",
      "-",
    ]);
  });

  it("uses the provider-neutral execution target contract for remote SSH execution", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-target-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-target/workspace";
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    await execute({
      runId: "run-target",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-123",
        sessionParams: {
          sessionId: "session-123",
          cwd: managedRemoteWorkspace,
          remoteExecution: {
            transport: "ssh",
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteCwd: managedRemoteWorkspace,
          },
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: {
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTarget: {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/remote/workspace",
        spec: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(syncDirectoryToSsh).toHaveBeenCalledTimes(1);
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[2]).toEqual([
      "exec",
      "--json",
      "resume",
      "session-123",
      "-",
    ]);
    expect(call?.[3].env.CODEX_HOME).toBe(`${managedRemoteWorkspace}/.paperclip-runtime/codex/home`);
    expect(call?.[3].remoteExecution?.remoteCwd).toBe(managedRemoteWorkspace);
  });

  it("installs sandbox Codex config into the user-level global home", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-sandbox-global-home-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "config.toml"), 'model = "gpt-5"\n', "utf8");
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    prepareAdapterExecutionTargetRuntimeMock.mockResolvedValueOnce({
      target: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "cloudflare",
        leaseId: "lease-1",
        remoteCwd: "/workspace/paperclip",
      },
      workspaceRemoteDir: "/workspace/paperclip",
      runtimeRootDir: "/workspace/paperclip/.paperclip-runtime/codex",
      assetDirs: {
        home: "/workspace/paperclip/.paperclip-runtime/codex/home",
      },
      restoreWorkspace: async () => {},
    });

    await execute({
      runId: "run-sandbox-global-home",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "cloudflare",
        leaseId: "lease-1",
        remoteCwd: "/workspace/paperclip",
        runner: {
          execute: vi.fn(async () => ({
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "",
            stderr: "",
            pid: null,
            startedAt: new Date().toISOString(),
          })),
        },
      },
      onLog: async () => {},
    });

    expect(runAdapterExecutionTargetShellCommand).toHaveBeenCalledWith(
      "run-sandbox-global-home",
      expect.objectContaining({ transport: "sandbox" }),
      expect.stringContaining('dst="/root/.codex"'),
      expect.objectContaining({ cwd: "/" }),
    );
    expect(runAdapterExecutionTargetShellCommand).toHaveBeenCalledWith(
      "run-sandbox-global-home",
      expect.objectContaining({ transport: "sandbox" }),
      expect.stringContaining('test ! -f "$CODEX_HOME/auth.json"'),
      expect.objectContaining({
        env: expect.objectContaining({
          CODEX_HOME: "/root/.codex",
          HOME: "/root",
        }),
      }),
    );
  });
});
