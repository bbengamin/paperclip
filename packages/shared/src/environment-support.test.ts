import { describe, expect, it } from "vitest";
import {
  isSandboxProviderSupportedForAdapter,
  supportedEnvironmentDriversForAdapter,
} from "./environment-support.js";

describe("supportedEnvironmentDriversForAdapter", () => {
  it("allows codex_remote to use sandbox environments", () => {
    expect(supportedEnvironmentDriversForAdapter("codex_remote")).toEqual([
      "local",
      "ssh",
      "sandbox",
    ]);
  });
});

describe("isSandboxProviderSupportedForAdapter", () => {
  it("accepts additional sandbox providers for remote-managed adapters", () => {
    expect(
      isSandboxProviderSupportedForAdapter("codex_local", "fake-plugin", ["fake-plugin"]),
    ).toBe(true);
  });

  it("accepts additional sandbox providers for codex_remote", () => {
    expect(
      isSandboxProviderSupportedForAdapter("codex_remote", "daytona", ["daytona"]),
    ).toBe(true);
  });

  it("rejects providers for adapters without remote-managed environment support", () => {
    expect(
      isSandboxProviderSupportedForAdapter("openclaw", "fake-plugin", ["fake-plugin"]),
    ).toBe(false);
  });
});
