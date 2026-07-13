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
- Compatibility must correspond to an explicitly supported upgrade path. A hard cutover should remove the old path end to end.
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

### Protocol and routing

- Payload types are explicit at syscall and protocol boundaries.
- Body streams have one owner and one terminal outcome: consumed, forwarded, or cancelled.
- Device disconnects, timeouts, malformed responses, and caller cancellation must clean up routes and bodies.
- Filesystem, shell, and network behavior must remain consistent between local gateway and device implementations.
- Adapters receive stable actor and surface semantics; channel-specific identifiers do not leak into generic RPCs.

### Data and security

- Enforce authorization in the Kernel, not only in UI or callers.
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
