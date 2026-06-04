# GSV Agent Guidelines

GSV is a distributed AI operating environment built from five main pieces:

- a gateway worker that owns the kernel, process runtime, auth, package management, adapters, and inference routing
- a web shell that hosts the desktop and embedded apps
- standalone adapter workers for external platforms such as WhatsApp and Discord
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
│   │   ├── syscalls/        # gateway syscall surface and process-local types
│   │   ├── inference/       # provider/model integration
│   │   ├── fs/              # filesystem and ripgit integration
│   │   ├── downloads/       # self-hosted CLI download/install support
│   │   ├── auth/            # passwords, tokens, setup auth
│   │   ├── shared/          # worker/DO bridge utilities
│   │   └── protocol/        # WS and RPC frame types
│   ├── wrangler.jsonc
│   └── package.json
├── builtin-packages/        # builtin apps synced from root/gsv
├── shared/                  # shared SDKs, contracts, and app-link types
├── web/
│   ├── src/                # desktop shell, host bridge, setup/login UI
│   ├── public/
│   └── package.json
├── adapters/
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

Builtin apps live under `builtin-packages/*`.

Examples:
- `chat`
- `gsv`
- `files`
- `shell`
- `wiki`

Runtime operations for processes, devices, message adapters, access, settings, packages, and source repositories belong in the consolidated `gsv` builtin app, not separate standalone builtin apps.

They are synced from `root/gsv` into the running system. A builtin app change is not applied by redeploying the gateway worker alone.

### Adapter workers

Adapter workers are separate deployables.

Each one owns its platform-specific behavior:
- auth and account state
- inbound event normalization
- outbound message delivery
- adapter-specific identity normalization

Gateway calls adapters through service bindings. Adapter workers call back into gateway through gateway RPC entrypoints.

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

### `builtin-packages/*`

You changed a builtin app.

Use:
```bash
git push <remote> HEAD:main
cargo run -- -u root packages sync
```

If the package is a new builtin, the running gateway code must already know about that builtin package.

### `adapters/*`

You changed an adapter worker.

Deploy that specific worker:

```bash
cd adapters/whatsapp
npm run deploy
```

```bash
cd adapters/discord
npm run deploy
```

### Combined changes

If a change spans multiple layers, update each one explicitly.

Examples:
- `gateway/src/*` + `builtin-packages/*`
  - redeploy gateway
  - sync builtins
- `gateway/src/*` + `web/src/*`
  - redeploy gateway
  - rebuild/redeploy web shell
- `builtin-packages/*` + `adapters/*`
  - sync builtins
  - redeploy that adapter

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

### Adapters

WhatsApp:
```bash
cd adapters/whatsapp
npm run dev
npm run deploy
npm run cf-typegen
npx tsc --noEmit
```

Discord:
```bash
cd adapters/discord
npm run dev
npm run deploy
npm run typecheck
```

Test adapter:
```bash
cd adapters/test
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
  - `cd adapters/whatsapp && npx tsc --noEmit`
- Discord/Test adapter changes:
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
- keep platform-specific logic in the relevant adapter worker

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

## Schema migrations

Durable Object SQLite schemas are managed through versioned migrations.

Current migration owners:
- gateway kernel: `gateway/src/kernel/schema/*`
- process runtime: `gateway/src/process/schema/*`
- app runner: `gateway/src/app-runner/schema/*`
- shared TypeScript runner: `gateway/src/schema/runner.ts`
- ripgit repository worker: `ripgit/src/schema.rs`

Rules:
- do not create tables, indexes, or ad hoc `ensureColumn` migrations from store constructors
- do not edit a migration that has shipped in a release; add the next numbered migration instead
- only collapse schema into a new `v001` baseline before a release or at an explicit major-version reset
- keep old migrations long enough for supported upgrade paths; pruning belongs to an intentional major-version policy
- after schema changes, validate the owning surface and migration tests, not just the store logic

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

## App product and UX decision-making

Builtin apps are operational desktop tools, not generic dashboards.
Start from the app's product job and the user decisions it must support.

Before coding a builtin app, be able to answer:
- what job the app owns
- what state should be visible at a glance
- what the top actions are
- what belongs in another app instead
- what layout shape fits the work
- what data belongs in the curated surface versus `Advanced`
- what permissions change what is editable
- whether behavior is intentionally changing or only being refactored

Default to dense but readable desktop patterns: sidebars, split panes, tables, inspectors, direct manipulation, and clear primary actions.
Avoid dumping raw syscall data, oversized dashboard cards, marketing spacing, and app-local workarounds for shared runtime seams.

Detailed product guidance lives in `docs/reference/builtin-app-design.md`.
The consolidated `GSV` system console contract lives in `docs/gsv-system-console.md`.

## Package frontend architecture and refactoring

Builtin packages are examples for future user-authored packages. Keep frontend structure understandable as apps grow.

Once a package has more than one real surface, prefer feature-oriented structure:
- `app.tsx` for composition and cross-feature wiring
- `components/*` for rendering and local interaction
- `hooks/*` for backend loading, subscriptions, timers, refs, media lifecycle, browser APIs, and host bridge state
- `domain/*` for pure transformations, reducers, normalization, and model rules
- `utils/*` for generic formatting, guards, markdown, clipboard, storage, and DOM helpers
- `backend/*` for package backend wrappers and syscall argument normalization

When refactoring, preserve behavior first: split pure helpers, then components, then hooks, then CSS.
Validate after each risky boundary and keep package CSS/assets aligned with `src/package.ts`.

Detailed package architecture guidance lives in `docs/reference/package-frontend-architecture.md`.
