import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  authorizeSandboxCallbackBridgeRequestWithRoutes,
  createCommandManagedSandboxCallbackBridgeQueueClient,
  createSandboxCallbackBridgeToken,
  DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES,
  DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST,
  startSandboxCallbackBridgeServer,
  startSandboxCallbackBridgeWorker,
  type SandboxCallbackBridgeAsset,
  type SandboxCallbackBridgeRouteRule,
} from "@paperclipai/adapter-utils/sandbox-callback-bridge";
import type {
  AdapterExecutionTarget,
  AdapterExecutionTargetPaperclipBridgeHandle,
} from "@paperclipai/adapter-utils/execution-target";

const CODEX_REMOTE_SANDBOX_CALLBACK_BRIDGE_ENTRYPOINT = "paperclip-bridge-server.mjs";

const CODEX_REMOTE_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST: readonly SandboxCallbackBridgeRouteRule[] = [
  ...DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST,
  { method: "POST", path: /^\/api\/companies\/[^/]+\/issues\/[^/]+\/attachments$/ },
  { method: "POST", path: /^\/api\/issues\/[^/]+\/work-products$/ },
] as const;

type CodexRemoteBridgeRequestBodyEncoding = "utf8" | "base64";

type CodexRemoteBridgeRequestWithEncoding = {
  body: string;
  bodyEncoding?: CodexRemoteBridgeRequestBodyEncoding;
};

function resolveHostForUrl(rawHost: string): string {
  const host = rawHost.trim();
  if (!host || host === "0.0.0.0" || host === "::") return "localhost";
  if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) return `[${host}]`;
  return host;
}

function resolveDefaultPaperclipApiUrl(): string {
  const runtimeHost = resolveHostForUrl(
    process.env.PAPERCLIP_HOST?.trim() ||
      process.env.HOST?.trim() ||
      "127.0.0.1",
  );
  const runtimePort = process.env.PAPERCLIP_PORT?.trim() || process.env.PORT?.trim() || "3100";
  return `http://${runtimeHost}:${runtimePort}`;
}

function buildBridgeResponseHeaders(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["content-type", "etag", "last-modified"]) {
    const value = response.headers.get(key);
    if (value && value.trim().length > 0) out[key] = value.trim();
  }
  return out;
}

function buildBridgeForwardUrl(baseUrl: string, request: { path: string; query: string }): URL {
  const url = new URL(request.path, baseUrl);
  const query = request.query.trim();
  url.search = query.startsWith("?") ? query.slice(1) : query;
  return url;
}

function bridgeResponseBodyLimitError(maxBodyBytes: number): Error {
  return new Error(`Bridge response body exceeded the configured size limit of ${maxBodyBytes} bytes.`);
}

