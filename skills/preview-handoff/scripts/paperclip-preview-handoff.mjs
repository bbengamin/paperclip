#!/usr/bin/env node
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";

export const DEFAULT_PORTS = Object.freeze([3000, 3001, 4000, 4200, 5000, 5173, 5174, 8000, 8080, 9000]);
const FRONTEND_PORT_SCORE = new Map([[5173, 40], [5174, 35], [3000, 30], [3001, 25], [4200, 20], [8080, 10]]);
const DEFAULT_SSH_GATEWAY_PORT = 3999;
const CLOUDFLARE_BRIDGE_API_PREFIX = "/api/paperclip-sandbox/v1";

function base64Url(input) {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function canonicalPreviewPayload({ target, issue, run, port, exp }) {
  return [
    "paperclip-preview-v1",
    `target=${target}`,
    `issue=${issue}`,
    `run=${run}`,
    `port=${port}`,
    `exp=${exp}`,
  ].join("\n");
}

export function signPreviewUrl(secret, payload) {
  return base64Url(crypto.createHmac("sha256", secret).update(payload).digest());
}

export function parseAllowedPorts(value) {
  if (!value || !value.trim()) return [...DEFAULT_PORTS];
  const ports = value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((port) => DEFAULT_PORTS.includes(port));
  return ports.length > 0 ? [...new Set(ports)] : [...DEFAULT_PORTS];
}

function maybeUrl(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function candidateFromUrl(url, source) {
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port)) return null;
  return { source, url: url.toString(), port };
}

function collectServiceCandidates(value, out = []) {
  if (!value) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectServiceCandidates(item, out);
    return out;
  }
  if (typeof value !== "object") return out;

  const record = value;
  const source = String(record.name ?? record.label ?? record.id ?? "runtime service");
  for (const key of ["url", "primaryUrl", "previewUrl", "publicUrl", "localUrl"]) {
    const url = maybeUrl(record[key]);
    if (url) {
      const candidate = candidateFromUrl(url, source);
      if (candidate) out.push(candidate);
    }
  }

  const port = Number(record.port ?? record.targetPort ?? record.localPort);
  if (Number.isInteger(port) && port > 0 && port <= 65535) {
    out.push({ source, url: `http://127.0.0.1:${port}/`, port });
  }

  for (const key of ["services", "items", "runtimeServices"]) collectServiceCandidates(record[key], out);
  return out;
}

