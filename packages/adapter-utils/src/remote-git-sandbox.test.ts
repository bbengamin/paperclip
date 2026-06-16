import { describe, expect, it, vi } from "vitest";

import {
  deriveRemoteGitSandboxSpec,
  prepareRemoteGitSandbox,
  redactRemoteGitSandboxSecrets,
  validateRemoteGitSandboxSafety,
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

function createRunner(
  handler?: (script: string) => RunProcessResult,
): RemoteGitSandboxRunner & { scripts: string[]; envs: Array<Record<string, string> | undefined> } {
  const scripts: string[] = [];
  const envs: Array<Record<string, string> | undefined> = [];
  return {
    scripts,
    envs,
    execute: async (input) => {
      const script = input.args?.[1] ?? "";
      scripts.push(script);
      envs.push(input.env);
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
    // A fresh sandbox has no git identity; ensure we set a repo-local one so
    // commits don't abort with "Author identity unknown".
    expect(runner.scripts.join("\n")).toContain("git config user.email");
    expect(runner.scripts.join("\n")).toContain("git config user.name");
    expect(runner.scripts.join("\n")).toContain("/.paperclip-runtime/");
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
          committerName: "Paperclip Agent",
          committerEmail: "paperclip-agent@users.noreply.github.com",
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

  it("requires explicitly approved credentials and strips host env by default", async () => {
    const runner = createRunner((script) => {
      if (script === "git status --porcelain=v1") return ok("\n");
      return ok();
    });

    await expect(
      prepareRemoteGitSandbox({
        runner,
        spec: {
          repoUrl: "https://github.com/example/repo",
          baseRef: "main",
          workBranch: "paperclip/RL-202",
          remoteCwd: "/sandbox/repo",
          setupCommand: null,
          cleanupCommand: null,
          committerName: "Paperclip Agent",
          committerEmail: "paperclip-agent@users.noreply.github.com",
        },
        safety: {
          requiredCredentialEnv: ["GIT_AUTH_TOKEN"],
          approvedEnv: {
            HOME: "/Users/local",
          },
        },
      }),
    ).rejects.toThrow("missing required credential env: GIT_AUTH_TOKEN");

    const sandbox = await prepareRemoteGitSandbox({
      runner,
      spec: {
        repoUrl: "https://github.com/example/repo",
        baseRef: "main",
        workBranch: "paperclip/RL-202",
        remoteCwd: "/sandbox/repo",
        setupCommand: null,
        cleanupCommand: null,
      },
      safety: {
        requiredCredentialEnv: ["GIT_AUTH_TOKEN"],
        approvedEnv: {
          GIT_AUTH_TOKEN: "token-123456789",
          PAPERCLIP_API_KEY: "run-key-123456789",
          HOME: "/Users/local",
        },
      },
    });
    await sandbox.finalize();

    expect(runner.envs.every((env) => env?.GIT_AUTH_TOKEN === "token-123456789")).toBe(true);
    expect(runner.envs.every((env) => env?.PAPERCLIP_API_KEY === "run-key-123456789")).toBe(true);
    expect(runner.envs.every((env) => env?.HOME === "/Users/local")).toBe(true);
    expect(runner.envs.every((env) => !("PATH" in (env ?? {})))).toBe(true);
  });

  it("rejects wrong repos and protected branch push targets before running commands", async () => {
    const spec = {
      repoUrl: "https://github.com/example/repo",
      baseRef: "main",
      workBranch: "main",
      remoteCwd: "/sandbox/repo",
      setupCommand: null,
      cleanupCommand: null,
    };
    const runner = createRunner();

    expect(() =>
      validateRemoteGitSandboxSafety({
        spec: {
          ...spec,
          workBranch: "paperclip/RL-202",
        },
        policy: {
          allowedRepoUrls: ["https://github.com/other/repo"],
        },
      }),
    ).toThrow("repo is not allowed");

    await expect(
      prepareRemoteGitSandbox({
        runner,
        spec,
      }),
    ).rejects.toThrow("refuses to push protected branch: main");
    expect(runner.scripts).toHaveLength(0);
  });

  it("redacts configured secrets and embedded URL credentials from surfaced errors", async () => {
    expect(
      redactRemoteGitSandboxSecrets("clone https://user:secret-token@example.com/repo failed", ["secret-token"]),
    ).toBe("clone https://[redacted]@example.com/repo failed");

    const runner = createRunner(() => fail("fatal: auth token token-123456789 rejected"));
    await expect(
      prepareRemoteGitSandbox({
        runner,
        spec: {
          repoUrl: "https://user:token-123456789@example.com/repo.git",
          baseRef: "main",
          workBranch: "paperclip/RL-202",
          remoteCwd: "/sandbox/repo",
          setupCommand: null,
          cleanupCommand: null,
          committerName: "Paperclip Agent",
          committerEmail: "paperclip-agent@users.noreply.github.com",
        },
        safety: {
          approvedEnv: {
            GIT_AUTH_TOKEN: "token-123456789",
          },
        },
      }),
    ).rejects.toThrow("https://[redacted]@example.com/repo.git");
    await expect(
      prepareRemoteGitSandbox({
        runner,
        spec: {
          repoUrl: "https://user:token-123456789@example.com/repo.git",
          baseRef: "main",
          workBranch: "paperclip/RL-202",
          remoteCwd: "/sandbox/repo",
          setupCommand: null,
          cleanupCommand: null,
          committerName: "Paperclip Agent",
          committerEmail: "paperclip-agent@users.noreply.github.com",
        },
        safety: {
          approvedEnv: {
            GIT_AUTH_TOKEN: "token-123456789",
          },
        },
      }),
    ).rejects.not.toThrow("token-123456789");
  });
});
