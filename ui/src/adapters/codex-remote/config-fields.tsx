import type { AdapterConfigFieldsProps } from "../types";
import { Field, DraftInput } from "../../components/agent-config-primitives";
import { CodexLocalConfigFields } from "../codex-local/config-fields";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function CodexRemoteConfigFields(props: AdapterConfigFieldsProps) {
  const { isCreate, config, mark } = props;

  const remoteGit = (config.remoteGitSandbox ?? {}) as Record<string, unknown>;
  const repoUrl = String(remoteGit.repoUrl ?? "");

  return (
    <>
      {!isCreate && (
        <Field
          label="Repository URL"
          hint="Git repository URL with embedded PAT. Format: https://x-access-token:TOKEN@github.com/owner/repo.git"
        >
          <DraftInput
            value={repoUrl}
            onCommit={(v) =>
              mark("adapterConfig", "remoteGitSandbox", { ...remoteGit, repoUrl: v || undefined })
            }
            immediate
            className={inputClass}
            placeholder="https://x-access-token:TOKEN@github.com/owner/repo.git"
          />
        </Field>
      )}
      <CodexLocalConfigFields {...props} />
    </>
  );
}
