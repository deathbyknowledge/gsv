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
- `files`
- `shell`
- `devices`
- `processes`
- `control`
- `packages`
- `adapters`

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

When designing or rewriting a builtin app, do not start from the current code shape or from whatever UI happens to exist today.
Start from the product job of the app.

The standard to hold is:
- builtin apps are operational tools inside a desktop environment
- they should make the important system state and actions obvious
- they should not feel like generic web admin dashboards
- they should not dump raw data unless the app is explicitly an advanced/debug surface

### Before writing code, define the app's job

Write down, at least briefly:
- what job the app owns
- what questions it should answer at a glance
- what primary actions it must make easy
- what belongs somewhere else and should not be duplicated here

If you cannot state the app's job clearly, you are not ready to implement it.

Examples:
- `Files` is for browsing and editing target filesystems, not for process management
- `Processes` is for inspecting and controlling process lifecycle, not for raw system config
- `Devices` should manage execution targets, health, trust, and routing, not be a metadata dump
- `Control` is for system settings and access, with raw config only as an escape hatch

### Design from user decisions, not from available syscalls

Do not build the UI by dumping every field returned by a syscall.
A syscall shape is an implementation detail, not a product design.

Instead:
- identify the decisions the user needs to make
- identify the state they need in order to make those decisions confidently
- design the UI around those decisions
- then map the design to the backend/syscalls

Bad pattern:
- render every config key because `sys.config.get` returned them

Good pattern:
- surface the curated settings people actually need
- keep unknown or low-confidence data in an `Advanced` escape hatch

### Prefer task-oriented surfaces over raw data dumps

Most apps should be organized around tasks, not raw records.

Good examples:
- pair a device
- open a workspace on a target
- inspect a process and stop it
- rotate a token
- save a profile prompt policy

Avoid:
- giant key/value tables as the main UI
- pages that only mirror backend objects without interpretation
- generic forms that expose every field with no explanation

### Make the important state visible at a glance

Every app should make the most important state immediately obvious.
Ask:
- what must the user be able to see in under five seconds?
- what should be sortable, grouped, or highlighted first?
- what deserves a dedicated summary instead of being buried in detail?

Examples:
- `Devices`: online/offline, platform, owner, last seen, capability readiness
- `Processes`: running/completed/error, label, owner, workspace, last activity
- `Files`: current target, current path, dirty state, preview type

### Use strong scope boundaries between apps

Do not casually merge responsibilities because the data is nearby.
If a concern belongs to another app, link to that app instead of re-implementing it.

Examples:
- `Devices` can link to `Files`, `Shell`, or `Processes`, but should not replace them
- `Control` can expose token and access flows, but should not become a device fleet manager
- `Processes` can open a conversation in `Chat`, but should not become the chat app

A builtin app should have a clear center of gravity.

### Default to desktop UI patterns, not dashboard/web-app patterns

GSV apps live inside a desktop shell.
Design them like operational desktop tools.

Prefer:
- split panes
- sidebars/rails
- detail panes
- tables where appropriate
- dense but readable layouts
- direct manipulation and clear primary actions

Avoid by default:
- stacked rounded cards for every section
- flashy dashboard tiles
- oversized marketing spacing
- layouts that waste vertical space on repeated explanatory chrome

The app should feel like a serious workstation tool.

### Use the right control for the job

Do not use one generic input type everywhere.
Match the control to the data and the action.

Examples:
- boolean: checkbox or toggle
- enum: select
- short scalar: text or number input
- long prompt/policy text: textarea
- structured but advanced policy: dedicated JSON editor only when needed
- destructive action: explicit button with clear label

If a field is important but hard to understand, add a short description.
If a field is low-confidence or too raw, move it to `Advanced`.

### Curate the main UX; keep raw power in `Advanced`

For apps that need a power-user escape hatch:
- keep the main surface curated and intentional
- keep raw/unmodeled state in `Advanced`
- do not let `Advanced` dictate the structure of the main app

`Advanced` is for:
- unmodeled keys
- raw JSON
- low-level policy artifacts
- debugging and recovery

It is not the design center of the app.

### Permissions are product, not just backend validation

Do not render an editable UI and wait for save-time permission errors.
If a user cannot edit something:
- make it read-only in the UI
- show the lock state clearly
- explain the restriction with a concise tooltip or inline note when needed

If a user has a personal override surface:
- show that as a first-class path
- do not force them through a system-admin flow that will fail later

### Raise architecture debt instead of normalizing ad hoc seams

When a bug or awkward workflow points to a shared runtime, host, SDK, routing, or cross-app contract problem, call that out explicitly.
Do not keep layering app-local patches over the same seam.

Examples:
- if multiple apps have to know another app's private route schema, the app-launch contract is wrong
- if one app works only through a special side channel while others hand-build URLs, the runtime boundary is wrong
- if the same host or RPC workaround keeps appearing, raise it as architecture debt before adding another copy

The standard is:
- identify whether the issue is local product/UI work or a shared systems seam
- if it is a shared seam, say so directly
- prefer one runtime/host/API fix over several ad hoc app patches

### Preserve behavior unless there is explicit product intent to change it

A migration to SPA, RPC, or a new runtime is not permission to redesign the product.
If you are changing:
- architecture
- rendering model
- state management
- transport

then preserve:
- the app's job
- the user's primary workflows
- the established visual direction

Only change product behavior when there is an explicit reason to do so.

### For a new or draft app, write a short product spec first

Before implementing a new app or turning a mock into a real product, write down:
- app job
- primary user questions
- primary actions
- main views/panes/tabs
- what is intentionally out of scope

This does not need to be long.
But it should exist before implementation starts.

### Minimum checklist before implementation

Before coding a builtin app, be able to answer all of these:
- What job does this app own?
- What should be visible at a glance?
- What are the top three user actions?
- What belongs in another app instead?
- What is the main layout shape: split pane, list/detail, editor, table, or wizard?
- Which data deserves a curated surface, and which belongs in `Advanced`?
- What permissions should change what is editable?
- Are we preserving the existing product behavior, or intentionally changing it?

If these answers are weak, stop and design first.
