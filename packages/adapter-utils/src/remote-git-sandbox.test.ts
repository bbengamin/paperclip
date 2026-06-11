import { describe, expect, it, vi } from "vitest";

import {
  deriveRemoteGitSandboxSpec,
  prepareRemoteGitSandbox,
  withRemoteGitSandbox,
  type RemoteGitSandboxRunner,
} from "./remote-git-sandbox.js";
import type { RunProcessResult } from "./server-utils.js";

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

function createRunner(handler?: (script: string) => RunProcessResult): RemoteGitSandboxRunner & { scripts: string[] } {
  const scripts: string[] = [];
  return {
    scripts,
    execute: async (input) => {
      const script = input.args?.[1] ?? "";
      scripts.push(script);
      return handler?.(script) ?? ok();
    },
  };
}

describe("remote Git sandbox", () => {
  it("derives stable remote Git context from workspace and issue context", () => {
    const spec = deriveRemoteGitSandboxSpec({
      workspace: {
        repoUrl: "https://github.com/example/repo",
        repoRef: "release/next",
        name: "Paperclip API",
      },
      issue: {
        identifier: "RL-199",
      },
      remoteRootDir: "/workspaces",
    });

    expect(spec).toMatchObject({
      repoUrl: "https://github.com/example/repo",
      baseRef: "release/next",
      workBranch: "paperclip/RL-199",
      remoteCwd: "/workspaces/Paperclip-API",
    });
  });

  it("clones, fetches, checks out, commits, and pushes without archive sync commands", async () => {
    const runner = createRunner((script) => {
      if (script === "git status --porcelain=v1") return ok(" M README.md\n");
      if (script === "git rev-parse HEAD") return ok("abc123\n");
      return ok();
    });

    const sandbox = await prepareRemoteGitSandbox({
      runner,
      spec: {
        repoUrl: "git@example.com:org/repo.git",
        baseRef: "main",
        workBranch: "paperclip/RL-199",
        remoteCwd: "/sandbox/repo",
        setupCommand: "pnpm install",
        cleanupCommand: null,
      },
    });
    const result = await sandbox.finalize({ commitMessage: "RL-199 remote git layer" });

    expect(result).toEqual({
      dirty: true,
      status: "M README.md",
      commitSha: "abc123",
      pushed: true,
      pushedBranch: "paperclip/RL-199",
    });
    expect(runner.scripts.join("\n")).toContain("git clone --no-checkout");
    expect(runner.scripts.join("\n")).toContain("git fetch origin 'main'");
    expect(runner.scripts.join("\n")).toContain("git checkout -B 'paperclip/RL-199' FETCH_HEAD");
    expect(runner.scripts.join("\n")).toContain("pnpm install");
    expect(runner.scripts.join("\n")).toContain("git push origin HEAD:refs/heads/'paperclip/RL-199'");
    expect(runner.scripts.join("\n")).not.toMatch(/\btar\b|base64|workspace-upload|workspace-download/);
  });

  it("reports a clean tree without committing or pushing", async () => {
    const runner = createRunner((script) => {
      if (script === "git status --porcelain=v1") return ok("\n");
      return ok();
    });

    const sandbox = await prepareRemoteGitSandbox({
      runner,
      spec: {
        repoUrl: "https://github.com/example/repo",
        baseRef: "main",
        workBranch: "paperclip/RL-200",
        remoteCwd: "/sandbox/repo",
        setupCommand: null,
        cleanupCommand: null,
      },
    });
    const result = await sandbox.finalize();

    expect(result.dirty).toBe(false);
    expect(result.pushed).toBe(false);
    expect(runner.scripts.join("\n")).not.toContain("git commit");
    expect(runner.scripts.join("\n")).not.toContain("git push");
  });

  it("surfaces failed clone setup", async () => {
    const runner = createRunner((script) => {
      if (script.includes("git clone")) return fail("repository not found");
      return ok();
    });

    await expect(
      prepareRemoteGitSandbox({
        runner,
        spec: {
          repoUrl: "https://github.com/example/missing",
          baseRef: "main",
          workBranch: "paperclip/RL-201",
          remoteCwd: "/sandbox/repo",
          setupCommand: null,
          cleanupCommand: null,
        },
      }),
    ).rejects.toThrow("repository not found");
  });

  it("runs cleanup hooks when push fails inside the managed lifecycle", async () => {
    const cleanupHook = vi.fn(async () => undefined);
    const runner = createRunner((script) => {
      if (script === "git status --porcelain=v1") return ok(" M package.json\n");
      if (script === "git rev-parse HEAD") return ok("def456\n");
      if (script.includes("git push origin")) return fail("permission denied");
      return ok();
    });

    await expect(
      withRemoteGitSandbox({
        runner,
        spec: {
          repoUrl: "git@example.com:org/repo.git",
          baseRef: "main",
          workBranch: "paperclip/RL-202",
          remoteCwd: "/sandbox/repo",
          setupCommand: null,
          cleanupCommand: "rm -rf .paperclip-runtime",
        },
        cleanupHooks: [cleanupHook],
        work: async (sandbox) => {
          await sandbox.finalize();
        },
      }),
    ).rejects.toThrow("permission denied");

    expect(cleanupHook).toHaveBeenCalledTimes(1);
    expect(runner.scripts.join("\n")).toContain("rm -rf .paperclip-runtime");
  });
});