async function readBridgeForwardResponseBody(response: Response, maxBodyBytes: number): Promise<string> {
  const rawContentLength = response.headers.get("content-length");
  if (rawContentLength) {
    const contentLength = Number.parseInt(rawContentLength, 10);
    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
      throw bridgeResponseBodyLimitError(maxBodyBytes);
    }
  }

  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > maxBodyBytes) {
      await reader.cancel().catch(() => undefined);
      throw bridgeResponseBodyLimitError(maxBodyBytes);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function normalizeBridgeShellCommand(target: AdapterExecutionTarget): "bash" | "sh" | null {
  if (target.kind !== "remote" || target.transport !== "sandbox") return null;
  return target.shellCommand === "bash" || target.shellCommand === "sh" ? target.shellCommand : null;
}

function resolveBridgeTimeoutMs(input: {
  target: AdapterExecutionTarget;
  timeoutSec?: number | null;
}): number {
  if (typeof input.timeoutSec === "number" && Number.isFinite(input.timeoutSec) && input.timeoutSec > 0) {
    return Math.trunc(input.timeoutSec * 1000);
  }
  if (
    input.target.kind === "remote" &&
    input.target.transport === "sandbox" &&
    typeof input.target.timeoutMs === "number" &&
    Number.isFinite(input.target.timeoutMs) &&
    input.target.timeoutMs > 0
  ) {
    return Math.trunc(input.target.timeoutMs);
  }
  return 30_000;
}

async function createCodexRemoteSandboxCallbackBridgeAsset(): Promise<SandboxCallbackBridgeAsset> {
  const localDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-bridge-asset-"));
  const entrypoint = path.join(localDir, CODEX_REMOTE_SANDBOX_CALLBACK_BRIDGE_ENTRYPOINT);
  await fs.writeFile(entrypoint, getCodexRemoteSandboxCallbackBridgeServerSource(), "utf8");
  return {
    localDir,
    entrypoint,
    cleanup: async () => {
      await fs.rm(localDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export async function startCodexRemotePaperclipBridge(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  runtimeRootDir: string | null | undefined;
  timeoutSec?: number | null;
  hostApiToken: string | null | undefined;
  hostApiUrl?: string | null;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  maxBodyBytes?: number | null;
}): Promise<AdapterExecutionTargetPaperclipBridgeHandle | null> {
  if (!input.target || input.target.kind !== "remote" || input.target.transport !== "sandbox") {
    return null;
  }
  const target = input.target;
  if (!target.runner) {
    throw new Error("codex_remote sandbox bridge mode requires a sandbox runner.");
  }

  const hostApiToken = input.hostApiToken?.trim() ?? "";
  if (hostApiToken.length === 0) {
    throw new Error("codex_remote sandbox bridge mode requires a host-side Paperclip API token.");
  }

  const onLog = input.onLog ?? (async () => {});
  const runtimeRootDir =
    input.runtimeRootDir?.trim().length
      ? input.runtimeRootDir.trim()
      : path.posix.join(target.remoteCwd, ".paperclip-runtime", "codex");
  const bridgeRuntimeDir = path.posix.join(runtimeRootDir, "paperclip-bridge");
  const queueDir = path.posix.join(bridgeRuntimeDir, "queue");
  const assetRemoteDir = path.posix.join(bridgeRuntimeDir, "server");
  const bridgeToken = createSandboxCallbackBridgeToken();
  const maxBodyBytes =
    typeof input.maxBodyBytes === "number" && Number.isFinite(input.maxBodyBytes) && input.maxBodyBytes > 0
      ? Math.trunc(input.maxBodyBytes)
      : DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES;
  const hostApiUrl =
    input.hostApiUrl?.trim() ||
    process.env.PAPERCLIP_RUNTIME_API_URL?.trim() ||
    process.env.PAPERCLIP_API_URL?.trim() ||
    resolveDefaultPaperclipApiUrl();
  const shellCommand = normalizeBridgeShellCommand(target);
  const bridgeTimeoutMs = resolveBridgeTimeoutMs({ target, timeoutSec: input.timeoutSec });

  await onLog("stdout", `[paperclip] Starting codex_remote sandbox callback bridge in ${bridgeRuntimeDir}.\n`);

  const bridgeAsset = await createCodexRemoteSandboxCallbackBridgeAsset();
  let server: Awaited<ReturnType<typeof startSandboxCallbackBridgeServer>> | null = null;
  let worker: Awaited<ReturnType<typeof startSandboxCallbackBridgeWorker>> | null = null;
  try {
    const client = createCommandManagedSandboxCallbackBridgeQueueClient({
      runner: target.runner,
      remoteCwd: target.remoteCwd,
      timeoutMs: bridgeTimeoutMs,
      shellCommand,
    });
    const bridgeDebugEnabled = process.env.PAPERCLIP_BRIDGE_DEBUG === "1" ||
      process.env.PAPERCLIP_BRIDGE_DEBUG?.toLowerCase() === "true";
    worker = await startSandboxCallbackBridgeWorker({
      client,
      queueDir,
      maxBodyBytes,
      authorizeRequest: async (request) =>
        authorizeSandboxCallbackBridgeRequestWithRoutes(
          request,
          CODEX_REMOTE_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST,
        ),
      handleRequest: async (request) => {
        const method = request.method.trim().toUpperCase() || "GET";
        if (bridgeDebugEnabled) {
          await onLog(
            "stdout",
            `[paperclip] codex_remote bridge proxy ${method} ${request.path}${request.query ? `?${request.query}` : ""}\n`,
          );
        }
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) {
          if (value.trim().length === 0) continue;
          headers.set(key, value);
        }
        headers.set("authorization", `Bearer ${hostApiToken}`);
        headers.set("x-paperclip-run-id", input.runId);
        const requestWithEncoding = request as typeof request & CodexRemoteBridgeRequestWithEncoding;
        const requestBody =
          requestWithEncoding.bodyEncoding === "base64"
            ? Buffer.from(requestWithEncoding.body, "base64")
            : requestWithEncoding.body;
        const response = await fetch(buildBridgeForwardUrl(hostApiUrl, request), {
          method,
          headers,
          ...(method === "GET" || method === "HEAD" ? {} : { body: requestBody }),
          signal: AbortSignal.timeout(30_000),
        });
        if (bridgeDebugEnabled) {
          await onLog(
            "stdout",
            `[paperclip] codex_remote bridge proxy response ${response.status} for ${method} ${request.path}${request.query ? `?${request.query}` : ""}\n`,
          );
        }
        return {
          status: response.status,
          headers: buildBridgeResponseHeaders(response),
          body: await readBridgeForwardResponseBody(response, maxBodyBytes),
        };
      },
    });
    server = await startSandboxCallbackBridgeServer({
      runner: target.runner,
      remoteCwd: target.remoteCwd,
      assetRemoteDir,
      queueDir,
      bridgeToken,
      bridgeAsset,
      timeoutMs: bridgeTimeoutMs,
      maxBodyBytes,
      shellCommand,
    });
  } catch (error) {
    await Promise.allSettled([
      server?.stop(),
      worker?.stop(),
      bridgeAsset.cleanup(),
    ]);
    throw error;
  }

  return {
    env: {
      PAPERCLIP_API_URL: server.baseUrl,
      PAPERCLIP_API_KEY: bridgeToken,
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
    },
    stop: async () => {
      await Promise.allSettled([server?.stop()]);
      await Promise.allSettled([worker?.stop(), bridgeAsset.cleanup()]);
    },
  };
}

function getCodexRemoteSandboxCallbackBridgeServerSource(): string {
  return `import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";

const queueDir = process.env.PAPERCLIP_BRIDGE_QUEUE_DIR;
const bridgeToken = process.env.PAPERCLIP_BRIDGE_TOKEN;
const host = process.env.PAPERCLIP_BRIDGE_HOST || "127.0.0.1";
const port = Number(process.env.PAPERCLIP_BRIDGE_PORT || "0");
const pollIntervalMs = Number(process.env.PAPERCLIP_BRIDGE_POLL_INTERVAL_MS || "100");
const responseTimeoutMs = Number(process.env.PAPERCLIP_BRIDGE_RESPONSE_TIMEOUT_MS || "30000");
const maxQueueDepth = Number(process.env.PAPERCLIP_BRIDGE_MAX_QUEUE_DEPTH || "64");
const maxBodyBytes = Number(process.env.PAPERCLIP_BRIDGE_MAX_BODY_BYTES || "262144");
const allowedHeaders = new Set(["accept","content-type","if-match","if-none-match"]);

if (!queueDir || !bridgeToken) {
  throw new Error("PAPERCLIP_BRIDGE_QUEUE_DIR and PAPERCLIP_BRIDGE_TOKEN are required.");
}

const requestsDir = path.posix.join(queueDir, "requests");
const responsesDir = path.posix.join(queueDir, "responses");
const logsDir = path.posix.join(queueDir, "logs");
const readyFile = path.posix.join(queueDir, "ready.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    const normalizedKey = key.toLowerCase();
    if (!allowedHeaders.has(normalizedKey)) continue;
    out[normalizedKey] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

async function readBody(req) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(nextChunk);
    totalBytes += nextChunk.byteLength;
    if (totalBytes > maxBodyBytes) {
      throw new Error("Bridge request body exceeded the configured size limit.");
    }
  }
  return Buffer.concat(chunks);
}

async function queueDepth() {
  const entries = await fs.readdir(requestsDir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).length;
}

function tokensMatch(received) {
  const expected = Buffer.from(bridgeToken, "utf8");
  const actual = Buffer.from(typeof received === "string" ? received : "", "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

async function waitForResponse(requestId) {
  const responsePath = path.posix.join(responsesDir, \`\${requestId}.json\`);
  const deadline = Date.now() + responseTimeoutMs;
  while (Date.now() < deadline) {
    const body = await fs.readFile(responsePath, "utf8").catch(() => null);
    if (body != null) {
      await fs.rm(responsePath, { force: true }).catch(() => undefined);
      return JSON.parse(body);
    }
    await sleep(pollIntervalMs);
  }
  throw new Error("Timed out waiting for host bridge response.");
}

const server = createServer(async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const receivedToken = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    if (!tokensMatch(receivedToken)) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Invalid bridge token." }));
      return;
    }

    if (await queueDepth() >= maxQueueDepth) {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Bridge request queue is full." }));
      return;
    }

    const url = new URL(req.url || "/", "http://127.0.0.1");
    const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "";
    const isJsonBody = /json/i.test(contentType);
    const isMultipartBody = /^multipart\\/form-data(?:;|$)/i.test(contentType);
    if (req.method && req.method !== "GET" && req.method !== "HEAD" && !isJsonBody && !isMultipartBody) {
      res.statusCode = 415;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Bridge only accepts JSON or multipart request bodies." }));
      return;
    }

    const requestId = randomUUID();
    const requestBody = await readBody(req);
    const payload = {
      id: requestId,
      method: req.method || "GET",
      path: url.pathname,
      query: url.search,
      headers: normalizeHeaders(req.headers),
      body: isMultipartBody ? requestBody.toString("base64") : requestBody.toString("utf8"),
      bodyEncoding: isMultipartBody ? "base64" : "utf8",
      createdAt: new Date().toISOString(),
    };
    const requestPath = path.posix.join(requestsDir, \`\${requestId}.json\`);
    const tempPath = \`\${requestPath}.tmp\`;
    await fs.writeFile(tempPath, \`\${JSON.stringify(payload)}\\n\`, "utf8");
    await fs.rename(tempPath, requestPath);

    const response = await waitForResponse(requestId);
    res.statusCode = typeof response.status === "number" ? response.status : 200;
    for (const [key, value] of Object.entries(response.headers || {})) {
      if (typeof value !== "string" || key.toLowerCase() === "content-length") continue;
      res.setHeader(key, value);
    }
    res.end(typeof response.body === "string" ? response.body : "");
  } catch (error) {
    res.statusCode = 502;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

async function shutdown() {
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await fs.mkdir(requestsDir, { recursive: true });
await fs.mkdir(responsesDir, { recursive: true });
await fs.mkdir(logsDir, { recursive: true });

server.listen(port, host, async () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Bridge server did not expose a TCP address.");
  }
  const ready = {
    pid: process.pid,
    host,
    port: address.port,
    baseUrl: \`http://\${host}:\${address.port}\`,
    startedAt: new Date().toISOString(),
  };
  const tempReadyFile = \`\${readyFile}.tmp\`;
  await fs.writeFile(tempReadyFile, JSON.stringify(ready), "utf8");
  await fs.rename(tempReadyFile, readyFile);
});`;
}
