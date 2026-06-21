const SILENCED_SUCCESS_METHODS = new Set(["GET", "HEAD"]);

// The `/api` prefix is optional: depending on where the http logger observes
// the request (app root vs. the mounted `/api` sub-router / dev proxy), the
// logged URL may or may not carry the prefix. Matching both keeps the high
// frequency UI polling endpoints silenced in every mount configuration.
const SILENCED_SUCCESS_API_PATHS = [
  /^(?:\/api)?\/health(?:\/|$)/,
  /^(?:\/api)?\/companies\/[^/]+\/activity(?:\/|$)/,
  /^(?:\/api)?\/companies\/[^/]+\/dashboard(?:\/|$)/,
  /^(?:\/api)?\/companies\/[^/]+\/heartbeat-runs(?:\/|$)/,
  /^(?:\/api)?\/companies\/[^/]+\/issues(?:\/|$)/,
  /^(?:\/api)?\/companies\/[^/]+\/live-runs(?:\/|$)/,
  /^(?:\/api)?\/companies\/[^/]+\/sidebar-badges(?:\/|$)/,
  /^(?:\/api)?\/companies\/[^/]+\/skills(?:\/|$)/,
  /^(?:\/api)?\/heartbeat-runs\/[^/]+\/log(?:\/|$)/,
  // Per-issue and per-run live polling fired every 1-3s by the active board UI.
  /^(?:\/api)?\/issues\/[^/]+\/live-runs(?:\/|$)/,
  /^(?:\/api)?\/issues\/[^/]+\/active-run(?:\/|$)/,
];

const SILENCED_SUCCESS_STATIC_PREFIXES = [
  "/@fs/",
  "/@id/",
  "/@react-refresh",
  "/@vite/",
  "/_plugins/",
  "/assets/",
  "/node_modules/",
  "/src/",
];

const SILENCED_SUCCESS_STATIC_PATHS = new Set([
  "/",
  "/index.html",
  "/favicon.ico",
  "/site.webmanifest",
  "/sw.js",
]);

function normalizePath(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) return "/";
  const pathname = trimmed.split("?")[0]?.trim() ?? "/";
  return pathname.length > 0 ? pathname : "/";
}

export function shouldSilenceHttpSuccessLog(method: string | undefined, url: string | undefined, statusCode: number): boolean {
  if (statusCode >= 400) return false;
  if (statusCode === 304) return true;
  if (!method || !url) return false;
  if (!SILENCED_SUCCESS_METHODS.has(method.toUpperCase())) return false;

  const pathname = normalizePath(url);
  if (SILENCED_SUCCESS_STATIC_PATHS.has(pathname)) return true;
  if (SILENCED_SUCCESS_STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  return SILENCED_SUCCESS_API_PATHS.some((pattern) => pattern.test(pathname));
}
