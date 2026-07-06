import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

import { startCodexRemotePaperclipBridge } from "./paperclip-bridge.js";

const execFile = promisify(execFileCallback);

describe("codex_remote Paperclip bridge", () => {
  const cleanupDirs: string[] = [];
  const cleanupFns: Array<() => Promise<void>> = [];

  function createExecRunner() {
    return {
      execute: async (input: {
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        stdin?: string;
        timeoutMs?: number;
      }): Promise<RunProcessResult> => {
        const startedAt = new Date().toISOString();
        const env = {
          ...process.env,
          ...input.env,
        };
        const command =
          input.command === "sh" ? "/bin/sh" : input.command === "bash" ? "/bin/bash" : input.command;
        const args = [...(input.args ?? [])];
        if (
          input.stdin != null &&
          (input.command === "sh" || input.command === "bash") &&
          (args[0] === "-c" || args[0] === "-lc") &&
          typeof args[1] === "string"
        ) {
          env.PAPERCLIP_TEST_STDIN = input.stdin;
          args[1] = `printf '%s' "$PAPERCLIP_TEST_STDIN" | (${args[1]})`;
        }
        try {
          const result = await execFile(command, args, {
            cwd: input.cwd,
            env,
            maxBuffer: 32 * 1024 * 1024,
            timeout: input.timeoutMs,
          });
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: result.stdout,
            stderr: result.stderr,
            pid: null,
            startedAt,
          };
        } catch (error) {
          const err = error as NodeJS.ErrnoException & {
            stdout?: string;
            stderr?: string;
            code?: string | number | null;
            signal?: NodeJS.Signals | null;
            killed?: boolean;
          };
          return {
            exitCode: typeof err.code === "number" ? err.code : null,
            signal: err.signal ?? null,
            timedOut: Boolean(err.killed && input.timeoutMs),
            stdout: err.stdout ?? "",
            stderr: err.stderr ?? "",
            pid: null,
            startedAt,
          };
        }
      },
    };
  }

  async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async function startHostServer(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
    const server = createServer((req, res) => {
      void handler(req, res).catch((error) => {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind to a port.");
    cleanupFns.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return `http://127.0.0.1:${address.port}`;
  }

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const cleanup = cleanupFns.pop();
      if (!cleanup) continue;
      await cleanup().catch(() => undefined);
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("forwards multipart artifact uploads as bytes and JSON work products from codex_remote sandboxes", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-bridge-"));
    cleanupDirs.push(rootDir);
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    await mkdir(remoteWorkspaceDir, { recursive: true });
    await writeFile(path.join(remoteWorkspaceDir, "README.md"), "bridge test\n", "utf8");

    const uploadedBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x41]);
    const boundary = "paperclip-codex-remote-boundary";
    const multipartBody = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="tiny.png"\r\n` +
          `Content-Type: image/png\r\n\r\n`,
        "utf8",
      ),
      uploadedBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
    ]);
    const seen: Array<{ path: string; contentType: string | undefined; body: Buffer }> = [];
    const hostApiUrl = await startHostServer(async (req, res) => {
      const body = await readRequestBody(req);
      seen.push({
        path: req.url ?? "",
        contentType: req.headers["content-type"],
        body,
      });
      res.statusCode = 201;
      res.setHeader("content-type", "application/json");
      if ((req.url ?? "").endsWith("/attachments")) {
        res.end(JSON.stringify({ id: "attachment-1", contentPath: "/api/attachments/attachment-1/content" }));
        return;
      }
      res.end(JSON.stringify({ id: "work-product-1" }));
    });

    const bridge = await startCodexRemotePaperclipBridge({
      runId: "run-1",
      target: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "cloudflare",
        remoteCwd: remoteWorkspaceDir,
        runner: createExecRunner(),
      },
      runtimeRootDir: path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "codex"),
      hostApiToken: "host-token",
      hostApiUrl,
      timeoutSec: 30,
    });
    if (!bridge) throw new Error("Expected codex_remote bridge to start.");
    cleanupFns.push(bridge.stop);

    const uploadResponse = await fetch(`${bridge.env.PAPERCLIP_API_URL}/api/companies/company-1/issues/issue-1/attachments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.env.PAPERCLIP_API_KEY}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body: multipartBody,
    });
    expect(uploadResponse.status).toBe(201);

    const workProductResponse = await fetch(`${bridge.env.PAPERCLIP_API_URL}/api/issues/issue-1/work-products`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.env.PAPERCLIP_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "artifact",
        provider: "paperclip",
        metadata: { attachmentId: "attachment-1" },
      }),
    });
    expect(workProductResponse.status).toBe(201);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      path: "/api/companies/company-1/issues/issue-1/attachments",
      contentType: `multipart/form-data; boundary=${boundary}`,
    });
    expect(seen[0]?.body).toEqual(multipartBody);
    expect(seen[1]).toMatchObject({
      path: "/api/issues/issue-1/work-products",
      contentType: "application/json",
    });
    expect(JSON.parse(seen[1]?.body.toString("utf8") ?? "{}")).toMatchObject({
      type: "artifact",
      provider: "paperclip",
      metadata: { attachmentId: "attachment-1" },
    });
  });

  it("keeps unrelated routes denied by the codex_remote bridge allowlist", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-bridge-deny-"));
    cleanupDirs.push(rootDir);
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    await mkdir(remoteWorkspaceDir, { recursive: true });
    const hostApiUrl = await startHostServer(async (_req, res) => {
      res.statusCode = 500;
      res.end("should not be reached");
    });

    const bridge = await startCodexRemotePaperclipBridge({
      runId: "run-1",
      target: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "cloudflare",
        remoteCwd: remoteWorkspaceDir,
        runner: createExecRunner(),
      },
      runtimeRootDir: path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "codex"),
      hostApiToken: "host-token",
      hostApiUrl,
      timeoutSec: 30,
    });
    if (!bridge) throw new Error("Expected codex_remote bridge to start.");
    cleanupFns.push(bridge.stop);

    const deniedResponse = await fetch(`${bridge.env.PAPERCLIP_API_URL}/api/attachments/attachment-1`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${bridge.env.PAPERCLIP_API_KEY}`,
      },
    });
    expect(deniedResponse.status).toBe(403);
    await expect(deniedResponse.json()).resolves.toEqual({
      error: "Route not allowed: DELETE /api/attachments/attachment-1",
    });
  });
});
