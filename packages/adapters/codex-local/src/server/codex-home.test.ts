import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareManagedCodexHome } from "./codex-home.js";

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
