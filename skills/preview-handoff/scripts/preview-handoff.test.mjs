#!/usr/bin/env node
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSignedPreviewUrl,
  canonicalPreviewPayload,
  deriveSshPreviewBaseUrl,
  discoverCandidates,
  resolvePreviewConfig,
  runPreviewHandoff,
  signPreviewUrl,
  verifyCandidates,
} from "./paperclip-preview-handoff.mjs";

function response(status, contentType = "text/html") {
  return new Response("ok", { status, headers: { "content-type": contentType } });
}

test("discovers declared runtime primary URL before fallback ports", () => {
  const candidates = discoverCandidates({
    PAPERCLIP_RUNTIME_PRIMARY_URL: "http://127.0.0.1:5173/",
    PAPERCLIP_PREVIEW_ALLOWED_PORTS: "3000,5173",
  });
  assert.equal(candidates[0].source, "PAPERCLIP_RUNTIME_PRIMARY_URL");
  assert.equal(candidates[0].port, 5173);
  assert(candidates.some((candidate) => candidate.source === "common-port fallback" && candidate.port === 3000));
});

test("discovers runtime services JSON ports and URLs", () => {
  const candidates = discoverCandidates({
    PAPERCLIP_RUNTIME_SERVICES_JSON: JSON.stringify({ services: [{ name: "vite", port: 5173 }, { name: "api", url: "http://127.0.0.1:8000/health" }] }),
    PAPERCLIP_PREVIEW_ALLOWED_PORTS: "5173,8000",
  });
  assert(candidates.some((candidate) => candidate.source === "vite" && candidate.port === 5173));
  assert(candidates.some((candidate) => candidate.source === "api" && candidate.port === 8000));
});

test("does not allow custom ports outside the RL-1405 contract", () => {
  const candidates = discoverCandidates({
    PAPERCLIP_RUNTIME_PRIMARY_URL: "http://127.0.0.1:1234/",
    PAPERCLIP_PREVIEW_ALLOWED_PORTS: "1234,5173",
  });
  assert(!candidates.some((candidate) => candidate.port === 1234));
  assert(candidates.some((candidate) => candidate.source === "common-port fallback" && candidate.port === 5173));
});

test("verifies candidates and prefers frontend-looking responses", async () => {
  const verified = await verifyCandidates([
    { source: "api", url: "http://127.0.0.1:8000/", port: 8000 },
    { source: "vite", url: "http://127.0.0.1:5173/", port: 5173 },
  ], {
    fetchImpl: async (url) => String(url).includes("5173") ? response(200, "text/html") : response(200, "application/json"),
  });
  assert.equal(verified[0].source, "vite");
});

test("builds signed preview URL with RL-1405 canonical payload", () => {
  const signedUrl = buildSignedPreviewUrl(
    { source: "vite", url: "http://127.0.0.1:5173/", port: 5173 },
    {
      baseUrl: "http://tailnet-host:3999",
      target: "ssh-env-1",
      issue: "RL-1408",
      run: "run-1",
      secret: "secret",
      environmentType: "ssh",
      expirySeconds: 86400,
    },
    100,
  );
  const url = new URL(signedUrl);
  const exp = "86500";
  const expected = signPreviewUrl("secret", canonicalPreviewPayload({ target: "ssh-env-1", issue: "RL-1408", run: "run-1", port: 5173, exp }));
  assert.equal(url.pathname, "/preview/ssh-env-1/5173/");
  assert.equal(url.searchParams.get("pc_sig"), expected);
});

test("derives SSH preview base URL from tailnet domain and hostname", () => {
  const baseUrl = deriveSshPreviewBaseUrl({
    PAPERCLIP_PREVIEW_TAILNET_DOMAIN: "tail35f301.ts.net",
    PAPERCLIP_PREVIEW_HOSTNAME: "ssh-worker-1",
  });
  assert.equal(baseUrl, "http://ssh-worker-1.tail35f301.ts.net:3999");
});

test("derives SSH preview base URL from Tailscale DNS name without tailnet env", () => {
  const baseUrl = deriveSshPreviewBaseUrl({
    PAPERCLIP_PREVIEW_TEST_TAILSCALE_DNS_NAME: "ssh-worker-1.tail35f301.ts.net.",
  });
  assert.equal(baseUrl, "http://ssh-worker-1.tail35f301.ts.net:3999");
});

