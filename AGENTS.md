# GSV Agent Guidelines

GSV is a distributed AI operating environment built from five main pieces:

- a gateway worker that owns the kernel, process runtime, auth, package management, adapters, and inference routing
- a web shell that hosts the desktop and embedded apps
- standalone channel workers for external platforms such as WhatsApp and Discord
- a Rust CLI for users, devices, deployment, and administration
- the `ripgit` worker for git-backed storage and content operations

This document is the working orientation for the current repository. It should help an agent understand where things live, how they deploy, and how to validate the right surface after a change.

## Repository layout

```text
gsv-app-runtime/
├── gateway/
│   ├── src/
│   │   ├── kernel/          # syscall dispatch, auth, config, adapters, packages
│   │   ├── process/         # Process DO runtime, store, queue, checkpoint, media
│   │   ├── syscalls/        # shared syscall types
│   │   ├── inference/       # provider/model integration
│   │   ├── fs/              # filesystem and ripgit integration
│   │   ├── downloads/       # self-hosted CLI download/install support
│   │   ├── auth/            # passwords, tokens, setup auth
│   │   ├── shared/          # worker/DO bridge utilities
│   │   └── protocol/        # WS and RPC frame types
│   ├── packages/            # builtin apps synced from system/gsv
│   ├── wrangler.jsonc
│   └── package.json
├── web/
│   ├── src/                # desktop shell, host bridge, setup/login UI
│   ├── public/
│   └── package.json
├── channels/
│   ├── whatsapp/
│   ├── discord/
│   └── test/
├── cli/
├── ripgit/
├── scripts/
├── templates/
├── docs/
├── README.md
└── CHANNELS.md
```

## Runtime model

### Gateway

The gateway is the control plane.

It is responsible for:
- websocket connections
- identity and auth
- syscall dispatch
- process lifecycle
- package sync and package permissions
- adapter routing
- system configuration
- model/provider dispatch

The most important directories are:
- `gateway/src/kernel/*`
- `gateway/src/process/*`
- `gateway/src/syscalls/*`
- `gateway/src/inference/*`

### Processes

A process is the unit of agent execution.

The process runtime owns:
- user/assistant/tool message history
- queued incoming messages
- pending tool calls
- checkpointing
- process-scoped media storage and hydration

Key files:
- `gateway/src/process/do.ts`
- `gateway/src/process/store.ts`
- `gateway/src/process/checkpoint.ts`
- `gateway/src/process/media.ts`

Important syscalls:
- `proc.spawn`
- `proc.send`
- `proc.history`
- `proc.abort`
- `proc.reset`
- `proc.kill`

### Web shell

The web shell is the desktop UI.

It owns:
- login and setup flows
- the desktop frame
- the iframe host bridge for builtin apps
- app/window orchestration

Key files:
- `web/src/session-ui.ts`
- `web/src/session-service.ts`
- `web/src/host-bridge.ts`
- `web/src/gateway-client.ts`

### Builtin apps

Builtin apps live under `gateway/packages/*`.

Examples:
- `chat`
- `files`
- `shell`
- `devices`
- `processes`
- `control`
- `packages`
- `adapters`

They are synced from `system/gsv` into the running system. A builtin app change is not applied by redeploying the gateway worker alone.

### Channel workers

Channel workers are separate deployables.

Each one owns its platform-specific behavior:
- auth and account state
- inbound event normalization
- outbound message delivery
- adapter-specific identity normalization

Gateway calls channels through service bindings. Channels call back into gateway through gateway RPC entrypoints.

### ripgit

`ripgit` provides git-backed storage and content operations used by the gateway filesystem and package/repo flows.

## Update model

This is the most important operational distinction in the repo.

### `gateway/src/*`

You changed gateway worker code.

Use:
```bash
cd gateway
npm run deploy
```

Local dev:
```bash
cd gateway
npm run dev
```

### `web/src/*` or `web/public/*`

You changed the web shell.

Use:
```bash
cd web
npm run build
```

Then redeploy however the built web bundle is served in that environment.

Local dev:
```bash
cd web
npm run dev
```

### `gateway/packages/*`

You changed a builtin app.

