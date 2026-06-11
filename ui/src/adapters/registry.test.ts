import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { UIAdapterModule } from "./types";
import {
  findUIAdapter,
  getUIAdapter,
  listUIAdapters,
  registerUIAdapter,
  unregisterUIAdapter,
} from "./registry";
import { getAdapterDisplay, getAdapterLabel } from "./adapter-display-registry";
import { processUIAdapter } from "./process";
import { SchemaConfigFields } from "./schema-config-fields";
import { codexLocalUIAdapter } from "./codex-local";
import { hermesLocalUIAdapter } from "./hermes-local";
import { openCodeLocalUIAdapter } from "./opencode-local";
import { defaultCreateValues } from "../components/agent-config-defaults";

const externalUIAdapter: UIAdapterModule = {
  type: "external_test",
  label: "External Test",
  parseStdoutLine: () => [],
  ConfigFields: () => null,
  buildAdapterConfig: () => ({}),
};

describe("ui adapter registry", () => {
  beforeEach(() => {
    unregisterUIAdapter("external_test");
  });

  afterEach(() => {
    unregisterUIAdapter("external_test");
  });

  it("registers adapters for lookup and listing", () => {
    registerUIAdapter(externalUIAdapter);

    expect(findUIAdapter("external_test")).toBe(externalUIAdapter);
    expect(getUIAdapter("external_test")).toBe(externalUIAdapter);
    expect(listUIAdapters().some((adapter) => adapter.type === "external_test")).toBe(true);
  });

  it("falls back to the process parser for unknown types after unregistering", () => {
    registerUIAdapter(externalUIAdapter);

    unregisterUIAdapter("external_test");

    expect(findUIAdapter("external_test")).toBeNull();
    const fallback = getUIAdapter("external_test");
    // Unknown types return a lazy-loading wrapper (for external adapters),
    // not the process adapter directly. The type is preserved.
    expect(fallback.type).toBe("external_test");
    // But it uses the schema-based config fields for external adapter forms.
    expect(fallback.ConfigFields).toBe(SchemaConfigFields);
  });

  it("lists Paperclip wrapper adapters distinctly from native local adapters", () => {
    const adapters = listUIAdapters();

    expect(adapters.some((adapter) => adapter.type === "codex_local")).toBe(true);
    expect(adapters.some((adapter) => adapter.type === "codex_paperclip_local")).toBe(true);
    expect(adapters.some((adapter) => adapter.type === "hermes_local")).toBe(true);
    expect(adapters.some((adapter) => adapter.type === "hermes_paperclip_local")).toBe(true);
    expect(adapters.some((adapter) => adapter.type === "opencode_local")).toBe(true);
    expect(adapters.some((adapter) => adapter.type === "opencode_paperclip_local")).toBe(true);

    expect(getAdapterLabel("codex_paperclip_local")).toBe("Codex (Paperclip local)");
    expect(getAdapterLabel("hermes_paperclip_local")).toBe("Hermes Agent (Paperclip local)");
    expect(getAdapterLabel("opencode_paperclip_local")).toBe("OpenCode (Paperclip local)");
    expect(getAdapterDisplay("codex_paperclip_local").description).toContain("Paperclip runtime policy");
  });

  it("lists Codex Remote distinctly from Codex Local", () => {
    const codexRemote = getUIAdapter("codex_remote");

    expect(getUIAdapter("codex_local")).toBe(codexLocalUIAdapter);
    expect(codexRemote.type).toBe("codex_remote");
    expect(codexRemote).not.toBe(codexLocalUIAdapter);
    expect(getAdapterLabel("codex_remote")).toBe("Codex (remote)");
    expect(getAdapterDisplay("codex_remote").description).toContain("Git-backed sandboxes");
  });

  it("builds Codex Remote config with a Git-clone workspace realization hint", () => {
    const config = getUIAdapter("codex_remote").buildAdapterConfig({
      ...defaultCreateValues,
      adapterType: "codex_remote",
      model: "gpt-5.3-codex",
    });

    expect(config).toMatchObject({
      model: "gpt-5.3-codex",
      workspaceRealization: {
        workspaceStrategy: "git_clone",
      },
    });
  });

  it("reuses native config builders and parsers for Paperclip wrapper adapters", () => {
    const codexWrapper = getUIAdapter("codex_paperclip_local");
    const hermesWrapper = getUIAdapter("hermes_paperclip_local");
    const openCodeWrapper = getUIAdapter("opencode_paperclip_local");

    expect(codexWrapper.parseStdoutLine).toBe(codexLocalUIAdapter.parseStdoutLine);
    expect(codexWrapper.ConfigFields).toBe(codexLocalUIAdapter.ConfigFields);
    expect(codexWrapper.buildAdapterConfig).toBe(codexLocalUIAdapter.buildAdapterConfig);

    expect(hermesWrapper.parseStdoutLine).toBe(hermesLocalUIAdapter.parseStdoutLine);
    expect(hermesWrapper.ConfigFields).toBe(hermesLocalUIAdapter.ConfigFields);
    expect(hermesWrapper.buildAdapterConfig).toBe(hermesLocalUIAdapter.buildAdapterConfig);

    expect(openCodeWrapper.parseStdoutLine).toBe(openCodeLocalUIAdapter.parseStdoutLine);
    expect(openCodeWrapper.ConfigFields).toBe(openCodeLocalUIAdapter.ConfigFields);
    expect(openCodeWrapper.buildAdapterConfig).toBe(openCodeLocalUIAdapter.buildAdapterConfig);
  });
});
