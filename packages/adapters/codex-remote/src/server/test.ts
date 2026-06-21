import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  parseObject,
  ensurePathInEnv,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  maybeRunSandboxInstallCommand,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  prepareAdapterExecutionTargetRuntime,
} from "@paperclipai/adapter-utils/execution-target";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseCodexJsonl } from "./parse.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";
import { codexHomeDir, readCodexAuthInfo } from "./quota.js";
import { buildCodexExecArgs } from "./codex-args.js";
import { prepareManagedCodexHome } from "./codex-home.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function commandLooksLike(command: string, expected: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const CODEX_AUTH_REQUIRED_RE =
  /(?:not\s+logged\s+in|login\s+required|authentication\s+required|authentication\s+token\s+has\s+been\s+invalidated|token_invalidated|unauthorized|invalid(?:\s+or\s+missing)?\s+api(?:[_\s-]?key)?|openai[_\s-]?api[_\s-]?key|api[_\s-]?key.*required|please\s+run\s+`?codex\s+login`?)/i;
// A cold Cloudflare sandbox needs ~60-90s for the first `codex exec`: the CLI
// cold-starts, performs a model-refresh that can itself time out, then runs the
// turn. The host RPC budget is this value + a 30s overhead buffer (see
// resolvePluginExecuteRpcTimeoutMs), capped at 15 min, so 150s leaves the RPC
// ~180s — enough to actually observe the probe result instead of the RPC
// timing out and surfacing an opaque 500.
const SANDBOX_HELLO_PROBE_TIMEOUT_SEC = 150;

function parseKeyValueLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([^=]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    out[match[1]!.trim()] = match[2]!.trim();
  }
  return out;
}

async function addRemoteCodexHomeDiagnostics(input: {
  checks: AdapterEnvironmentCheck[];
  runId: string;
  target: AdapterEnvironmentTestContext["executionTarget"] | null;
  cwd: string;
  env: Record<string, string>;
}): Promise<void> {
  const codexHome = input.env.CODEX_HOME?.trim();
  if (!codexHome || !input.target || input.target.kind !== "remote") return;

  const probe = await runAdapterExecutionTargetShellCommand(
    input.runId,
    input.target,
    [
      'printf "home=%s\\n" "$CODEX_HOME"',
      "for name in auth.json config.toml config.json instructions.md; do",
      '  file="$CODEX_HOME/$name"',
      '  if [ -f "$file" ]; then',
      '    bytes=$(wc -c < "$file" | tr -d "[:space:]")',
      '    printf "%s=%s\\n" "$name" "$bytes"',
      "  else",
      '    printf "%s=missing\\n" "$name"',
      "  fi",
      "done",
    ].join("\n"),
    {
      cwd: input.cwd,
      env: input.env,
      timeoutSec: 15,
      graceSec: 5,
      onLog: async () => {},
    },
  ).catch((error) => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    pid: null,
    startedAt: new Date().toISOString(),
  }));

  if (probe.timedOut) {
    input.checks.push({
      code: "codex_remote_home_diagnostic_timed_out",
      level: "warn",
      message: "Timed out checking remote Codex home.",
      hint: "The sandbox command runner is slow before Codex starts; retry the environment test.",
    });
    return;
  }

  if ((probe.exitCode ?? 1) !== 0) {
    input.checks.push({
      code: "codex_remote_home_diagnostic_failed",
      level: "warn",
      message: "Could not inspect remote Codex home.",
      detail: summarizeProbeDetail(probe.stdout, probe.stderr, null) ?? undefined,
    });
    return;
  }

  const facts = parseKeyValueLines(probe.stdout);
  const authBytes = facts["auth.json"];
  if (authBytes && authBytes !== "missing") {
    input.checks.push({
      code: "codex_remote_auth_present",
      level: "info",
      message: "Remote Codex auth file is present.",
      detail: `CODEX_HOME=${facts.home ?? codexHome}; auth.json=${authBytes} bytes`,
    });
  } else {
    input.checks.push({
      code: "codex_remote_auth_missing",
      level: "warn",
      message: "Remote Codex auth file is missing.",
      detail: `CODEX_HOME=${facts.home ?? codexHome}`,
      hint: "Run `codex login` on the Paperclip host, then retry. Paperclip should copy the managed Codex home into the sandbox.",
    });
  }

  const configFacts = ["config.toml", "config.json", "instructions.md"]
    .map((name) => `${name}=${facts[name] ?? "unknown"}`)
    .join("; ");
  input.checks.push({
    code: "codex_remote_home_files",
    level: "info",
    message: "Remote Codex home file check completed.",
    detail: configFacts,
  });
}

