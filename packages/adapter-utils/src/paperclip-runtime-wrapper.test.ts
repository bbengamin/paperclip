import { describe, expect, it } from "vitest";
import type { AdapterExecutionTarget } from "./execution-target.js";
import {
  DEFAULT_PAPERCLIP_API_SAFETY_PROMPT,
  applyPaperclipRuntimeEnv,
  composePaperclipPromptGuard,
  patchPaperclipRuntimeExecutionContext,
  resolvePaperclipRuntimeStateStrategy,
} from "./paperclip-runtime-wrapper.js";

describe("Paperclip runtime wrapper utilities", () => {
  it("injects run id and a missing Paperclip API key", () => {
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

  it("preserves an explicit Paperclip API key", () => {
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

  it("composes the default prompt guard", () => {
    expect(composePaperclipPromptGuard({ promptTemplate: "Do the work." })).toBe(
      `${DEFAULT_PAPERCLIP_API_SAFETY_PROMPT}\n\nDo the work.`,
    );
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

  it("uses managed runtime state for sandbox and credential-isolated runs", () => {
    expect(
      resolvePaperclipRuntimeStateStrategy({
        target: {
          kind: "remote",
          transport: "sandbox",
          remoteCwd: "/repo",
          providerKey: "cloudflare",
        },
      }),
    ).toMatchObject({
      strategy: "managed",
      managed: true,
    });
    expect(resolvePaperclipRuntimeStateStrategy({ injectsCredentials: true })).toMatchObject({
      strategy: "managed",
      managed: true,
    });
  });

  it("patches adapter execution context without replacing explicit auth", () => {
    const patched = patchPaperclipRuntimeExecutionContext({
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
      config: {
        env: {
          PAPERCLIP_API_KEY: "explicit-token",
        },
        promptTemplate: "Do the issue work.",
      },
      context: {},
      onLog: async () => undefined,
      authToken: "agent-token",
    });

    expect(patched.config.env).toMatchObject({
      PAPERCLIP_RUN_ID: "run-1",
      PAPERCLIP_API_KEY: "explicit-token",
    });
    expect(patched.config.promptTemplate).toContain("Paperclip API safety rule:");
    expect(patched.config.promptTemplate).toContain("Do the issue work.");
  });
});
