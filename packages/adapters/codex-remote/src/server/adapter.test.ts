import { describe, expect, it } from "vitest";
import { applyCodexRemoteDefaults, createServerAdapter, CODEX_REMOTE_TYPE } from "./adapter.js";

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

  it("rejects a non-sandbox execution target", async () => {
    const adapter = createServerAdapter();
    await expect(
      adapter.execute({
        config: {},
        executionTarget: { kind: "local" },
        onLog: async () => {},
      } as never),
    ).rejects.toThrow(/sandbox execution target/);
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