export function discoverCandidates(env = process.env) {
  const allowedPorts = parseAllowedPorts(env.PAPERCLIP_PREVIEW_ALLOWED_PORTS);
  const candidates = [];
  const primaryUrl = maybeUrl(env.PAPERCLIP_RUNTIME_PRIMARY_URL);
  if (primaryUrl) {
    const candidate = candidateFromUrl(primaryUrl, "PAPERCLIP_RUNTIME_PRIMARY_URL");
    if (candidate) candidates.push(candidate);
  }

  if (env.PAPERCLIP_RUNTIME_SERVICES_JSON) {
    try {
      candidates.push(...collectServiceCandidates(JSON.parse(env.PAPERCLIP_RUNTIME_SERVICES_JSON)));
    } catch {
      candidates.push({ source: "PAPERCLIP_RUNTIME_SERVICES_JSON parse error", error: "invalid_json" });
    }
  }

  for (const port of allowedPorts) {
    candidates.push({ source: "common-port fallback", url: `http://127.0.0.1:${port}/`, port });
  }

  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!candidate.port || !allowedPorts.includes(candidate.port)) return false;
    const key = `${candidate.url ?? ""}:${candidate.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreCandidate(candidate, response) {
  const contentType = response.headers.get("content-type") ?? "";
  let score = FRONTEND_PORT_SCORE.get(candidate.port) ?? 0;
  if (contentType.includes("text/html")) score += 100;
  if (contentType.includes("application/json")) score -= 20;
  if (candidate.source === "PAPERCLIP_RUNTIME_PRIMARY_URL") score += 50;
  if (candidate.source !== "common-port fallback") score += 10;
  return score;
}

export async function verifyCandidates(candidates, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2500;
  const verified = [];

  for (const candidate of candidates) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(candidate.url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
      if (response && response.status >= 200 && response.status < 500) {
        verified.push({
          ...candidate,
          status: response.status,
          contentType: response.headers.get("content-type") ?? "",
          score: scoreCandidate(candidate, response),
          verifiedAt: new Date().toISOString(),
        });
      }
    } catch {
      // Non-HTTP, closed, or slow services are ignored; no-preview is non-fatal.
    } finally {
      clearTimeout(timeout);
    }
  }

  verified.sort((a, b) => b.score - a.score);
  return verified;
}

function normalizeTailnetDomain(value) {
  return String(value || "").trim().replace(/^\.+|\.+$/g, "").toLowerCase();
}

function hostnameFromTailscaleStatus(env = process.env) {
  const testDnsName = String(env.PAPERCLIP_PREVIEW_TEST_TAILSCALE_DNS_NAME || "").trim();
  if (testDnsName) return testDnsName.replace(/\.+$/g, "").toLowerCase();

  try {
    const output = execFileSync("tailscale", ["status", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    });
    const dnsName = JSON.parse(output)?.Self?.DNSName;
    if (typeof dnsName === "string" && dnsName.trim()) {
      return dnsName.trim().replace(/\.+$/g, "").toLowerCase();
    }
  } catch {
    // Tailscale is optional; fall back to OS hostname when unavailable.
  }
  return "";
}

export function deriveSshPreviewBaseUrl(env = process.env) {
  const tailnetDomain = normalizeTailnetDomain(
    env.PAPERCLIP_PREVIEW_TAILNET_DOMAIN ||
    env.PAPERCLIP_TAILSCALE_DOMAIN ||
    env.TAILSCALE_DOMAIN,
  );

  const gatewayPort = Number(env.PAPERCLIP_PREVIEW_GATEWAY_PORT || DEFAULT_SSH_GATEWAY_PORT);
  const safeGatewayPort = Number.isInteger(gatewayPort) && gatewayPort > 0 && gatewayPort <= 65535
    ? gatewayPort
    : DEFAULT_SSH_GATEWAY_PORT;
  const tailscaleDnsName = hostnameFromTailscaleStatus(env);
  if (!tailnetDomain && tailscaleDnsName) {
    return `http://${tailscaleDnsName}:${safeGatewayPort}`;
  }
  if (!tailnetDomain) return "";

  const explicitHostname = String(env.PAPERCLIP_PREVIEW_HOSTNAME || "").trim().replace(/\.+$/g, "").toLowerCase();
  const host = explicitHostname
    ? `${explicitHostname.split(".")[0]}.${tailnetDomain}`
    : tailscaleDnsName.endsWith(`.${tailnetDomain}`)
    ? tailscaleDnsName
    : `${os.hostname().split(".")[0].toLowerCase()}.${tailnetDomain}`;
  return `http://${host}:${safeGatewayPort}`;
}

function appendCloudflareBridgeApiPrefix(value) {
  if (!value) return "";
  const url = new URL(value);
  const pathname = url.pathname.replace(/\/+$/g, "");
  url.pathname = pathname.endsWith(CLOUDFLARE_BRIDGE_API_PREFIX)
    ? pathname
    : `${pathname}${CLOUDFLARE_BRIDGE_API_PREFIX}`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/g, "");
}

export function resolvePreviewBaseUrl(env = process.env, environmentType = "remote") {
  const explicitBaseUrl = env.PAPERCLIP_PREVIEW_BASE_URL || env.PAPERCLIP_RUNTIME_PREVIEW_BASE_URL || "";
  if (explicitBaseUrl) {
    return environmentType === "cloudflare"
      ? appendCloudflareBridgeApiPrefix(explicitBaseUrl)
      : explicitBaseUrl;
  }

  const cloudflareBridgeBaseUrl =
    env.PAPERCLIP_CLOUDFLARE_BRIDGE_BASE_URL ||
    env.PAPERCLIP_SANDBOX_BRIDGE_BASE_URL ||
    env.PAPERCLIP_BRIDGE_BASE_URL ||
    "";
  if (cloudflareBridgeBaseUrl) return appendCloudflareBridgeApiPrefix(cloudflareBridgeBaseUrl);

  return deriveSshPreviewBaseUrl(env);
}