async function addRemoteCodexCliDiagnostics(input: {
  checks: AdapterEnvironmentCheck[];
  runId: string;
  target: AdapterEnvironmentTestContext["executionTarget"] | null;
  cwd: string;
  command: string;
  env: Record<string, string>;
}): Promise<{ authMode: string | null } | null> {
  const codexHome = input.env.CODEX_HOME?.trim();
  if (!codexHome || !input.target || input.target.kind !== "remote") return null;

  const probe = await runAdapterExecutionTargetShellCommand(
    input.runId,
    input.target,
    [
      `codex_path=$(command -v ${JSON.stringify(input.command)} 2>/dev/null || true)`,
      'printf "codex_path=%s\\n" "$codex_path"',
      `version=$(${JSON.stringify(input.command)} --version 2>&1 | head -n 1 || true)`,
      'printf "codex_version=%s\\n" "$version"',
      "node -e \"const fs=require('fs'); const p=process.env.CODEX_HOME + '/auth.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); console.log('auth_mode=' + (j.auth_mode || '')); console.log('auth_keys=' + Object.keys(j).sort().join(','));\" 2>/dev/null || printf \"auth_mode=unreadable\\nauth_keys=unreadable\\n\"",
      `help=$(${JSON.stringify(input.command)} exec --help 2>&1 | head -n 1 || true)`,
      'printf "exec_help=%s\\n" "$help"',
    ].join("\n"),
    {
      cwd: input.cwd,
      env: input.env,
      timeoutSec: 20,
      graceSec: 5,
      onLog: async () => {},
    },
  ).catch((error) => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    pid: null,
    startedAt: new Date().toISOString(),
  }));

  if (probe.timedOut) {
    input.checks.push({
      code: "codex_remote_cli_diagnostic_timed_out",
      level: "warn",
      message: "Timed out checking remote Codex CLI diagnostics.",
      hint: "The CLI may be hanging before the hello probe. Check `codex --version` manually inside the sandbox.",
    });
    return null;
  }

  if ((probe.exitCode ?? 1) !== 0) {
    input.checks.push({
      code: "codex_remote_cli_diagnostic_failed",
      level: "warn",
      message: "Could not inspect remote Codex CLI diagnostics.",
      detail: summarizeProbeDetail(probe.stdout, probe.stderr, null) ?? undefined,
    });
    return null;
  }

  const facts = parseKeyValueLines(probe.stdout);
  input.checks.push({
    code: "codex_remote_cli_version",
    level: "info",
    message: "Remote Codex CLI diagnostic completed.",
    detail: `path=${facts.codex_path ?? "unknown"}; version=${facts.codex_version ?? "unknown"}`,
  });
  input.checks.push({
    code: "codex_remote_auth_mode",
    level: "info",
    message: facts.auth_mode === "chatgpt"
      ? "Remote Codex auth is ChatGPT subscription mode."
      : "Remote Codex auth mode was detected.",
    detail: `auth_mode=${facts.auth_mode ?? "unknown"}; auth_keys=${facts.auth_keys ?? "unknown"}`,
    ...(facts.auth_mode === "chatgpt"
      ? {
          hint: "ChatGPT-mode Codex auth copied from another machine may require an interactive refresh inside the sandbox.",
        }
      : {}),
  });
  input.checks.push({
    code: "codex_remote_exec_help",
    level: facts.exec_help ? "info" : "warn",
    message: facts.exec_help ? "Remote `codex exec --help` returned." : "Remote `codex exec --help` returned no output.",
    ...(facts.exec_help ? { detail: facts.exec_help.slice(0, 240) } : {}),
  });
  return {
    authMode: facts.auth_mode ?? null,
  };
}

