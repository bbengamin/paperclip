import fs from "node:fs";
import path from "node:path";

export interface PaperclipMcpConfig {
  apiUrl: string;
  apiKey: string;
  companyId: string | null;
  agentId: string | null;
  runId: string | null;
}

export interface ConfigDiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDir?: string;
  readFile?: (filePath: string) => string | null;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function normalizeApiUrl(apiUrl: string): string {
  const trimmed = stripTrailingSlash(apiUrl.trim());
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

function normalizeApiBase(apiBase: string): string {
  return stripTrailingSlash(apiBase.trim());
}

function resolveHomeDir(options: Pick<ConfigDiscoveryOptions, "env" | "homeDir">): string {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? env.HOME ?? env.USERPROFILE;
  if (!home?.trim()) {
    throw new Error("Cannot resolve Paperclip CLI context because no home directory is available");
  }
  return home;
}

function resolveContextPath(options: Pick<ConfigDiscoveryOptions, "env" | "cwd" | "homeDir" | "readFile">): string {
  const env = options.env ?? process.env;
  if (nonEmpty(env.PAPERCLIP_CONTEXT)) {
    return path.resolve(nonEmpty(env.PAPERCLIP_CONTEXT) as string);
  }

  const readFile = options.readFile ?? readFileIfExists;
  let currentDir = path.resolve(options.cwd ?? process.cwd());
  while (currentDir) {
    const candidate = path.join(currentDir, ".paperclip", "context.json");
    if (readFile(candidate) !== null) {
      return candidate;
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  return path.join(resolveHomeDir(options), ".paperclip", "context.json");
}

function resolveAuthStorePath(options: Pick<ConfigDiscoveryOptions, "env" | "homeDir">): string {
  const env = options.env ?? process.env;
  const override = nonEmpty(env.PAPERCLIP_AUTH_STORE);
  return override ? path.resolve(override) : path.join(resolveHomeDir(options), ".paperclip", "auth.json");
}

function readFileIfExists(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function parseJsonFile(filePath: string, readFile: (filePath: string) => string | null): unknown | null {
  const raw = readFile(filePath);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Failed to parse Paperclip config file at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readCliContext(options: Required<Pick<ConfigDiscoveryOptions, "readFile">> & Pick<ConfigDiscoveryOptions, "env" | "cwd" | "homeDir">) {
  const contextPath = resolveContextPath(options);
  const raw = parseJsonFile(contextPath, options.readFile);
  if (raw === null) return { contextPath, profileName: "default", profile: {} as Record<string, unknown> };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { contextPath, profileName: "default", profile: {} as Record<string, unknown> };
  }

  const context = raw as Record<string, unknown>;
  const profileName = stringField(context, "currentProfile") ?? "default";
  const profiles = context.profiles;
  if (typeof profiles !== "object" || profiles === null || Array.isArray(profiles)) {
    return { contextPath, profileName, profile: {} as Record<string, unknown> };
  }

  const profile = (profiles as Record<string, unknown>)[profileName];
  return {
    contextPath,
    profileName,
    profile: typeof profile === "object" && profile !== null && !Array.isArray(profile)
      ? profile as Record<string, unknown>
      : {} as Record<string, unknown>,
  };
}

function readBoardCredential(
  apiBase: string,
  options: Required<Pick<ConfigDiscoveryOptions, "readFile">> & Pick<ConfigDiscoveryOptions, "env" | "homeDir">,
): { token: string | null; authStorePath: string } {
  const authStorePath = resolveAuthStorePath(options);
  const raw = parseJsonFile(authStorePath, options.readFile);
  if (raw === null || typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { token: null, authStorePath };
  }

  const credentials = (raw as Record<string, unknown>).credentials;
  if (typeof credentials !== "object" || credentials === null || Array.isArray(credentials)) {
    return { token: null, authStorePath };
  }

  const normalizedApiBase = normalizeApiBase(apiBase);
  const credential = (credentials as Record<string, unknown>)[normalizedApiBase];
  if (typeof credential !== "object" || credential === null || Array.isArray(credential)) {
    return { token: null, authStorePath };
  }

  return {
    token: stringField(credential as Record<string, unknown>, "token"),
    authStorePath,
  };
}

export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PaperclipMcpConfig {
  return readConfig({ env });
}

export function readConfig(options: ConfigDiscoveryOptions = {}): PaperclipMcpConfig {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? readFileIfExists;
  const apiUrl = nonEmpty(env.PAPERCLIP_API_URL);
  const apiKey = nonEmpty(env.PAPERCLIP_API_KEY);
  const cliContext = !apiUrl || !apiKey || !nonEmpty(env.PAPERCLIP_COMPANY_ID)
    ? readCliContext({ ...options, readFile })
    : null;
  const contextApiBase = cliContext ? stringField(cliContext.profile, "apiBase") : null;
  const contextCompanyId = cliContext ? stringField(cliContext.profile, "companyId") : null;
  const resolvedApiBase = apiUrl ?? contextApiBase;
  const resolvedCompanyId = nonEmpty(env.PAPERCLIP_COMPANY_ID) ?? contextCompanyId;

  if (!resolvedApiBase) {
    const contextPath = cliContext?.contextPath ?? resolveContextPath({ ...options, readFile });
    throw new Error(
      `Missing PAPERCLIP_API_URL and no active Paperclip CLI apiBase was found in ${contextPath}. Run paperclipai context set --api-base <url> --use or set PAPERCLIP_API_URL.`,
    );
  }

  const boardCredential = apiKey ? null : readBoardCredential(resolvedApiBase, { ...options, readFile });
  const resolvedApiKey = apiKey ?? boardCredential?.token ?? null;
  if (!resolvedApiKey) {
    throw new Error(
      `Missing PAPERCLIP_API_KEY and no board credential was found for ${normalizeApiBase(resolvedApiBase)} in ${boardCredential?.authStorePath ?? resolveAuthStorePath(options)}. Run paperclipai auth login --api-base ${normalizeApiBase(resolvedApiBase)} or set PAPERCLIP_API_KEY.`,
    );
  }
  if (!resolvedCompanyId) {
    const contextPath = cliContext?.contextPath ?? resolveContextPath({ ...options, readFile });
    throw new Error(
      `Missing PAPERCLIP_COMPANY_ID and no active Paperclip CLI companyId was found in ${contextPath}. Run paperclipai context set --company-id <company-id> --use or set PAPERCLIP_COMPANY_ID.`,
    );
  }

  return {
    apiUrl: normalizeApiUrl(resolvedApiBase),
    apiKey: resolvedApiKey,
    companyId: resolvedCompanyId,
    agentId: nonEmpty(env.PAPERCLIP_AGENT_ID),
    runId: nonEmpty(env.PAPERCLIP_RUN_ID),
  };
}
