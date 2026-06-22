// Strip env keys that are not valid POSIX shell identifiers before sending env
// into a remote sandbox.
//
// Windows hosts expose variables like `ProgramFiles(x86)` and
// `CommonProgramFiles(x86)` whose names contain characters that are illegal in
// a Linux sandbox shell. The Cloudflare sandbox bridge rejects the *entire*
// exec with "Invalid sandbox environment variable key" if any reach it, so we
// drop them here — they are meaningless inside the Linux container anyway.
// (Previously handled by the cloudflare-bridge plugin's host-side
// sanitizeExecuteEnv; moved into the adapter so the stock provider works.)
const POSIX_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isPosixEnvKey(key: string): boolean {
  return POSIX_ENV_KEY_RE.test(key);
}

/** Removes non-POSIX env keys from `env` in place. */
export function stripNonPosixSandboxEnvKeys(env: Record<string, unknown>): void {
  for (const key of Object.keys(env)) {
    if (!isPosixEnvKey(key)) {
      delete env[key];
    }
  }
}