Use:
```bash
git push <remote> HEAD:main
cargo run -- -u root packages sync
```

If the package is a new builtin, the running gateway code must already know about that builtin package.

### `channels/*`

You changed a channel worker.

Deploy that specific worker:

```bash
cd channels/whatsapp
npm run deploy
```

```bash
cd channels/discord
npm run deploy
```

### Combined changes

If a change spans multiple layers, update each one explicitly.

Examples:
- `gateway/src/*` + `gateway/packages/*`
  - redeploy gateway
  - sync builtins
- `gateway/src/*` + `web/src/*`
  - redeploy gateway
  - rebuild/redeploy web shell
- `gateway/packages/*` + `channels/*`
  - sync builtins
  - redeploy that channel

## Development commands

### Dependency bootstrap

```bash
./scripts/setup-deps.sh
```

### Local multi-worker stack

```bash
./scripts/dev-stack.sh
```

### Gateway

```bash
cd gateway
npm run dev
npx tsc --noEmit
npm run test:run
npm run cf-typegen
```

### Web shell

```bash
cd web
npm run dev
npm run build
npm run check
```

### Channels

WhatsApp:
```bash
cd channels/whatsapp
npm run dev
npm run deploy
npm run cf-typegen
npx tsc --noEmit
```

Discord:
```bash
cd channels/discord
npm run dev
npm run deploy
npm run typecheck
```

Test channel:
```bash
cd channels/test
npm run dev
npm run deploy
npm run typecheck
```

### CLI

```bash
cd cli
cargo build
cargo test
cargo fmt
```

Useful commands:
```bash
cargo run -- -u root packages sync
cargo run -- node install --id <device-id> --workspace ~/projects
cargo run -- deploy up --wizard --all
```

## Validation guidance

Validate the surface you changed.

Examples:
- gateway runtime or syscall changes:
  - `cd gateway && npx tsc --noEmit && npm run test:run`
- web shell changes:
  - `cd web && npm run check && npm run build`
- builtin app changes:
  - sync the package and exercise it through the desktop shell
- WhatsApp changes:
  - `cd channels/whatsapp && npx tsc --noEmit`
- Discord/Test channel changes:
  - `npm run typecheck`
- CLI changes:
  - `cd cli && cargo test && cargo fmt --check`

The goal is correct validation, not maximal validation.

## Coding guidelines

### TypeScript

- 2-space indentation
- double quotes and semicolons
- `import type` for type-only imports
- keep payload types explicit at syscall/protocol boundaries
- avoid `any` unless tightly scoped
- keep platform-specific logic in the relevant channel worker

### Rust

- use `cargo fmt`
- prefer `Result` with `?`
- add context at IO and network boundaries
- keep async code non-blocking

## Process/runtime invariants

When working on process features, preserve these properties:

- provider history must remain structurally valid
- queued messages must not be lost accidentally
- pending tool calls and tool results must stay consistent
- late results from stale runs must not mutate active state
- checkpoint/archive behavior must remain coherent after resets, kills, and aborts

Pay attention to:
- `proc.abort` for logical cancellation
- `proc.reset` for conversation reset with process survival
- `proc.kill` for process teardown

## Adapter and channel guidelines

- gateway should see stable adapter actor/surface semantics
- adapter-specific identity quirks belong in the channel worker
- generic adapter RPCs should stay generic
- UI rendering belongs in apps or the web shell, not in backend channel workers

## Media guidelines

- store process media once in R2
- persist references in process history
- hydrate media only when building model context
- keep media scoped clearly to the owning process unless a broader scope is explicitly needed

## Security

- never hardcode secrets, tokens, or credentials
- use worker secrets or local secret files as appropriate
- do not log API keys, raw auth material, or QR payloads
- be careful with adapter/user identifiers in logs

## Commits

- short, imperative, lowercase subjects
- keep commits scoped to one logical change

Examples:
- `add chat media attachments`
- `add adapter activity typing`
- `fix gateway test fixtures`

## Working principle

Use the code as the source of truth.

When you change something:
1. identify which runtime layer you touched
2. apply the correct deploy/update path for that layer
3. validate the smallest relevant surface before shipping