test("uses derived SSH preview base URL when explicit base URL is absent", () => {
  const config = resolvePreviewConfig({
    PAPERCLIP_PREVIEW_TAILNET_DOMAIN: "tail35f301.ts.net",
    PAPERCLIP_PREVIEW_HOSTNAME: "ssh-worker-1",
    PAPERCLIP_PREVIEW_TARGET_ID: "ssh-env-1",
    PAPERCLIP_TASK_ID: "RL-1408",
    PAPERCLIP_RUN_ID: "run-1",
    PAPERCLIP_PREVIEW_SIGNING_SECRET: "secret",
  });
  const signedUrl = buildSignedPreviewUrl(
    { source: "vite", url: "http://127.0.0.1:5173/", port: 5173 },
    config,
    100,
  );
  assert.equal(new URL(signedUrl).origin, "http://ssh-worker-1.tail35f301.ts.net:3999");
});

test("derives Cloudflare preview base URL from bridge root", () => {
  const config = resolvePreviewConfig({
    PAPERCLIP_CLOUDFLARE_BRIDGE_BASE_URL: "https://paperclip-cloudflare-sandbox-bridge.example.workers.dev/",
    PAPERCLIP_PREVIEW_TARGET_ID: "lease-1",
    PAPERCLIP_TASK_ID: "RL-1408",
    PAPERCLIP_RUN_ID: "run-1",
    PAPERCLIP_PREVIEW_SIGNING_SECRET: "secret",
    PAPERCLIP_PREVIEW_ENVIRONMENT_TYPE: "cloudflare",
  });
  const signedUrl = buildSignedPreviewUrl(
    { source: "vite", url: "http://127.0.0.1:5173/", port: 5173 },
    config,
    100,
  );
  assert.equal(
    new URL(signedUrl).pathname,
    "/api/paperclip-sandbox/v1/preview/lease-1/5173/",
  );
});

test("does not duplicate Cloudflare bridge API prefix", () => {
  const config = resolvePreviewConfig({
    PAPERCLIP_PREVIEW_BASE_URL: "https://paperclip-cloudflare-sandbox-bridge.example.workers.dev/api/paperclip-sandbox/v1",
    PAPERCLIP_PREVIEW_TARGET_ID: "lease-1",
    PAPERCLIP_TASK_ID: "RL-1408",
    PAPERCLIP_RUN_ID: "run-1",
    PAPERCLIP_PREVIEW_SIGNING_SECRET: "secret",
    PAPERCLIP_PREVIEW_ENVIRONMENT_TYPE: "cloudflare",
  });
  assert.equal(
    config.baseUrl,
    "https://paperclip-cloudflare-sandbox-bridge.example.workers.dev/api/paperclip-sandbox/v1",
  );
});

test("prints snippet when Paperclip API env is missing", async () => {
  const logs = [];
  const result = await runPreviewHandoff({
    env: {
      PAPERCLIP_RUNTIME_PRIMARY_URL: "http://127.0.0.1:5173/",
      PAPERCLIP_PREVIEW_ALLOWED_PORTS: "5173",
      PAPERCLIP_PREVIEW_BASE_URL: "http://tailnet-host:3999",
      PAPERCLIP_PREVIEW_TARGET_ID: "ssh-env-1",
      PAPERCLIP_TASK_ID: "RL-1408",
      PAPERCLIP_RUN_ID: "run-1",
      PAPERCLIP_PREVIEW_SIGNING_SECRET: "secret",
      PAPERCLIP_PREVIEW_ENVIRONMENT_TYPE: "ssh",
    },
    fetchImpl: async () => response(200, "text/html"),
    nowSeconds: 100,
    log: (line) => logs.push(line),
  });
  assert.equal(result.posted, false);
  assert.equal(result.reason, "printed");
  assert(logs.join("\n").includes("## Preview"));
});

test("handles missing signing config non-fatally", async () => {
  const result = await runPreviewHandoff({
    env: {
      PAPERCLIP_RUNTIME_PRIMARY_URL: "http://127.0.0.1:5173/",
      PAPERCLIP_PREVIEW_ALLOWED_PORTS: "5173",
      PAPERCLIP_TASK_ID: "RL-1408",
      PAPERCLIP_RUN_ID: "run-1",
    },
    fetchImpl: async () => response(200, "text/html"),
    log: () => {},
  });
  assert.equal(result.posted, false);
  assert.equal(result.reason, "missing_signing_config");
});

test("skips when no HTTP preview responds", async () => {
  const result = await runPreviewHandoff({
    env: {
      PAPERCLIP_PREVIEW_ALLOWED_PORTS: "5173",
      PAPERCLIP_PREVIEW_BASE_URL: "http://tailnet-host:3999",
      PAPERCLIP_PREVIEW_TARGET_ID: "ssh-env-1",
      PAPERCLIP_TASK_ID: "RL-1408",
      PAPERCLIP_RUN_ID: "run-1",
      PAPERCLIP_PREVIEW_SIGNING_SECRET: "secret",
    },
    fetchImpl: async () => {
      throw new Error("closed");
    },
    log: () => {},
  });
  assert.equal(result.posted, false);
  assert.equal(result.reason, "no_preview");
});
