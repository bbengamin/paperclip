# Paperclip Wrapper Adapters

Paperclip wrapper adapters are explicit adapter choices for runtime behavior that belongs to this Paperclip deployment, not to the generic upstream adapter.

They are additive. Native adapters stay available and existing agents are not bulk-migrated.

## Available wrappers

| Wrapper type | Native type | Use when |
| --- | --- | --- |
| `hermes_paperclip_local` | `hermes_local` | Hermes needs Paperclip API auth guidance, run-scoped env injection, and compatibility mapping for older Hermes config shapes. |
| `codex_paperclip_local` | `codex_local` | Codex should use Paperclip runtime policy while preserving native Codex auth/config on SSH targets by default. |
| `opencode_paperclip_local` | `opencode_local` | OpenCode should use Paperclip runtime policy while preserving native OpenCode config/auth on SSH targets by default. |

## Native vs wrapper selection

Choose the native adapter when you want the generic local runtime behavior with the smallest Paperclip opinion layer.

Choose the Paperclip wrapper when the agent is expected to operate as part of the Paperclip control plane:

- use the run-scoped Paperclip API token from the process environment
- follow Paperclip API write/auth guidance
- preserve native SSH runtime auth/config unless managed state is explicitly required
- use managed runtime state for sandbox execution

The wrapper should stay thin. Generic runtime fixes should move into the native adapter or shared adapter utilities.

## Migration order

Do not bulk-rewrite live agents.

1. Create or update a test agent with the wrapper adapter type.
2. Run one real issue through the wrapper.
3. Move one live agent at a time from the native adapter type to the wrapper type.
4. Watch the first run after migration for auth, cwd, session, and transcript behavior.
5. Continue only after the migrated agent has a clean run.

## Rollback

Rollback is an adapter type switch:

- `hermes_paperclip_local` back to `hermes_local`
- `codex_paperclip_local` back to `codex_local`
- `opencode_paperclip_local` back to `opencode_local`

Keep the adapter config values unless the wrapper-specific field is the suspected cause. Existing sessions may not always be portable between adapter types, so prefer rollback before starting a long follow-up run.

## Adding future wrappers

Future wrappers should compose the shared adapter layer:

- define a distinct adapter type
- delegate execution, environment tests, model metadata, skills, and session codec to the native adapter
- patch only the Paperclip-specific env, prompt, runtime-state, or compatibility behavior
- register the wrapper in both server and UI registries
- document native-vs-wrapper selection and rollback notes

External adapter plugins remain separate. A wrapper adapter type should not shadow unrelated external adapter types.
