import { describe, expect, it, vi } from "vitest";
import { applyCodexRemoteDefaults, createServerAdapter, CODEX_REMOTE_TYPE } from "./adapter.js";

vi.mock("./execute.js", () => ({
  execute: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    resultJson: { ok: true },
  })),
}));

describe("createServerAdapter", () => {
  it("returns a complete standalone codex_remote module", () => {
    const adapter = createServerAdapter();
    expect(adapter.type).toBe("codex_remote");
    expect(CODEX_REMOTE_TYPE).toBe("codex_remote");
    expect(typeof adapter.execute).toBe("function");
    expect(typeof adapter.testEnvironment).toBe("function");
    expect(typeof adapter.getRuntimeCommandSpec).toBe("function");
    expect(Array.isArray(adapter.models)).toBe(true);
    expect(adapter.instructionsPathKey).toBe("instructionsFilePath");
    expect(adapter.requiresMaterializedRuntimeSkills).toBe(false);
  });

  it("provisions the @openai/codex runtime command by default", () => {
    const adapter = createServerAdapter();
    const spec = adapter.getRuntimeCommandSpec?.({});
    expect(spec?.command).toBe("codex");
    expect(spec?.detectCommand).toBe("codex");
    expect(spec?.installCommand).toContain("@openai/codex");
  });

  it("does not self-install when an explicit command path is configured", () => {
    const adapter = createServerAdapter();
    const spec = adapter.getRuntimeCommandSpec?.({ command: "/usr/local/bin/codex" });
    expect(spec?.command).toBe("/usr/local/bin/codex");
    expect(spec?.installCommand).toBeNull();
  });

  it("rejects a non-remote execution target", async () => {
    const adapter = createServerAdapter();
    await expect(
      adapter.execute({
        config: {},
        executionTarget: { kind: "local" },
        onLog: async () => {},
      } as never),
    ).rejects.toThrow(/remote execution target/);
  });

  it("accepts an SSH execution target", async () => {
    const adapter = createServerAdapter();
    const result = await adapter.execute({
      config: {},
      executionTarget: {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/workspace",
        spec: {
          host: "127.0.0.1",
          port: 2222,
          username: "paperclip",
          remoteWorkspacePath: "/workspace",
          remoteCwd: "/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);
  });
});

describe("applyCodexRemoteDefaults", () => {
  it("applies sandbox-only remote defaults", () => {
    const result = applyCodexRemoteDefaults({});
    expect(result.timeoutSec).toBe(300);
    expect(result.dangerouslyBypassApprovalsAndSandbox).toBe(true);
    expect(result.remoteWorkspaceSync).toBe(false);
  });

  it("preserves an explicit positive timeout", () => {
    const result = applyCodexRemoteDefaults({ timeoutSec: 900 });
    expect(result.timeoutSec).toBe(900);
  });

  it("replaces a non-positive timeout with the default", () => {
    expect(applyCodexRemoteDefaults({ timeoutSec: 0 }).timeoutSec).toBe(300);
    expect(applyCodexRemoteDefaults({ timeoutSec: -5 }).timeoutSec).toBe(300);
  });
});