export function resolvePreviewConfig(env = process.env) {
  const environmentType = env.PAPERCLIP_PREVIEW_ENVIRONMENT_TYPE || env.PAPERCLIP_REMOTE_ENVIRONMENT_TYPE || "remote";
  return {
    baseUrl: resolvePreviewBaseUrl(env, environmentType),
    target:
      env.PAPERCLIP_PREVIEW_TARGET_ID ||
      env.PAPERCLIP_PREVIEW_ENVIRONMENT_ID ||
      env.PAPERCLIP_ENVIRONMENT_ID ||
      env.PAPERCLIP_PROVIDER_LEASE_ID ||
      env.PAPERCLIP_REMOTE_PROVIDER_LEASE_ID ||
      env.PAPERCLIP_CLOUDFLARE_PROVIDER_LEASE_ID ||
      "",
    issue: env.PAPERCLIP_TASK_ID || "",
    run: env.PAPERCLIP_RUN_ID || env.PAPERCLIP_CHECKOUT_RUN_ID || "",
    secret: env.PAPERCLIP_PREVIEW_SIGNING_SECRET || "",
    environmentType,
    expirySeconds: Number(env.PAPERCLIP_PREVIEW_EXPIRES_IN_SECONDS || (env.PAPERCLIP_PREVIEW_ENVIRONMENT_TYPE === "cloudflare" ? 600 : 86400)),
  };
}

export function buildSignedPreviewUrl(candidate, config, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!config.baseUrl || !config.target || !config.issue || !config.run || !config.secret) return null;
  const exp = String(nowSeconds + config.expirySeconds);
  const payload = canonicalPreviewPayload({
    target: config.target,
    issue: config.issue,
    run: config.run,
    port: candidate.port,
    exp,
  });
  const signature = signPreviewUrl(config.secret, payload);
  const base = new URL(config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`);
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/preview/${encodeURIComponent(config.target)}/${candidate.port}/`;
  base.searchParams.set("pc_issue", config.issue);
  base.searchParams.set("pc_run", config.run);
  base.searchParams.set("pc_exp", exp);
  base.searchParams.set("pc_sig", signature);
  return base.toString();
}

export function formatPreviewComment(primary, secondary, config, signedUrl) {
  const lifecycleNote = config.environmentType === "cloudflare"
    ? "Cloudflare preview links can stop working when the sandbox sleeps or is destroyed."
    : "SSH preview links require access to the private/Tailscale environment and remain signed per preview.";
  const secondaryLines = secondary.length > 0
    ? `\n\nSecondary detections:\n${secondary.map((candidate) => `- ${candidate.source}: port ${candidate.port}, HTTP ${candidate.status}, ${candidate.contentType || "unknown content type"}`).join("\n")}`
    : "";

  return `## Preview

[Open preview](${signedUrl})

- Source: ${primary.source}
- Port: ${primary.port}
- Environment: ${config.environmentType}
- Verified: ${primary.verifiedAt}
- Lifecycle: ${lifecycleNote}${secondaryLines}`;
}

async function postPreviewComment(body, env = process.env, fetchImpl = fetch) {
  if (!env.PAPERCLIP_API_URL || !env.PAPERCLIP_API_KEY || !env.PAPERCLIP_TASK_ID) return false;
  const response = await fetchImpl(`${env.PAPERCLIP_API_URL.replace(/\/+$/, "")}/api/issues/${env.PAPERCLIP_TASK_ID}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.PAPERCLIP_API_KEY}`,
      "Content-Type": "application/json",
      ...(env.PAPERCLIP_RUN_ID ? { "X-Paperclip-Run-Id": env.PAPERCLIP_RUN_ID } : {}),
    },
    body: JSON.stringify({ body }),
  });
  if (!response.ok) throw new Error(`Paperclip preview comment failed: ${response.status} ${await response.text()}`);
  return true;
}

export async function runPreviewHandoff(options = {}) {
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;
  const config = resolvePreviewConfig(env);
  const candidates = discoverCandidates(env);
  const verified = await verifyCandidates(candidates, { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs });

  if (verified.length === 0) {
    log("No verified HTTP preview found; skipping preview comment.");
    return { posted: false, reason: "no_preview" };
  }

  const primary = verified[0];
  const signedUrl = buildSignedPreviewUrl(primary, config, options.nowSeconds);
  if (!signedUrl) {
    log("Verified preview found, but signed preview URL config is incomplete; skipping preview comment.");
    return { posted: false, reason: "missing_signing_config", primary };
  }

  const body = formatPreviewComment(primary, verified.slice(1, 4), config, signedUrl);
  const posted = await postPreviewComment(body, env, options.fetchImpl ?? fetch);
  log(body);
  if (!posted) log("\nPaperclip API env missing; printed preview snippet instead of posting a comment.");
  return { posted, reason: posted ? "posted" : "printed", body, primary };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPreviewHandoff().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