async function addRemoteCodexProviderDiagnostics(input: {
  checks: AdapterEnvironmentCheck[];
  runId: string;
  target: AdapterEnvironmentTestContext["executionTarget"] | null;
  cwd: string;
  env: Record<string, string>;
}): Promise<{
  baseUrl: string | null;
  tcp: string | null;
  http: string | null;
  requiresOpenaiAuth: boolean | null;
  hasBearerToken: boolean | null;
} | null> {
  const codexHome = input.env.CODEX_HOME?.trim();
  if (!codexHome || !input.target || input.target.kind !== "remote") return null;

  const probe = await runAdapterExecutionTargetShellCommand(
    input.runId,
    input.target,
    [
      "if command -v tailscale >/dev/null 2>&1; then",
      "  tailscale_ip=$(tailscale ip -4 2>/dev/null | head -n 1 || true)",
      "  tailscale_status=$(tailscale status 2>&1 | head -n 1 || true)",
      "  printf \"tailscale_ip=%s\\n\" \"$tailscale_ip\"",
      "  printf \"tailscale_status=%s\\n\" \"$tailscale_status\"",
      "else",
      "  printf \"tailscale_ip=missing_cli\\n\"",
      "  printf \"tailscale_status=missing_cli\\n\"",
      "fi",
      "node <<'NODE'",
      "const { spawnSync } = require('child_process');",
      "const fs = require('fs');",
      "const net = require('net');",
      "(async () => {",
      "const cfg = fs.readFileSync(`${process.env.CODEX_HOME}/config.toml`, 'utf8');",
      "const readTop = (key) => (cfg.match(new RegExp(`^${key}\\\\s*=\\\\s*\"([^\"]*)\"`, 'm')) || [])[1] || '';",
      "const provider = readTop('model_provider');",
      "const escapedProvider = provider.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');",
      "const section = provider ? (cfg.match(new RegExp(`\\\\[model_providers\\\\.${escapedProvider}\\\\]([\\\\s\\\\S]*?)(?:\\\\n\\\\[|$)`)) || [])[1] || '' : '';",
      "const readSection = (key) => (section.match(new RegExp(`^${key}\\\\s*=\\\\s*\"([^\"]*)\"`, 'm')) || [])[1] || '';",
      "const base = readSection('base_url');",
      "const wire = readSection('wire_api');",
      "const requiresOpenaiAuth = /^\\s*requires_openai_auth\\s*=\\s*true/m.test(section);",
      "const hasBearerToken = /^\\s*experimental_bearer_token\\s*=\\s*\"/m.test(section) || /^\\s*env_key\\s*=\\s*\"/m.test(section);",
      "console.log(`model_provider=${provider}`);",
      "console.log(`provider_base_url=${base}`);",
      "console.log(`provider_wire_api=${wire}`);",
      "console.log(`provider_requires_openai_auth=${requiresOpenaiAuth}`);",
      "console.log(`provider_has_bearer_token=${hasBearerToken}`);",
      "if (!base) { console.log('provider_tcp=skipped'); console.log('provider_http=skipped'); process.exit(0); }",
      "let url;",
      "try { url = new URL(base); } catch { console.log('provider_tcp=invalid_url'); console.log('provider_http=invalid_url'); process.exit(0); }",
      "const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));",
      "const tcp = await new Promise((resolve) => {",
      "  const socket = net.createConnection({ host: url.hostname, port, timeout: 5000 });",
      "  let done = false;",
      "  const finish = (value) => { if (done) return; done = true; socket.destroy(); resolve(value); };",
      "  socket.on('connect', () => finish('connect'));",
      "  socket.on('timeout', () => finish('timeout'));",
      "  socket.on('error', (error) => finish(`error:${error.code}`));",
      "});",
      "console.log(`provider_tcp=${tcp}`);",
      "const modelsUrl = new URL(base);",
      "modelsUrl.pathname = `${modelsUrl.pathname.replace(/\\/+$/, '')}/models`;",
      "const curl = spawnSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '8', modelsUrl.toString()], {",
      "  encoding: 'utf8',",
      "  env: process.env,",
      "});",
      "if (curl.error && curl.error.code === 'ENOENT') {",
      "  console.log('provider_http=missing_curl');",
      "} else if (curl.status === 0) {",
      "  console.log(`provider_http=status:${String(curl.stdout || '').trim() || '000'}`);",
      "} else {",
      "  const stderr = String(curl.stderr || '').replace(/\\s+/g, ' ').trim().slice(0, 120);",
      "  console.log(`provider_http=error:${curl.status}${stderr ? `:${stderr}` : ''}`);",
      "}",
      "})().catch((error) => {",
      "  console.log(`provider_diagnostic_error=${String(error && error.message ? error.message : error).replace(/\\s+/g, ' ').slice(0, 200)}`);",
      "  process.exitCode = 1;",
      "});",
      "NODE",
    ].join("\n"),
    {
      cwd: input.cwd,
      env: input.env,
      timeoutSec: 20,
      graceSec: 5,
      onLog: async () => {},
    },
  ).catch((error) => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    pid: null,
    startedAt: new Date().toISOString(),
  }));

  if (probe.timedOut) {
    input.checks.push({
      code: "codex_remote_provider_diagnostic_timed_out",
      level: "warn",
      message: "Timed out checking remote Codex model provider connectivity.",
    });
    return null;
  }

  if ((probe.exitCode ?? 1) !== 0) {
    input.checks.push({
      code: "codex_remote_provider_diagnostic_failed",
      level: "warn",
      message: "Could not inspect remote Codex model provider configuration.",
      detail: summarizeProbeDetail(probe.stdout, probe.stderr, null) ?? undefined,
    });
    return null;
  }

  const facts = parseKeyValueLines(probe.stdout);
  const tcp = facts.provider_tcp ?? "unknown";
  const http = facts.provider_http ?? "unknown";
  const httpReachable = /^status:(?!000)/.test(http);
  const providerReachable = tcp === "connect" || httpReachable;
  const tailscaleIp = facts.tailscale_ip ?? "unknown";
  const tailscaleStatus = facts.tailscale_status ?? "unknown";
  input.checks.push({
    code: "codex_remote_tailscale_status",
    level: tailscaleIp && tailscaleIp !== "missing_cli" ? "info" : "warn",
    message: tailscaleIp && tailscaleIp !== "missing_cli"
      ? "Remote sandbox Tailscale status was detected."
      : "Remote sandbox Tailscale status could not be detected.",
    detail: `tailscale_ip=${tailscaleIp}; status=${tailscaleStatus}`,
    ...(tailscaleIp && tailscaleIp !== "missing_cli"
      ? {}
      : {
          hint: "Install Tailscale in the sandbox image and set TAILSCALE_AUTHKEY on the Cloudflare Worker.",
        }),
  });
  input.checks.push({
    code: "codex_remote_model_provider",
    level: "info",
    message: "Remote Codex model provider configuration was detected.",
    detail: `model_provider=${facts.model_provider ?? "unknown"}; base_url=${facts.provider_base_url ?? "unknown"}; wire_api=${facts.provider_wire_api ?? "unknown"}; requires_openai_auth=${facts.provider_requires_openai_auth ?? "unknown"}; bearer_token=${facts.provider_has_bearer_token === "true" ? "present" : facts.provider_has_bearer_token === "false" ? "absent" : "unknown"}`,
  });
  input.checks.push({
    code: "codex_remote_model_provider_connectivity",
    level: providerReachable ? "info" : "warn",
    message: providerReachable
      ? "Remote sandbox can reach the configured Codex model provider."
      : "Remote sandbox could not confirm connectivity to the configured Codex model provider.",
    detail: `provider_tcp=${tcp}; provider_http=${http}`,
    ...(providerReachable
      ? {}
      : {
          hint: "If your provider base_url points at a local/Tailscale proxy, the remote sandbox must be able to reach that network address too.",
        }),
  });
  return {
    baseUrl: facts.provider_base_url ?? null,
    tcp,
    http,
    requiresOpenaiAuth:
      facts.provider_requires_openai_auth === "true"
        ? true
        : facts.provider_requires_openai_auth === "false"
          ? false
          : null,
    hasBearerToken:
      facts.provider_has_bearer_token === "true"
        ? true
        : facts.provider_has_bearer_token === "false"
          ? false
          : null,
  };
}

