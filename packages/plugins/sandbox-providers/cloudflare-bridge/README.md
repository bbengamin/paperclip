# `paperclip-plugin-cloudflare-bridge-sandbox`

Fork add-on Cloudflare **bridge** sandbox provider plugin for Paperclip.

This is a fork-maintained extension of the upstream `@paperclipai/plugin-cloudflare-sandbox` provider. It adds Tailscale
networking and extended bridge routes to the operator-facing Worker. It is a **separate** plugin (distinct `PLUGIN_ID`
and `driverKey: "cloudflare-bridge"`) so it coexists with the upstream Cloudflare provider and never modifies it.

This package lives in the Paperclip monorepo, but it is intentionally excluded from the root `pnpm` workspace and shaped to publish and install like a standalone npm package. Operators can install it from the Plugins page by package name, and the host will fetch its dependencies at install time without adding lockfile churn to the Paperclip repo.

## Install

From a Paperclip instance, install:

```text
paperclip-plugin-cloudflare-bridge-sandbox
```

Configure Cloudflare from `Instance Settings -> Environments`, not from the plugin's plugin page.

## Configuration

The environment uses core `driver: "sandbox"` with `provider: "cloudflare"` via `driverKey: "cloudflare-bridge"`.

Required fields:

- `bridgeBaseUrl`
- `bridgeAuthToken`

Important validation rules:

- `reuseLease: true` requires `keepAlive: true`
- non-local `bridgeBaseUrl` values must be `https://`
- `sessionId` is required when `sessionStrategy` is `named`

Pasted auth tokens are stored by Paperclip as company secrets because the manifest marks `bridgeAuthToken` as a `secret-ref` field.

## Bridge template

The package includes an operator-facing Cloudflare Worker scaffold under [bridge-template](./bridge-template). That template uses `@cloudflare/sandbox`, a `Sandbox` Durable Object binding, and a small JSON HTTP surface under `/api/paperclip-sandbox/v1`. This fork additionally provisions Tailscale networking (`tailscale-up.sh`) and extra bridge routes.

## Local development

Build before installing this package from a local path in Paperclip. The local plugin installer reads the manifest declared in `package.json` at `dist/manifest.js`; without a build, Paperclip reports that no manifest was found.

```bash
cd packages/plugins/sandbox-providers/cloudflare-bridge
pnpm install --ignore-workspace --no-lockfile
pnpm build
pnpm test
pnpm typecheck
```

These commands assume the repo root has already been installed once so the local `@paperclipai/plugin-sdk` workspace package is available to the compiler during development.
