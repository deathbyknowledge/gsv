# GSV Engineering Contract

GSV is an open-source, user-owned personal intelligence operating environment. Its gateway is a lightweight, globally reachable control plane; agents are durable processes; capabilities gate syscalls; and machines, browsers, and adapters implement common primitives behind target routing.

This document is the root engineering contract for the repository. It explains how to change GSV without eroding that model. Use the code as the source of truth, and update this file when the architecture deliberately changes.

## Architecture principles

### Preserve user ownership and control

- The user owns the deployment, state, credentials, agents, and connected machines.
- Permissions, approvals, process state, and external provider use must remain inspectable.
- Long-running work must not lock the user out. New input, cancellation, reset, and teardown must remain available while tools or subprocesses are active.
- Late output from cancelled or superseded work must not mutate the active run.

### Keep the gateway a control plane

- The gateway owns identity, authorization, configuration, routing, process lifecycle, packages, adapters, and inference coordination.
- Heavy or platform-native computation belongs on the appropriate device, provider, package worker, or specialized service.
- Do not move adapter quirks, UI rendering, or device-specific behavior into the Kernel.

### Treat syscalls and protocol frames as the primitive boundary

- Fix shared semantics at the syscall, protocol, or owning runtime boundary rather than patching individual callers.
- A targetable syscall must mean the same thing on `gsv`, a connected device, and a browser-backed target.
- Shell, agent tools, CodeMode, apps, and SDK clients may present results differently, but they must share the same underlying primitive behavior.
- Structured frames carry metadata. Potentially large or binary payloads travel through frame bodies and streams.
- Whoever accepts a body, request, media object, or background operation owns its completion, cancellation, and cleanup.

### Keep the agent interface small and composable

The fixed model-facing surface is Read, Write, Edit, Delete, Search, Shell, and CodeMode. Add capabilities beneath that surface through syscalls, targets, packages, or CodeMode instead of growing a bespoke tool for every integration.

GSV is Linux-inspired because familiar, orthogonal semantics reduce instruction burden for models and humans. This is a design model, not a promise of POSIX compatibility.

### Treat agents as real processes

Processes have identities, histories, permissions, queues, pending work, and lifecycles. Subagents and subprocesses are not special chat records. Preserve process invariants across normal completion, interruption, restart, and teardown.

### Prefer fewer mechanisms

- Consolidate duplicate paths and delete obsolete ones when behavior remains clear.
- Validate hostile input at external boundaries. Represent internal assumptions as explicit invariants and tests instead of speculative defensive branches.
- Inline trivial one-use helpers. Keep helpers that name a meaningful domain operation or centralize policy, ownership, or lifecycle.
- Split large files by responsibility, owner, or state-machine boundary—not merely by line count.
- Compatibility must correspond to an explicitly supported upgrade path. An
  in-place cutoff removes legacy admission and execution paths end to end; it
  does not imply deleting unreachable durable records or rebinding storage
  unless an explicit cleanup policy says so.
- Optimize for comprehensibility and a smaller state space, not raw line-count reduction at the expense of correctness.
- Measure user-visible latency before optimizing it, and avoid unnecessary serial work on critical paths.

## System ownership

- `gateway/src/kernel/`: authentication, capabilities, syscall dispatch, configuration, process registry, routing, packages, schedules, adapters, and user connections.
- `gateway/src/process/`: agent loop, conversations, queued input, pending tools, approvals, cancellation, context assembly, and process-scoped media.
- `gateway/src/syscalls/` and `gateway/src/protocol/`: public runtime contracts and frame transport.
- `gateway/src/inference/`: provider integration and model transport.
- `packages/gsv/`: public SDK, client, host bridge, and protocol types.
- `web/`: desktop shell, setup/login, system UI, app hosting, and browser-side gateway integration.
- `cli/`: user, device, deployment, and administration commands.
- `adapters/`: platform-specific messaging workers and identity normalization.
- `extension/`: browser-backed target and browser integration.
- `assembler/`: package worker assembly.
- `ripgit/`: git-backed repositories and filesystem storage operations.

Keep platform-specific identity and delivery behavior in its adapter. Keep visual presentation in the web shell or package UI. Keep target selection below stable syscall contracts.

## Runtime invariants

### Processes and cancellation

- Provider history must remain structurally valid.
- Queued messages must not be lost accidentally.
- Pending tool calls and tool results must stay consistent.
- A stale run must not mutate active state.
- Cancellation must propagate to the component that owns the active operation.
- Request cancellation does not recursively kill an already-created durable shell session unless that contract explicitly says so.
- `proc.abort` stops the active run, `proc.reset` resets conversation state while preserving the process, and `proc.kill` tears the process down.
- Archive and media cleanup must remain coherent across reset and kill.
- A Process accepts authority only from its owning active user Kernel. Process
  ids, stored identities, and routing metadata never authenticate a caller by
  themselves.

### Protocol and routing