async function prepareCodexHelloProbe(input: {
  runId: string;
  companyId: string;
  target: AdapterEnvironmentTestContext["executionTarget"] | null;
  targetIsRemote: boolean;
  cwd: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  probeApiKey: string | null;
}): Promise<{
  command: string;
  args: string[];
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}> {
  let preparedRuntime: Awaited<ReturnType<typeof prepareAdapterExecutionTargetRuntime>> | null = null;
  let preparedRuntimeWorkspaceLocalDir: string | null = null;

  const cleanup = async () => {
    await preparedRuntime?.restoreWorkspace().catch(() => {});
    if (preparedRuntimeWorkspaceLocalDir) {
      await fs.rm(preparedRuntimeWorkspaceLocalDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  if (input.targetIsRemote && !input.probeApiKey) {
    const managedHome = await prepareManagedCodexHome(process.env, async () => {}, input.companyId, {
      apiKey: null,
    });
    preparedRuntimeWorkspaceLocalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `paperclip-codex-envtest-${input.runId}-`),
    );
    preparedRuntime = await prepareAdapterExecutionTargetRuntime({
      runId: input.runId,
      target: input.target,
      adapterKey: "codex",
      workspaceLocalDir: preparedRuntimeWorkspaceLocalDir,
      // Pass `input.cwd` as the base (not a pre-built per-run subdir).
      // `prepareRemoteManagedRuntime` itself appends
      // `.paperclip-runtime/runs/<runId>/workspace` to whatever it gets, so
      // pre-building a per-run path here would double-nest the run ID.
      workspaceRemoteDir: input.cwd,
      installCommand: SANDBOX_INSTALL_COMMAND,
      detectCommand: input.command,
      assets: [
        {
          key: "home",
          localDir: managedHome,
          followSymlinks: true,
        },
      ],
    });

    return {
      command: input.command,
      args: input.args,
      env: preparedRuntime.assetDirs.home
        ? { ...input.env, CODEX_HOME: preparedRuntime.assetDirs.home }
        : { ...input.env },
      cleanup,
    };
  }

  if (input.probeApiKey) {
    const probeHome = input.targetIsRemote
      ? path.posix.join(input.cwd, ".paperclip-runtime", "codex", `probe-home-${input.runId}`)
      : path.join(os.tmpdir(), `paperclip-codex-probe-${input.runId}`);
    return {
      command: "sh",
      args: [
        "-c",
        'set -e; mkdir -p "$CODEX_HOME"; umask 077; printf "%s" "$_PAPERCLIP_CODEX_AUTH_JSON" > "$CODEX_HOME/auth.json"; unset _PAPERCLIP_CODEX_AUTH_JSON; trap \'rm -rf "$CODEX_HOME"\' EXIT INT TERM; "$0" "$@"',
        input.command,
        ...input.args,
      ],
      env: {
        ...input.env,
        CODEX_HOME: probeHome,
        _PAPERCLIP_CODEX_AUTH_JSON: JSON.stringify({ OPENAI_API_KEY: input.probeApiKey }),
      },
      cleanup,
    };
  }

  return {
    command: input.command,
    args: input.args,
    env: { ...input.env },
    cleanup,
  };
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "codex");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const targetIsSandbox = target?.kind === "remote" && target.transport === "sandbox";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `codex-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "codex_environment_target",
      level: "info",
      message: `Probing inside environment: ${targetLabel}`,
    });
  }

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: true,
    });
    checks.push({
      code: "codex_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "codex_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  const installCheck = await maybeRunSandboxInstallCommand({
    runId,
    target,
    adapterKey: "codex",
    installCommand: SANDBOX_INSTALL_COMMAND,
    detectCommand: command,
    env,
  });
  if (installCheck) checks.push(installCheck);
  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    checks.push({
      code: "codex_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "codex_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const configOpenAiKey = env.OPENAI_API_KEY;
  const hostOpenAiKey = targetIsRemote ? undefined : process.env.OPENAI_API_KEY;
  if (isNonEmpty(configOpenAiKey) || isNonEmpty(hostOpenAiKey)) {
    const source = isNonEmpty(configOpenAiKey) ? "adapter config env" : "server environment";
    checks.push({
      code: "codex_openai_api_key_present",
      level: "info",
      message: "OPENAI_API_KEY is set for Codex authentication.",
      detail: `Detected in ${source}.`,
    });
  } else if (!targetIsRemote) {
    // Local-only auth file check. On remote targets, the probe will surface
    // any missing-auth errors directly from the remote `codex` invocation.
    const codexHome = isNonEmpty(env.CODEX_HOME) ? env.CODEX_HOME : undefined;
    const codexAuth = await readCodexAuthInfo(codexHome).catch(() => null);
    if (codexAuth) {
      checks.push({
        code: "codex_native_auth_present",
        level: "info",
        message: "Codex is authenticated via its own auth configuration.",
        detail: codexAuth.email ? `Logged in as ${codexAuth.email}.` : `Credentials found in ${path.join(codexHome ?? codexHomeDir(), "auth.json")}.`,
      });
    } else {
      checks.push({
        code: "codex_openai_api_key_missing",
        level: "warn",
        message: "OPENAI_API_KEY is not set. Codex runs may fail until authentication is configured.",
        hint: "Set OPENAI_API_KEY in adapter env, shell environment, or run `codex auth` to log in.",
      });
    }
  }

  const canRunProbe =
    checks.every((check) => check.code !== "codex_cwd_invalid" && check.code !== "codex_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, "codex")) {
      checks.push({
        code: "codex_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `codex`.",
        detail: command,
        hint: "Use the `codex` CLI command to run the automatic login and installation probe.",
      });
    } else {
      const execArgs = buildCodexExecArgs(
        { ...config, fastMode: false },
        { skipGitRepoCheck: targetIsSandbox },
      );
      const args = execArgs.args;
      if (execArgs.fastModeIgnoredReason) {
        checks.push({
          code: "codex_fast_mode_unsupported_model",
          level: "warn",
          message: execArgs.fastModeIgnoredReason,
          hint: "Switch the agent model to GPT-5.4 or enter a manual model ID to enable Codex Fast mode.",
        });
      }
      if (targetIsSandbox) {
        checks.push({
          code: "codex_git_repo_check_skipped",
          level: "info",
          message: "Added --skip-git-repo-check for sandbox hello probes.",
          hint: "Codex requires an explicit trust bypass in headless remote sandbox workspaces.",
        });
      }

      // Codex CLI (>= 0.122) ignores the OPENAI_API_KEY env var and only reads
      // credentials from $CODEX_HOME/auth.json. When we have a key available,
      // wrap the probe with a shell that materializes a per-run auth.json so
      // the CLI can authenticate. The key content is passed via env (not on
      // the command line) to avoid leaking it into process listings.
      const probeApiKey = isNonEmpty(configOpenAiKey)
        ? configOpenAiKey
        : isNonEmpty(hostOpenAiKey)
          ? hostOpenAiKey
          : null;
      const preparedProbe = await prepareCodexHelloProbe({
        runId,
        companyId: ctx.companyId,
        target,
        targetIsRemote,
        cwd,
        command,
        args,
        env,
        probeApiKey,
      });
      try {
        await addRemoteCodexHomeDiagnostics({
          checks,
          runId,
          target,
          cwd,
          env: preparedProbe.env,
        });
        const cliDiagnostics = await addRemoteCodexCliDiagnostics({
          checks,
          runId,
          target,
          cwd,
          command: preparedProbe.command,
          env: preparedProbe.env,
        });
        const providerConnectivity = await addRemoteCodexProviderDiagnostics({
          checks,
          runId,
          target,
          cwd,
          env: preparedProbe.env,
        });
        const providerBaseUrl = providerConnectivity?.baseUrl?.trim() ?? "";
        const providerTcp = providerConnectivity?.tcp?.trim() ?? "";
        const providerHttp = providerConnectivity?.http?.trim() ?? "";
        const providerReachable = providerTcp === "connect" || /^status:(?!000)/.test(providerHttp);
        // When the provider does not require OpenAI auth (e.g. a proxy like
        // cliproxyapi authenticated by its own bearer token), the copied
        // ChatGPT subscription token is irrelevant — Codex authenticates to the
        // provider with the configured bearer token. In that case we want to
        // actually run the hello probe to prove the end-to-end path, rather than
        // skipping it just because auth.json happens to be in ChatGPT mode.
        const providerRequiresOpenaiAuth = providerConnectivity?.requiresOpenaiAuth ?? true;
        if (
          targetIsSandbox
          && providerBaseUrl.length > 0
          && providerReachable
          && cliDiagnostics?.authMode === "chatgpt"
          && providerRequiresOpenaiAuth
          && !probeApiKey
        ) {
          checks.push({
            code: "codex_hello_probe_skipped_chatgpt_remote",
            level: "warn",
            message: "Skipped Codex hello probe for ChatGPT-mode auth in a remote sandbox.",
            detail: `base_url=${providerBaseUrl}; provider_tcp=${providerTcp || "unknown"}; provider_http=${providerHttp || "unknown"}`,
            hint: "The sandbox, Tailscale, Codex CLI, copied Codex home, and model provider are reachable. ChatGPT subscription tokens can require an interactive refresh, so the full conversation probe is left to an actual run instead of blocking this test.",
          });
          return {
            adapterType: ctx.adapterType,
            status: summarizeStatus(checks),
            checks,
            testedAt: new Date().toISOString(),
          };
        }
        if (targetIsSandbox && providerBaseUrl.length > 0 && !providerReachable) {
          checks.push({
            code: "codex_hello_probe_skipped_provider_unreachable",
            level: "warn",
            message: "Skipped Codex hello probe because the sandbox cannot reach the configured model provider.",
            detail: `base_url=${providerBaseUrl}; provider_tcp=${providerTcp || "unknown"}; provider_http=${providerHttp || "unknown"}`,
            hint: "Fix Tailscale/ACL/firewall access from the sandbox to the Codex model provider, then retry the adapter test.",
          });
          return {
            adapterType: ctx.adapterType,
            status: summarizeStatus(checks),
            checks,
            testedAt: new Date().toISOString(),
          };
        }
        checks.push({
          code: "codex_hello_probe_invocation",
          level: "info",
          message: "Running Codex hello probe.",
          detail: [preparedProbe.command, ...preparedProbe.args].join(" "),
          ...(targetIsSandbox
            ? {
                hint: `Remote sandbox hello probes are capped at ${SANDBOX_HELLO_PROBE_TIMEOUT_SEC}s so the environment test can return diagnostics instead of timing out.`,
              }
            : {}),
        });
        let probe: Awaited<ReturnType<typeof runAdapterExecutionTargetProcess>>;
        try {
          probe = await runAdapterExecutionTargetProcess(
            runId,
            target,
            preparedProbe.command,
            preparedProbe.args,
            {
              cwd,
              env: preparedProbe.env,
              timeoutSec: targetIsSandbox ? SANDBOX_HELLO_PROBE_TIMEOUT_SEC : 45,
              graceSec: 5,
              stdin: "Respond with hello.",
              onLog: async () => {},
            },
          );
        } catch (err) {
          // The probe transport (e.g. the plugin RPC) can fail or time out
          // independently of the Codex process — surface it as a warning rather
          // than letting it bubble up as an opaque 500 from the environment test.
          checks.push({
            code: "codex_hello_probe_transport_error",
            level: "warn",
            message: "Could not complete the Codex hello probe in the remote sandbox.",
            detail: (err instanceof Error ? err.message : String(err)).slice(0, 240),
            hint: targetIsSandbox
              ? "The cold sandbox can take 1-2 minutes for the first `codex exec`. The diagnostics above already confirm the sandbox, Tailscale, Codex CLI, copied config, and model provider; retry the test once the sandbox is warm, or start a real run to confirm."
              : "Retry the probe. If this persists, run `codex exec --json -` manually to debug.",
          });
          return {
            adapterType: ctx.adapterType,
            status: summarizeStatus(checks),
            checks,
            testedAt: new Date().toISOString(),
          };
        }
        const parsed = parseCodexJsonl(probe.stdout);
        const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
        const authEvidence = `${parsed.errorMessage ?? ""}\n${probe.stdout}\n${probe.stderr}`.trim();

        if (CODEX_AUTH_REQUIRED_RE.test(authEvidence)) {
          checks.push({
            code: "codex_hello_probe_auth_required",
            level: "warn",
            message: "Codex CLI is installed, but authentication is not ready.",
            ...(detail ? { detail } : {}),
            hint: probeApiKey
              ? "OPENAI_API_KEY was provided but Codex still rejected the request. Verify the key is valid for the OpenAI Responses API (e.g. `curl -H \"Authorization: Bearer $OPENAI_API_KEY\" https://api.openai.com/v1/models`), or run `codex login` and seed `~/.codex/auth.json`."
              : "Refresh Codex login on the Paperclip host, then retry. ChatGPT-mode Codex auth copied into a remote sandbox can stop working when the token is invalidated.",
          });
        } else if (probe.timedOut) {
          checks.push({
            code: "codex_hello_probe_timed_out",
            level: "warn",
            message: "Codex hello probe timed out.",
            ...(detail ? { detail } : {}),
            hint: targetIsSandbox
              ? "The sandbox reached the model provider, but Codex did not finish the hello probe quickly enough. If this follows a login refresh, retry once; otherwise run `codex login` on the Paperclip host and retry."
              : "Retry the probe. If this persists, verify Codex can run `Respond with hello` from this directory manually.",
          });
        } else if ((probe.exitCode ?? 1) === 0) {
          const summary = parsed.summary.trim();
          const hasHello = /\bhello\b/i.test(summary);
          checks.push({
            code: hasHello ? "codex_hello_probe_passed" : "codex_hello_probe_unexpected_output",
            level: hasHello ? "info" : "warn",
            message: hasHello
              ? "Codex hello probe succeeded."
              : "Codex probe ran but did not return `hello` as expected.",
            ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
            ...(hasHello
              ? {}
              : {
                  hint: "Try the probe manually (`codex exec --json -` then prompt: Respond with hello) to inspect full output.",
                }),
          });
        } else {
          checks.push({
            code: "codex_hello_probe_failed",
            level: "error",
            message: "Codex hello probe failed.",
            ...(detail ? { detail } : {}),
            hint: "Run `codex exec --json -` manually in this working directory and prompt `Respond with hello` to debug.",
          });
        }
      } finally {
        await preparedProbe.cleanup();
      }
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
