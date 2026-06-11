import { describe, expect, it } from "vitest";
import type { AdapterExecutionTarget } from "./execution-target.js";
import {
  DEFAULT_PAPERCLIP_API_SAFETY_PROMPT,
  applyPaperclipRuntimeEnv,
  composePaperclipPromptGuard,
  resolvePaperclipRuntimeStateStrategy,
} from "./paperclip-wrapper.js";

describe("Paperclip adapter wrapper utilities", () => {
  it("injects the run id and missing Paperclip API token", () => {
    expect(
      applyPaperclipRuntimeEnv({
        env: { EXISTING: "1" },
        runId: "run-1",
        authToken: "agent-token",
      }),
    ).toEqual({
      EXISTING: "1",
      PAPERCLIP_RUN_ID: "run-1",
      PAPERCLIP_API_KEY: "agent-token",
    });
  });

  it("preserves an explicit Paperclip API token", () => {
    expect(
      applyPaperclipRuntimeEnv({
        env: { PAPERCLIP_API_KEY: "explicit-token" },
        runId: "run-1",
        authToken: "agent-token",
      }),
    ).toMatchObject({
      PAPERCLIP_RUN_ID: "run-1",
      PAPERCLIP_API_KEY: "explicit-token",
    });
  });

  it("supports runtime-specific env key names", () => {
    expect(
      applyPaperclipRuntimeEnv({
        env: {},
        runId: "run-1",
        authToken: "agent-token",
        apiKeyEnvKey: "CUSTOM_API_KEY",
        runIdEnvKey: "CUSTOM_RUN_ID",
      }),
    ).toEqual({
      CUSTOM_RUN_ID: "run-1",
      CUSTOM_API_KEY: "agent-token",
    });
  });

  it("prepends the default Paperclip prompt guard", () => {
    expect(composePaperclipPromptGuard({ promptTemplate: "Do work." })).toBe(
      `${DEFAULT_PAPERCLIP_API_SAFETY_PROMPT}\n\nDo work.`,
    );
  });

  it("can inject the prompt guard only when a runtime prompt already exists", () => {
    expect(
      composePaperclipPromptGuard({
        promptTemplate: "",
        mode: "prepend_when_present",
      }),
    ).toBe("");
    expect(
      composePaperclipPromptGuard({
        promptTemplate: "Existing prompt.",
        mode: "prepend_when_present",
      }),
    ).toBe(`${DEFAULT_PAPERCLIP_API_SAFETY_PROMPT}\n\nExisting prompt.`);
  });

  it("allows runtime-specific prompt guards", () => {
    expect(
      composePaperclipPromptGuard({
        promptTemplate: "Existing prompt.",
        guardPrompt: "Runtime rule.",
      }),
    ).toBe("Runtime rule.\n\nExisting prompt.");
  });

  it("preserves native runtime state for local and SSH targets by default", () => {
    const sshTarget: AdapterExecutionTarget = {
      kind: "remote",
      transport: "ssh",
      remoteCwd: "/repo",
      spec: {
        host: "example.com",
        port: 22,
        username: "agent",
        remoteWorkspacePath: "/repo",
        remoteCwd: "/repo",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    };

    expect(resolvePaperclipRuntimeStateStrategy({ target: { kind: "local" } })).toMatchObject({
      strategy: "native",
      managed: false,
    });
    expect(resolvePaperclipRuntimeStateStrategy({ target: sshTarget })).toMatchObject({
      strategy: "native",
      managed: false,
    });
  });

  it("uses managed runtime state for sandboxes and credential-isolated runs", () => {
    const sandboxTarget: AdapterExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/repo",
      providerKey: "daytona",
    };

    expect(resolvePaperclipRuntimeStateStrategy({ target: sandboxTarget })).toMatchObject({
      strategy: "managed",
      managed: true,
    });
    expect(resolvePaperclipRuntimeStateStrategy({ injectsCredentials: true })).toMatchObject({
      strategy: "managed",
      managed: true,
    });
  });

  it("treats explicit runtime state paths as configured, not Paperclip-managed", () => {
    expect(
      resolvePaperclipRuntimeStateStrategy({
        configuredPath: "/custom/runtime-home",
        injectsCredentials: true,
      }),
    ).toMatchObject({
      strategy: "configured",
      managed: false,
    });
  });
});