- Payload types are explicit at syscall and protocol boundaries.
- `/ws` is the commissioning route. Provisioned human, device, and service
  connections use `/ws/<canonical-username>`. The Gateway asks the Master
  Control Program for the current placement before selecting
  `user:<canonical-username>`; placement is only a locator and never
  authenticates the caller.
- A user Kernel must persist and validate its provisioning state. Arbitrary
  Durable Object names exist on demand, so an unprovisioned, provisioning,
  or otherwise non-active object fails closed. Only `active` accepts normal
  connections. A known `provisioning` placement may be completed by the
  Master-owned idempotent ensure operation before target selection; it serves no
  traffic in that state. Unknown or unsuccessfully provisioned scoped routes
  fail with HTTP 404 before WebSocket upgrade; credential failures occur inside
  the socket.
- An active app-session handle binds canonical username, uid, expiry, and nonce
  into a local user-Kernel HMAC. The Gateway uses its bounded username locator
  to select `user:<username>`; the target then verifies its active marker, HMAC,
  and local session before accepting the full request. OAuth and MCP callback
  locators are parseable routing hints; the target atomically consumes the full
  opaque flow state. In every case, routing metadata is not resource authority
  by itself.
- Adapter traffic routes through the Master in both directions. The Master
  resolves the live identity link and active user-Kernel placement before
  delivering inbound frames, and validates outbound routes before invoking an
  adapter. Payload usernames and adapter-supplied uids are never trusted.
- Git HTTP authentication and repository ACL checks are bounded Master
  admission work. Request bodies and repository operations belong to RIPGIT
  after admission; they do not transit the Master or a user Kernel.
- Body streams have one owner and one terminal outcome: consumed, forwarded, or cancelled.
- Device disconnects, timeouts, malformed responses, and caller cancellation must clean up routes and bodies.
- Filesystem, shell, and network behavior must remain consistent between local gateway and device implementations.
- Adapters receive stable actor and surface semantics; channel-specific identifiers do not leak into generic RPCs.

### Data and security

- One deployment is one ship security domain. The Kernel Durable Object named
  `singleton` is its Master Control Program: it owns the global account-name,
  uid/gid, credential, group, capability, configuration, package,
  repository-metadata, adapter-link, and cross-user authorization namespace,
  plus commissioning and any future admission policy.
  It is not the steady-state router for every user's traffic.
- Clean commissioning and newly created login-capable humans receive one
  provisioned user Kernel named `user:<canonical-username>`. Accounts discovered
  by an upgrade must be provisioned before normal traffic is admitted; there is
  no singleton fallback for a login-capable account. An active user Kernel owns
  the human's connections, devices, process registry, routing, schedules,
  OAuth/MCP state, and other local runtime coordination, while Process and
  AppRunner objects retain their execution ownership.
- The v16 upgrade is an in-place cutoff. It backfills account identities and
  login-capable `provisioning` placements inside the retained `singleton`, then
  provisions each `user:<canonical-username>` idempotently on demand. It does
  not copy or destroy old singleton-local runtime coordination. Those rows stay
  dormant after activation. Existing R2 paths, ripgit repositories,
  `app:<actorUid>:<packageId>` AppRunner objects, adapter accounts, and
  identity links keep their existing storage and names.
- User Kernels hold no durable replicas of Master account, capability,
  configuration, package, link, or repository authority. They resolve current
  state through narrow typed Master RPCs and master-owned syscalls. The Master
  reconstructs and authorizes the requesting identity instead of trusting a
  caller-supplied username, uid, or Kernel name.
- An AppRunner is the deterministic object
  `app:<actorUid>:<packageId>`. Its name is a locator, not authority. The
  owning active user Kernel validates the run-as actor, package, entrypoint,
  artifact, and requested call against current Master state before admitting
  package traffic. Pre-split records lacking `kernelName` are interpreted as
  the old implicit `singleton` binding and lazily rebind that same object to the
  active user Kernel of the actor's controlling human after closing stale
  sockets and reauthorizing. Personal-agent actors do not receive their own
  user Kernel.
- Every newly created `oauth_flows` row binds the human Kernel owner that
  admitted it. The callback target atomically consumes the full opaque state
  and rejects a missing or mismatched owner rather than inferring one from the
  run-as uid or routing locator.
- Canonical usernames are lower-case ASCII public account identifiers. They are
  immutable, globally unique within the ship, permanently reserved, and never
  reused, including after deletion. Mutable human-facing names live in display
  fields such as GECOS, not in the canonical username. Do not add a second
  account identifier or mutable login alias in front of this identity; the
  username maps directly to `user:<canonical-username>`.
- Numeric uids and gids are immutable, ship-scoped filesystem ownership keys and
  are never reused. Device ids, token ids, PIDs, adapter account ids, and other
  typed resource identifiers remain distinct; a username alone never
  authenticates one of those actors.
- Public self-registration and model-mediated admission are not implemented and
  remain closed. Do not expose account creation publicly until the documented
  multiuser release gates pass.
