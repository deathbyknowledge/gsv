---
name: gsv-system-operations
description: Guide on how to operate and update a GSV deployment, including which layer changed, what to validate, and what to deploy or sync.
---

# GSV System Operations

## Identify the Layer

Validate and deploy the layer you changed:

- `gateway/src/*`: Gateway worker, Kernel, process runtime, syscalls, packages, auth, adapters, inference, native tools.
- `web/src/*` or `web/public/*`: Desktop web shell and app host.
- `builtin-packages/*`: builtin apps synced from `root/gsv`.
- `adapters/*`: standalone WhatsApp, Discord, or test adapter workers.
- `cli/*`: Rust host CLI and device daemon.
- `ripgit/*`: git-backed storage worker.

Combined changes require each affected update path.

## Local Validation

Gateway:

```bash
cd gateway
npx tsc --noEmit
npm run test:run
```

Web:

```bash
cd web
npm run check
npm run build
```

CLI:

```bash
cd cli
cargo fmt --check
cargo test
```

Adapters:

```bash
cd adapters/whatsapp && npx tsc --noEmit
cd adapters/discord && npm run typecheck
cd adapters/test && npm run typecheck
```

Use the smallest relevant checks when the change is narrow.

## Deploy and Sync

Gateway:

```bash
cd gateway
npm run deploy
```

Web shell:

```bash
cd web
npm run build
```

Adapter workers:

```bash
cd adapters/whatsapp && npm run deploy
cd adapters/discord && npm run deploy
```

Builtin packages are not updated by redeploying Gateway alone. Update the `root/gsv` source, then run:

```bash
gsv packages sync
```

If package runtime, SDK, assembler, or Gateway behavior changed, deploy those components before syncing builtins.

## Bootstrap Upstream for Development

Bootstrap imports `root/gsv` from the configured upstream. For development, use the configured bootstrap upstream/ref instead of merging to main just to test seeded packages or skills.

Use explicit setup/bootstrap args when available, or configure worker dev vars such as:

```text
GSV_BOOTSTRAP_UPSTREAM=deathbyknowledge/gsv#my-branch
GSV_BOOTSTRAP_REF=my-branch
```

If both are set, explicit request args win, then environment, then the default `https://github.com/deathbyknowledge/gsv#main`.

## Operational Distinctions

- Redeploying Gateway changes Kernel/runtime code.
- Rebuilding web changes the Desktop shell bundle.
- Syncing builtins reassembles installed builtin packages from `root/gsv`.
- Pulling upstream refreshes a ripgit source from its remote.
- Checking out a package moves its installed source ref.
- Syncing a package re-runs assembly for the ref it already points at.

Do not collapse these into one "update" step. Pick the operation that matches the state you need to change.
