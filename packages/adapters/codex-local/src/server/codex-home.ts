import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";

const TRUTHY_ENV_RE = /^(1|true|yes|on)$/i;
const COPIED_SHARED_FILES = ["config.json", "config.toml", "instructions.md"] as const;
const SYMLINKED_SHARED_FILES = ["auth.json"] as const;

// Allowlist for the config.toml shipped into a remote sandbox. We send ONLY
// what Codex needs to run against the configured model provider, and nothing
// else — no `mcp_servers` (whose host binaries don't exist in the sandbox and
// stall Codex for each server's startup_timeout_sec), no project trust lists,
// plugins, marketplaces, desktop/Windows settings, etc.
//
// Kept top-level keys (everything else in the preamble is dropped):
const REMOTE_KEPT_TOP_LEVEL_KEYS = new Set([
  "model",
  "model_provider",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "model_supports_reasoning_summaries",
  "approval_policy",
  "preferred_auth_method",
  "check_for_update_on_startup",
  "web_search",
  "personality",
]);
// Kept sections: only the model provider definitions (e.g.
// `[model_providers.cliproxyapi]` and any sub-tables).
const REMOTE_KEPT_SECTION_ROOT = "model_providers";

/** Returns the dotted segments of a TOML table header, or null if not a header. */
function parseTomlSectionSegments(line: string): string[] | null {
  const match = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/.exec(line);
  if (!match) return null;
  return match[1]!.split(".").map((segment) => segment.trim().replace(/^['"]|['"]$/g, ""));
}

function parseTomlStringValue(line: string): string | null {
  const match = /^\s*[A-Za-z0-9_-]+\s*=\s*(['"])(.*?)\1\s*(?:#.*)?$/.exec(line);
  return match?.[2] ?? null;
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Reduces a Codex `config.toml` to the minimum needed inside a remote sandbox:
 * the allowlisted top-level keys ({@link REMOTE_KEPT_TOP_LEVEL_KEYS}) plus the
 * `[model_providers.*]` sections. Everything else — MCP servers, project trust
 * lists, plugins, marketplaces, desktop/Windows host settings — is dropped, so
 * Codex starts clean and fast and never tries to launch host-only tooling.
 *
 * Each provider also gets `supports_websockets = false` injected: Codex defaults
 * to a `wss://` transport for the Responses API, but a sandbox reaching the
 * provider through a userspace-Tailscale HTTP proxy cannot open that WebSocket,
 * so Codex burns ~75s retrying it before falling back to HTTP on every run (the
 * misleading "failed to refresh available models: timeout waiting for child
 * process to exit"). Forcing HTTP removes that stall.
 */
export function sanitizeRemoteCodexConfigToml(toml: string): string {
  const lines = toml.split(/\r?\n/);
  const preamble = new Map<string, string>();
  const sections: Array<{ header: string; segments: string[]; lines: string[] }> = [];
  const providerNames: string[] = [];
  let configuredProvider: string | null = null;
  let inPreamble = true;
  let currentSection: { header: string; segments: string[]; lines: string[] } | null = null;

  for (const line of lines) {
    const segments = parseTomlSectionSegments(line);
    if (segments) {
      inPreamble = false;
      currentSection = null;
      if (segments[0]?.toLowerCase() === REMOTE_KEPT_SECTION_ROOT) {
        currentSection = { header: line, segments, lines: [] };
        sections.push(currentSection);
        if (segments.length === 2 && segments[1]) {
          providerNames.push(segments[1]);
        }
      }
      continue;
    }
    if (inPreamble) {
      const key = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
      if (key && REMOTE_KEPT_TOP_LEVEL_KEYS.has(key[1]!.toLowerCase())) {
        const normalizedKey = key[1]!.toLowerCase();
        preamble.set(normalizedKey, line);
        if (normalizedKey === "model_provider") {
          configuredProvider = parseTomlStringValue(line);
        }
      }
      continue;
    }
    if (currentSection) {
      currentSection.lines.push(line);
    }
  }

  const activeProvider =
    configuredProvider && configuredProvider.toLowerCase() !== "openai" && providerNames.includes(configuredProvider)
      ? configuredProvider
      : providerNames.find((provider) => provider.toLowerCase() !== "openai") ?? configuredProvider ?? providerNames[0] ?? null;

  if (activeProvider) {
    preamble.set("model_provider", `model_provider = ${tomlString(activeProvider)}`);
  }
  preamble.set("preferred_auth_method", 'preferred_auth_method = "apikey"');
  preamble.set("check_for_update_on_startup", "check_for_update_on_startup = false");
  preamble.set("web_search", 'web_search = "disabled"');

  const out: string[] = [...preamble.values()];
  for (const section of sections) {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    out.push(section.header);
    const isProviderMainSection = section.segments.length === 2;
    for (const line of section.lines) {
      const key = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
      if (
        isProviderMainSection &&
        key &&
        ["requires_openai_auth", "supports_websockets"].includes(key[1]!.toLowerCase())
      ) {
        continue;
      }
      out.push(line);
    }
    if (isProviderMainSection) {
      out.push("requires_openai_auth = false");
      out.push("supports_websockets = false");
    }
  }
  if (out.length > 0 && out[out.length - 1] !== "") out.push("");
  out.push("[features]");
  out.push("browser_use = false");
  out.push("in_app_browser = false");
  out.push("computer_use = false");

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/**
 * Injects `supports_websockets = false` into every `[model_providers.<name>]`
 * section that does not already set the flag. Unlike
 * {@link sanitizeRemoteCodexConfigToml}, this preserves all other config
 * content — it is safe to apply to both local and remote config copies.
 */
export function injectWebsocketsDisabled(toml: string): string {
  const lines = toml.split(/\r?\n/);
  const out: string[] = [];
  let inProviderMainSection = false;
  let providerHasWebsocketsFlag = false;

  const closeProviderSection = () => {
    if (inProviderMainSection && !providerHasWebsocketsFlag) {
      out.push("supports_websockets = false");
    }
    inProviderMainSection = false;
    providerHasWebsocketsFlag = false;
  };

  for (const line of lines) {
    const segments = parseTomlSectionSegments(line);
    if (segments) {
      closeProviderSection();
      inProviderMainSection = segments[0]?.toLowerCase() === REMOTE_KEPT_SECTION_ROOT && segments.length === 2;
      out.push(line);
      continue;
    }
    if (inProviderMainSection) {
      const key = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
      if (key && key[1]!.toLowerCase() === "supports_websockets") {
        providerHasWebsocketsFlag = true;
      }
    }
    out.push(line);
  }
  closeProviderSection();
  return out.join("\n");
}

/**
 * Builds a throwaway Codex home directory suitable for syncing into a remote
 * sandbox: the same auth/instructions as the managed home, but with a
 * sandbox-sanitized `config.toml` (see {@link sanitizeRemoteCodexConfigToml}).
 * The caller must invoke `cleanup()` when the run finishes.
 */
export async function prepareRemoteCodexHomeAsset(
  sourceHome: string,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-home-"));
  const cleanup = async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  try {
    const configSource = path.join(sourceHome, "config.toml");
    if (await pathExists(configSource)) {
      const raw = await fs.readFile(configSource, "utf8");
      await fs.writeFile(path.join(dir, "config.toml"), sanitizeRemoteCodexConfigToml(raw), { mode: 0o600 });
    }
    // Do not copy auth.json into remote sandboxes. Remote runs should use the
    // sanitized config.toml provider credentials; copying ChatGPT-mode auth can
    // make Codex start account/plugin background transports that are irrelevant
    // in a sandbox and can stall startup.
    for (const name of ["config.json", "instructions.md"]) {
      const src = path.join(sourceHome, name);
      if (await pathExists(src)) {
        await fs.copyFile(src, path.join(dir, name));
      }
    }
    return { dir, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

export function resolveSharedCodexHomeDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = nonEmpty(env.CODEX_HOME);
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".codex");
}

function isWorktreeMode(env: NodeJS.ProcessEnv): boolean {
  return TRUTHY_ENV_RE.test(env.PAPERCLIP_IN_WORKTREE ?? "");
}

export function resolveManagedCodexHomeDir(
  env: NodeJS.ProcessEnv,
  companyId?: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return companyId
    ? path.resolve(instanceRoot, "companies", companyId, "codex-home")
    : path.resolve(instanceRoot, "codex-home");
}

async function ensureParentDir(target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
}

async function isExpectedSymlink(target: string, source: string): Promise<boolean> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing?.isSymbolicLink()) return false;

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return false;

  return path.resolve(path.dirname(target), linkedPath) === path.resolve(source);
}

async function createExpectedSymlink(target: string, source: string): Promise<void> {
  try {
    await fs.symlink(source, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" && await isExpectedSymlink(target, source)) return;
    throw error;
  }
}

function isSymlinkPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES";
}

async function ensureSymlinkOrCopy(target: string, source: string): Promise<"symlink" | "copy"> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await ensureParentDir(target);
    try {
      await createExpectedSymlink(target, source);
      return "symlink";
    } catch (error) {
      if (!isSymlinkPermissionError(error)) throw error;
      await fs.copyFile(source, target);
      return "copy";
    }
  }

  if (!existing.isSymbolicLink()) {
    return "copy";
  }

  if (await isExpectedSymlink(target, source)) return "symlink";

  await fs.unlink(target);
  try {
    await createExpectedSymlink(target, source);
    return "symlink";
  } catch (error) {
    if (!isSymlinkPermissionError(error)) throw error;
    await fs.copyFile(source, target);
    return "copy";
  }
}

async function filesHaveSameContent(target: string, source: string): Promise<boolean> {
  const [targetBuf, sourceBuf] = await Promise.all([
    fs.readFile(target).catch(() => null),
    fs.readFile(source).catch(() => null),
  ]);
  if (!targetBuf || !sourceBuf) return false;
  return targetBuf.equals(sourceBuf);
}

/**
 * Copies a shared Codex config file (e.g. `config.toml`) into the managed home,
 * refreshing it whenever the source content changes. The managed copy is purely
 * a mirror of the shared file — nothing else writes to it — so keeping it in
 * sync prevents a stale config (e.g. an outdated provider `base_url`, bearer
 * token, or `requires_openai_auth` flag) from being shipped into the sandbox
 * after the host config is edited.
 */
async function ensureCopiedFile(target: string, source: string): Promise<boolean> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing && !existing.isSymbolicLink() && (await filesHaveSameContent(target, source))) {
    return false;
  }
  await ensureParentDir(target);
  await fs.rm(target, { force: true });
  await fs.copyFile(source, target);
  return true;
}

/**
 * Writes an `auth.json` containing only `OPENAI_API_KEY` so the codex CLI can
 * authenticate via API key. Overwrites any existing file or symlink at that
 * path. Required because the codex CLI (>= 0.122) ignores the `OPENAI_API_KEY`
 * environment variable and only reads credentials from `$CODEX_HOME/auth.json`.
 */
export async function writeApiKeyAuthJson(home: string, apiKey: string): Promise<void> {
  await fs.mkdir(home, { recursive: true });
  const target = path.join(home, "auth.json");
  await fs.rm(target, { force: true });
  await fs.writeFile(target, JSON.stringify({ OPENAI_API_KEY: apiKey }), { mode: 0o600 });
}

export async function prepareManagedCodexHome(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
  options: { apiKey?: string | null } = {},
): Promise<string> {
  const targetHome = resolveManagedCodexHomeDir(env, companyId);
  const apiKey = nonEmpty(options.apiKey ?? undefined);

  const sourceHome = resolveSharedCodexHomeDir(env);
  const seedFromShared = path.resolve(sourceHome) !== path.resolve(targetHome);

  await fs.mkdir(targetHome, { recursive: true });

  // If a previous run wrote an apikey-mode auth.json (regular file) and this
  // run has no apiKey, remove it so the chatgpt-mode symlink can be restored.
  // Without this cleanup, ensureSymlink bails on a non-symlink and Codex keeps
  // authenticating with the stale key after it is removed from configuration.
  if (!apiKey && seedFromShared) {
    const authPath = path.join(targetHome, "auth.json");
    const existing = await fs.lstat(authPath).catch(() => null);
    if (existing && !existing.isSymbolicLink()) {
      await fs.rm(authPath, { force: true });
    }
  }

  if (seedFromShared) {
    let copiedSharedAuth = false;
    for (const name of SYMLINKED_SHARED_FILES) {
      const source = path.join(sourceHome, name);
      if (!(await pathExists(source))) continue;
      const mode = await ensureSymlinkOrCopy(path.join(targetHome, name), source);
      copiedSharedAuth ||= mode === "copy";
    }

    const refreshedConfigFiles: string[] = [];
    for (const name of COPIED_SHARED_FILES) {
      const source = path.join(sourceHome, name);
      if (!(await pathExists(source))) continue;
      if (await ensureCopiedFile(path.join(targetHome, name), source)) {
        refreshedConfigFiles.push(name);
      }
    }

    // Ensure Codex uses HTTP transport for model providers — avoids the ~75s
    // WebSocket retry on every run when the provider doesn't support wss://.
    const managedConfigToml = path.join(targetHome, "config.toml");
    if (await pathExists(managedConfigToml)) {
      const raw = await fs.readFile(managedConfigToml, "utf8");
      const patched = injectWebsocketsDisabled(raw);
      if (patched !== raw) {
        await fs.writeFile(managedConfigToml, patched, { mode: 0o600 });
      }
    }

    await onLog(
      "stdout",
      `[paperclip] Using ${isWorktreeMode(env) ? "worktree-isolated" : "Paperclip-managed"} Codex home "${targetHome}" (seeded from "${sourceHome}"${copiedSharedAuth ? "; copied auth.json because symlinks are unavailable" : ""}${refreshedConfigFiles.length > 0 ? `; refreshed ${refreshedConfigFiles.join(", ")} from shared config` : ""}).\n`,
    );
  }

  if (apiKey) {
    await writeApiKeyAuthJson(targetHome, apiKey);
    await onLog(
      "stdout",
      `[paperclip] Wrote API-key auth.json into Codex home "${targetHome}" from configured OPENAI_API_KEY.\n`,
    );
  }

  return targetHome;
}
