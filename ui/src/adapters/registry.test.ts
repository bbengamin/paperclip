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

});
