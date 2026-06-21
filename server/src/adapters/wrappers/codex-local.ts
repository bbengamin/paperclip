import path from "node:path";
import type {
  AdapterExecutionContext,
  PaperclipRuntimeStateStrategyResult,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import {
  patchPaperclipRuntimeExecutionContext,
  resolvePaperclipRuntimeStateStrategy,
} from "@paperclipai/adapter-utils";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Reads an adapter env value as a string, unwrapping the `{ type: "plain",
// value }` binding form. Returns null for secret refs / non-string values.
function envValueString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    if (rec.type === "plain" && typeof rec.value === "string") return rec.value;
  }
  return null;
}

// Mirrors server/src/routes/agents.ts `codexLocalAgentHome` so we can recognize
// (and only that) the auto-isolated CODEX_HOME the upstream isolation guard
// injects on save.
function codexLocalGuardAutoHome(companyId: string, agentId: string): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: process.env.PAPERCLIP_HOME?.trim() || undefined,
    instanceId: process.env.PAPERCLIP_INSTANCE_ID?.trim() || undefined,
    env: process.env,
  });
  return path.resolve(instanceRoot, "companies", companyId, "agents", agentId, "codex-home");
}

/**
 * Undo the effects of upstream's `applyCodexLocalIsolationGuard`
 * (server/src/routes/agents.ts) at run/test time, in our wrapper layer only, so
 * the upstream package stays untouched and pulls remain clean.
 *
 * That guard, on every codex_local save, (1) seeds an empty `OPENAI_API_KEY` and
 * (2) forces a per-agent isolated `CODEX_HOME` when none is configured. But the
 * isolated home is never seeded with auth, so a new agent ends up with no Codex
 * credentials and the run cannot start. We strip the empty key and the
 * auto-injected home (only when it exactly matches the guard's path) so codex_local
 * falls back to the managed company home seeded from the shared/host Codex login —
 * the pre-update behavior our working agents rely on. User-set `CODEX_HOME` and a
 * real `OPENAI_API_KEY` are left untouched.
 */
export function neutralizeCodexLocalIsolationGuard<
  T extends { config?: unknown; agent?: { id?: unknown; companyId?: unknown } | null },
>(ctx: T): T {
  const config = asRecord((ctx as { config?: unknown }).config);
  const envRaw = config.env;
  if (!envRaw || typeof envRaw !== "object" || Array.isArray(envRaw)) return ctx;
  const env = { ...(envRaw as Record<string, unknown>) };
  let changed = false;

  if (
    Object.prototype.hasOwnProperty.call(env, "OPENAI_API_KEY") &&
    envValueString(env.OPENAI_API_KEY) === ""
  ) {
    delete env.OPENAI_API_KEY;
    changed = true;
  }

  const codexHome = envValueString(env.CODEX_HOME);
  const companyId = readString(ctx.agent?.companyId);
  const agentId = readString(ctx.agent?.id);
  if (codexHome && companyId && agentId) {
    try {
      if (path.resolve(codexHome) === codexLocalGuardAutoHome(companyId, agentId)) {
        delete env.CODEX_HOME;
        changed = true;
      }
    } catch {
      // Path resolution failure → leave CODEX_HOME as-is.
    }
  }

  if (!changed) return ctx;
  return { ...ctx, config: { ...config, env } };
}

export function resolveCodexPaperclipRuntimeState(input: {
  target?: AdapterExecutionTarget | null;
  config?: Record<string, unknown> | null;
}): PaperclipRuntimeStateStrategyResult {
  const config = input.config ?? {};
  const env = asRecord(config.env);
  return resolvePaperclipRuntimeStateStrategy({
    target: input.target,
    configuredPath: readString(env.CODEX_HOME),
    forceManaged: config.paperclipManagedCodexHome === true,
    injectsCredentials: readString(env.OPENAI_API_KEY) != null,
    sandboxManagedByDefault: true,
    preserveSshNativeByDefault: true,
  });
}

export function patchCodexLocalExecutionContext(ctx: AdapterExecutionContext): AdapterExecutionContext {
  // Strip the upstream isolation guard's empty key + unseeded isolated home
  // BEFORE resolving runtime state, so codex_local resolves to the managed
  // (host-login-seeded) home.
  const sanitized = neutralizeCodexLocalIsolationGuard(ctx);
  return patchPaperclipRuntimeExecutionContext(sanitized, {
    runtimeState: resolveCodexPaperclipRuntimeState({
      target: sanitized.executionTarget,
      config: sanitized.config,
    }),
  });
}

export function createWrappedCodexLocalAdapter(base: ServerAdapterModule): ServerAdapterModule {
  return {
    ...base,
    type: "codex_local",
    execute: (ctx) => base.execute(patchCodexLocalExecutionContext(ctx)),
    testEnvironment: (ctx) => base.testEnvironment(neutralizeCodexLocalIsolationGuard({
      ...ctx,
      adapterType: "codex_local",
    })),
  };
}
