import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pathExists, prepareManagedCodexHome, prepareRemoteCodexHomeAsset, sanitizeRemoteCodexConfigToml } from "./codex-home.js";

describe("sanitizeRemoteCodexConfigToml", () => {
  it("keeps only allowlisted top-level keys and model_providers sections", () => {
    const toml = [
      "windows_wsl_setup_acknowledged = true",
      'model = "gpt-5.5"',
      'model_provider = "cliproxyapi"',
      'model_reasoning_effort = "medium"',
      'personality = "pragmatic"',
      "",
      "[marketplaces.openai-bundled]",
      'source = "local"',
      "",
      "[windows]",
      'sandbox = "elevated"',
      "",
      "[projects.'c:\\\\work']",
      'trust_level = "trusted"',
      "",
      '[plugins."linear@openai-curated"]',
      "enabled = true",
      "",
      "[model_providers.cliproxyapi]",
      'base_url = "http://100.114.28.103:8317/v1"',
      'experimental_bearer_token = "secret"',
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "",
      "[mcp_servers.node_repl]",
      'command = "C:\\\\node_repl.exe"',
      "startup_timeout_sec = 120",
    ].join("\n");

    const out = sanitizeRemoteCodexConfigToml(toml);

    // Required for Codex + the provider: kept.
    expect(out).toContain('model = "gpt-5.5"');
    expect(out).toContain('model_provider = "cliproxyapi"');
    expect(out).toContain('model_reasoning_effort = "medium"');
    expect(out).toContain("[model_providers.cliproxyapi]");
    expect(out).toContain("experimental_bearer_token");
    expect(out).toContain("requires_openai_auth = false");
    // Force HTTP transport so the sandbox doesn't burn ~75s retrying wss://.
    expect(out).toContain("supports_websockets = false");

    // Everything host-specific: dropped.
    expect(out).not.toContain("windows_wsl_setup_acknowledged");
    expect(out).not.toContain("[mcp_servers");
    expect(out).not.toContain("node_repl.exe");
    expect(out).not.toContain("startup_timeout_sec");
    expect(out).not.toContain("[projects");
    expect(out).not.toContain("[windows]");
    expect(out).not.toContain("[marketplaces");
    expect(out).not.toContain("[plugins");
  });

  it("keeps an explicit supports_websockets value instead of injecting", () => {
    const toml = [
      'model_provider = "cliproxyapi"',
      "",
      "[model_providers.cliproxyapi]",
      'base_url = "http://x/v1"',
      "supports_websockets = true",
    ].join("\n");

    const out = sanitizeRemoteCodexConfigToml(toml);

    expect(out).toContain("supports_websockets = true");
    expect(out).not.toContain("supports_websockets = false");
  });
});

describe("prepareRemoteCodexHomeAsset", () => {
  it("omits auth.json so sandbox runs use config.toml provider credentials", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-home-"));
    const sourceHome = path.join(root, "source");
    await fs.mkdir(sourceHome, { recursive: true });
    await fs.writeFile(
      path.join(sourceHome, "config.toml"),
      [
        'model_provider = "cliproxyapi"',
        "[model_providers.cliproxyapi]",
        'base_url = "http://proxy/v1"',
        "requires_openai_auth = false",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(path.join(sourceHome, "auth.json"), '{"auth_mode":"chatgpt"}\n', "utf8");

    const asset = await prepareRemoteCodexHomeAsset(sourceHome);
    try {
      await expect(pathExists(path.join(asset.dir, "auth.json"))).resolves.toBe(false);
      await expect(fs.readFile(path.join(asset.dir, "config.toml"), "utf8")).resolves.toContain(
        "[model_providers.cliproxyapi]",
      );
    } finally {
      await asset.cleanup();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("codex managed home", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function canCreateSymlink(): Promise<boolean> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-symlink-check-"));
    const source = path.join(root, "source.txt");
    const target = path.join(root, "target.txt");
    try {
      await fs.writeFile(source, "probe", "utf8");
      await fs.symlink(source, target);
      return true;
    } catch {
      return false;
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  it("treats a concurrently-created expected auth symlink as success", async () => {
    if (!(await canCreateSymlink())) return;

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-"));
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const managedCodexHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "codex-home",
    );
    const sharedAuth = path.join(sharedCodexHome, "auth.json");
    const managedAuth = path.join(managedCodexHome, "auth.json");

    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(sharedAuth, '{"token":"shared"}\n', "utf8");

    const originalSymlink = fs.symlink.bind(fs);
    vi.spyOn(fs, "symlink").mockImplementationOnce(async (source, target, type) => {
      await originalSymlink(source, target, type);
      const error = new Error("file already exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    });

    try {
      await expect(
        prepareManagedCodexHome(
          {
            CODEX_HOME: sharedCodexHome,
            PAPERCLIP_HOME: paperclipHome,
            PAPERCLIP_INSTANCE_ID: "default",
          },
          async () => {},
          "company-1",
        ),
      ).resolves.toBe(managedCodexHome);

      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(managedAuth)).toBe(await fs.realpath(sharedAuth));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refreshes a stale copied config.toml from the shared home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-"));
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const managedCodexHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "codex-home",
    );
    const sharedConfig = path.join(sharedCodexHome, "config.toml");
    const managedConfig = path.join(managedCodexHome, "config.toml");
    const logs: string[] = [];

    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(sharedConfig, 'requires_openai_auth = false\n', "utf8");
    // Simulate an earlier run that copied a now-stale config into the managed home.
    await fs.mkdir(managedCodexHome, { recursive: true });
    await fs.writeFile(managedConfig, 'requires_openai_auth = true\n', "utf8");

    const env = {
      CODEX_HOME: sharedCodexHome,
      PAPERCLIP_HOME: paperclipHome,
      PAPERCLIP_INSTANCE_ID: "default",
    };

    try {
      await prepareManagedCodexHome(env, async (_stream, chunk) => {
        logs.push(chunk);
      }, "company-1");

      await expect(fs.readFile(managedConfig, "utf8")).resolves.toBe('requires_openai_auth = false\n');
      expect(logs.join("")).toContain("refreshed config.toml from shared config");

      // A second run with an unchanged source should not report another refresh.
      logs.length = 0;
      await prepareManagedCodexHome(env, async (_stream, chunk) => {
        logs.push(chunk);
      }, "company-1");
      expect(logs.join("")).not.toContain("refreshed config.toml");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("copies auth.json when symlink creation is not permitted", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-"));
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const managedCodexHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "codex-home",
    );
    const sharedAuth = path.join(sharedCodexHome, "auth.json");
    const managedAuth = path.join(managedCodexHome, "auth.json");
    const logs: string[] = [];

    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(sharedAuth, '{"token":"shared"}\n', "utf8");

    vi.spyOn(fs, "symlink").mockImplementationOnce(async () => {
      const error = new Error("operation not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });

    try {
      await expect(
        prepareManagedCodexHome(
          {
            CODEX_HOME: sharedCodexHome,
            PAPERCLIP_HOME: paperclipHome,
            PAPERCLIP_INSTANCE_ID: "default",
          },
          async (_stream, chunk) => {
            logs.push(chunk);
          },
          "company-1",
        ),
      ).resolves.toBe(managedCodexHome);

      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(false);
      await expect(fs.readFile(managedAuth, "utf8")).resolves.toBe('{"token":"shared"}\n');
      expect(logs.join("")).toContain("copied auth.json because symlinks are unavailable");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