- Login and link-code throttling is durable Master state. Cloudflare's edge
  rate-limit binding may shed obvious abuse, but it must not replace the
  authoritative in-DO limits used for identity security decisions.
- Enforce authorization in the Kernel, not only in UI or callers.
- R2 does not enforce GSV's custom uid/gid/mode metadata. User-reachable R2
  operations go through GsvFs, or a narrow typed store with equivalent
  ownership checks; never expose a raw R2 binding to caller-controlled code.
- Never hardcode or log secrets, raw authentication material, QR payloads, prompts, tool arguments, or private file contents.
- Store process media once in R2, persist references in history, scope keys to the owning process, and hydrate only while building model context.
- Packages remain source-inspectable and capability-gated.
- Telemetry uses an explicit allowlist and records timings and outcomes rather than user content.

## Schema migrations

Durable Object SQLite schemas use versioned migrations in:

- `gateway/src/kernel/schema/`
- `gateway/src/process/schema/`
- `gateway/src/app-runner/schema/`
- `gateway/src/schema/runner.ts`
- `ripgit/src/schema.rs`

Do not create tables, indexes, or ad hoc `ensureColumn` migrations from store constructors. Do not edit a migration that has shipped; add the next numbered migration. Collapse to a new baseline only for an explicit release/reset policy, and preserve supported upgrade paths with migration tests.

## Change discipline

1. Inspect the current branch, diff, callers, and owning subsystem before editing.
2. State the invariant and the component that should own the behavior.
3. For broad cleanup, present the proposed batch before changing behavior so maintainers can supply historical context.
4. Fix the central boundary, remove superseded paths, and avoid caller-specific workarounds.
5. Validate the smallest relevant surface. Cross-boundary changes require tests on both sides.
6. Run a clean-instance end-to-end flow for onboarding, deployment, protocol, authentication, or lifecycle changes.
7. Commit completed batches separately with short, imperative, lowercase subjects.

Preserve unrelated user changes in a dirty worktree. Do not broaden a cleanup batch merely because nearby code could also be changed.

## Repository map

```text
gsv/
├── gateway/       # Kernel, Process, syscalls, inference, filesystem
├── packages/gsv/  # Public TypeScript SDK and protocol
├── web/           # Desktop shell and embedded app host
├── cli/           # Rust CLI and device runtime
├── adapters/      # WhatsApp, Discord, Telegram, and test channels
├── extension/     # Browser target
├── assembler/     # Package assembly worker
├── ripgit/        # Git-backed repository worker
├── engineering/   # Detailed implementation and product guidance
├── docs/          # Architecture and user/reference documentation
└── scripts/       # Development and release automation
```

## Development and validation

Install dependencies:

```bash
./scripts/setup-deps.sh
```

Build the web assets before starting the local multi-worker stack; the gateway serves `web/dist`:

```bash
npm run build --workspace web
npm run dev
```

Validate only the surfaces affected by the change:

- Gateway: `cd gateway && npx tsc --noEmit && npm run test:run`
- Web: `cd web && npm run check && npm run test:run && npm run build`
- Public SDK: `npm run gsv:check && npm test --workspace packages/gsv`
- CLI/device: `cd cli && cargo fmt --check && cargo test`
- Assembler: `cd assembler && npm test`
- ripgit: `cd ripgit && npm test`
- Browser extension: `cd extension && npm run check && npm run test:run && npm run build`
- WhatsApp: `cd adapters/whatsapp && npx tsc --noEmit`
- Discord, Telegram, or test adapter: `cd adapters/<name> && npm run typecheck`

Protocol or SDK changes may affect gateway, web, CLI, devices, adapters, and packages even when only one type definition changed. Validate each actual consumer.

## Deployment model

- Gateway code: `cd gateway && npm run deploy`
- Web code: build `web`, then deploy the gateway that serves the resulting assets.
- Adapter code: deploy the affected adapter worker.
- Assembler or ripgit code: deploy that worker separately.
- CLI or extension code: build and publish through their release path; a gateway deploy does not update them.

Deployment and CLI command reference lives in `docs/reference/cli-commands.md`.

## Code and commit style

TypeScript uses two-space indentation, double quotes, semicolons, `import type` for type-only imports, and explicit boundary types. Avoid `any` outside tightly constrained interop.

Rust uses `cargo fmt`, non-blocking async code, `Result` with `?`, and contextual errors at I/O and network boundaries.

Commit subjects are short, imperative, lowercase, and scoped to one logical change, for example:

- `simplify process cancellation`
- `unify device response cleanup`
- `add disposable e2e smoke`

## Detailed guidance

- Architecture: `docs/architecture/`
- Syscalls and protocol: `docs/reference/syscalls.md` and `docs/reference/websocket-protocol.md`
- Package frontend structure: `engineering/package-frontend-architecture.md`
- Web product and app design: `engineering/builtin-app-design.md`

Read the relevant detailed guide before changing that subsystem; do not duplicate its full policy here.
