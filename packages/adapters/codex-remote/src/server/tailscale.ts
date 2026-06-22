import {
  runAdapterExecutionTargetShellCommand,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";

// Adapter-driven Tailscale bring-up.
//
// Ported from the Cloudflare bridge Worker's `ensureTailscale` +
// `withTailscaleProxyEnv` so the sandbox provider/Worker can stay stock. The
// sandbox image ships `tailscale` + the `tailscale-up` helper; the Tailscale
// auth key arrives through the environment's env vars (Paperclip
// `envVars` → adapter `config.env`); and codex_remote brings the tailnet up
// itself before running Codex, then routes Codex's traffic through the
// userspace proxy.

const TAILSCALE_SOCKS_PROXY = "socks5://127.0.0.1:1055";
const TAILSCALE_HTTP_PROXY = "http://127.0.0.1:1056";

const TAILSCALE_PROXY_ENV: Record<string, string> = {
  ALL_PROXY: TAILSCALE_SOCKS_PROXY,
  all_proxy: TAILSCALE_SOCKS_PROXY,
  HTTP_PROXY: TAILSCALE_HTTP_PROXY,
  http_proxy: TAILSCALE_HTTP_PROXY,
  HTTPS_PROXY: TAILSCALE_HTTP_PROXY,
  https_proxy: TAILSCALE_HTTP_PROXY,
};

// Keep localhost direct so the Paperclip callback bridge (127.0.0.1) is never
// routed through the tailnet proxy.
const NO_PROXY_LOCAL = ["127.0.0.1", "localhost", "::1"];

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function readTailscaleAuthKey(envConfig: Record<string, unknown>): string | null {
  return nonEmpty(envConfig.TAILSCALE_AUTHKEY);
}

function mergeNoProxy(existing: string | undefined): string {
  const values = new Set(
    (existing ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  for (const value of NO_PROXY_LOCAL) values.add(value);
  return Array.from(values).join(",");
}

/**
 * Mutates `env` in place to route outbound traffic through the sandbox's
 * userspace-Tailscale proxy, leaving localhost direct. Mirrors the bridge
 * Worker's `withTailscaleProxyEnv`.
 */
export function applyTailscaleProxyEnv(env: Record<string, string>): void {
  Object.assign(env, TAILSCALE_PROXY_ENV);
  const noProxy = mergeNoProxy(env.NO_PROXY ?? env.no_proxy);
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;
}

/**
 * Brings up Tailscale inside a remote sandbox by running the image's
 * `tailscale-up` helper with the auth key from the environment's env vars.
 * No-op unless the target is a sandbox and `TAILSCALE_AUTHKEY` is set. Throws
 * on failure so a misconfigured tailnet stops the run before Codex tries (and
 * fails) to reach the model provider.
 */
export async function ensureSandboxTailscaleUp(input: {
  runId: string;
  target: AdapterExecutionTarget | null;
  envConfig: Record<string, unknown>;
  cwd: string;
  timeoutSec: number;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}): Promise<boolean> {
  const target = input.target;
  if (!target || target.kind !== "remote" || target.transport !== "sandbox") return false;
  const authKey = readTailscaleAuthKey(input.envConfig);
  if (!authKey) return false;

  const env: Record<string, string> = { TAILSCALE_AUTHKEY: authKey };
  const hostname = nonEmpty(input.envConfig.TAILSCALE_HOSTNAME);
  if (hostname) env.TAILSCALE_HOSTNAME = hostname;
  const extraArgs = nonEmpty(input.envConfig.TAILSCALE_EXTRA_ARGS);
  if (extraArgs) env.TAILSCALE_EXTRA_ARGS = extraArgs;

  const script = [
    "set -eu",
    "if ! command -v tailscale-up >/dev/null 2>&1; then",
    '  echo "tailscale-up helper not found in sandbox image" >&2',
    "  exit 127",
    "fi",
    "tailscale-up",
  ].join("\n");

  const result = await runAdapterExecutionTargetShellCommand(input.runId, target, script, {
    cwd: input.cwd,
    env,
    timeoutSec: Math.min(Math.max(input.timeoutSec, 1), 60),
    graceSec: 5,
    onLog: input.onLog,
  });

  if (result.timedOut) {
    throw new Error("Timed out bringing up Tailscale in the sandbox before starting Codex.");
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
    throw new Error(`Failed to bring up Tailscale in the sandbox${detail ? `: ${detail}` : "."}`);
  }
  return true;
}
