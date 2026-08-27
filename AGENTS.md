# GSV Engineering Contract

GSV is an open-source, user-owned personal intelligence operating environment. Its gateway is a lightweight, globally reachable control plane; agents are durable processes; capabilities gate syscalls; machines and browsers implement common primitives behind target routing; and adapters own messaging transport.

This document is the root engineering contract for the repository. It explains how to change GSV without eroding that model. Use the code as the source of truth, and update this file when the architecture deliberately changes.

## Architecture principles

### Preserve user ownership and control

- The user owns the deployment, state, credentials, agents, and connected machines.
- Permissions, approvals, process state, and external provider use must remain inspectable.
- Long-running work must not lock the user out. New input, cancellation, reset, and teardown must remain available while tools or subprocesses are active.
- Late output from cancelled or superseded work must not mutate the active run.

### Keep the gateway a control plane

- The gateway owns identity, authorization, configuration, routing, process lifecycle, adapters, and inference coordination.
- Heavy or platform-native computation belongs on the appropriate device, provider, or specialized service.
- Do not move adapter quirks, UI rendering, or device-specific behavior into the Kernel.

### Treat installation identity as the outer security boundary

- Managed HTTP requests resolve an accepted hostname through the trusted installation directory before addressing a Kernel. A random wildcard hostname must not allocate Durable Object state.
- The Kernel Durable Object name is the immutable `installationId`; handles and canonical origins are routing metadata, not security identities.
- Public callers never choose an `installationId`. Gateways derive it from host routing, adapters derive it from durable links, and background work retains it in owned state.
- A platform-owned shared adapter may bind an external identity only through a direct, signed-in human confirmation. Its public webhook and pairing code never choose an installation or local uid; the adapter owns one generation-fenced peer route and rechecks that generation before delayed ingress or delivery.
- Accounts owns managed installation state. Only `active` installations admit ordinary work; `restricted` installations retain their identity and data while HTTP, WebSocket, adapter, inference, Process-tick, and scheduler admissions fail closed. Work already admitted may reach its terminal boundary, and paused durable work rechecks for reactivation.
- An operator reset never clears a Kernel in place or reuses its installation ID. Accounts atomically moves the handle to a fresh installation, retains the old identity behind inactive routing, and records its data as pending deletion until every owning service confirms cleanup.
- Process, R2, ripgit, and adapter physical addresses must include installation scope before managed multi-installation hosting is enabled.
- `ctx.id.name` is available only on name-preserving Durable Object paths. An `idFromString()` callback must recover a previously validated identity from owned state or a trusted routing record.
- Preserve the explicit `singleton` projection for supported standalone upgrades until a deliberate standalone migration replaces it end to end.

### Treat syscalls and protocol frames as the primitive boundary

- Fix shared semantics at the syscall, protocol, or owning runtime boundary rather than patching individual callers.
- Model browsers, native clients, machines, and adapter services as protocol peers. Principal, callable syscalls, receivable signals, implemented syscalls, transport, and provenance are independent axes; transport or a claimed peer id never grants authority.
- First-party adapter service bindings use one `AdapterGatewayEntrypoint`. Deployment-owned binding props supply the adapter identity and attenuated syscall grant; the adapter frame cannot choose either. Kernel-owned `CHANNEL_<ADAPTER>` binding lookup selects the outbound service without a source-level adapter registry.
- A linked adapter actor may invoke an ordinary syscall only through a Kernel-derived, interaction-scoped human peer whose grant is intersected with the linked account's capabilities.
- A targetable syscall must mean the same thing on `gsv`, a connected device, and a browser-backed target.
- Shell, agent tools, CodeMode, apps, and SDK clients may present results differently, but they must share the same underlying primitive behavior.
- Structured frames carry metadata. Potentially large or binary payloads travel through frame bodies and streams.
- Whoever accepts a body, request, media object, or background operation owns its completion, cancellation, and cleanup.

### Keep the agent interface small and composable

The fixed model-facing surface is Read, Write, Edit, Delete, Search, Shell, and CodeMode. Add capabilities beneath that surface through syscalls, targets, or CodeMode instead of growing a bespoke tool for every integration.

GSV is Linux-inspired because familiar, orthogonal semantics reduce instruction burden for models and humans. This is a design model, not a promise of POSIX compatibility.

### Treat agents as real processes

Processes have identities, histories, permissions, queues, pending work, and lifecycles. Subagents and subprocesses are not special chat records. Preserve process invariants across normal completion, interruption, restart, and teardown.

The personal agent account is the user's personal intelligence. Its canonical user-facing conversation is Ship. One Kernel-marked interactive process handles Ship across user interfaces; its pid is replaceable and otherwise follows ordinary process lifecycle. Other processes are visible work, even when they run as the same account. Kernel SQLite owns one durable responsibility ledger (`r12y`) for promises, delegated work, follow-ups, maintenance, and recovery that must survive a run. The Ship sees the owner ledger; a delegated child sees only its assignments and their ancestor records. A delegated process is an ordinary process acting in a worker role, not a second orchestration runtime.

A Process context epoch freezes the exact rendered system prompt, its source manifest, and the initial responsibility baseline across normal runs. Later responsibility revisions enter as ordered GSV events rather than rewriting the prompt. Kernel-owned availability facts such as accessible targets, ready MCP servers, the current date and timezone, and the skill catalog follow the same rule: Process stores an initial and last-observed projection and atomically appends meaningful deltas before generation. Reset, compaction, Process replacement, or effective standing-context changes close and archive the epoch, including its exact prompt, Process activity, projection and responsibility transitions, and run boundaries.

Canonical user-facing conversations are not Process histories. Conversations retain only committed user-visible Messages across Process replacement or deletion; Process history retains reasoning, drafts, tools, results, and run-control choices for inspection. `message send` commits a user-visible Message without finishing the active run, so a Process may update the user while continuing work. Every human-facing run must eventually call `yield`; a final send composes as `message send ... && yield`, while a bare `yield` completes silently. These Process-owned commands do not add model tools or require shell approval. A bounded IPC call instead returns ordinary assistant output as its durable Process result, independently of human delivery. Clients may opt into raw Process observation, while adapters consume only committed messages.

### Prefer fewer mechanisms

- Consolidate duplicate paths and delete obsolete ones when behavior remains clear.
- Validate hostile input at external boundaries. Represent internal assumptions as explicit invariants and tests instead of speculative defensive branches.
- Inline trivial one-use helpers. Keep helpers that name a meaningful domain operation or centralize policy, ownership, or lifecycle.
- Split large files by responsibility, owner, or state-machine boundary—not merely by line count.
- Compatibility must correspond to an explicitly supported upgrade path. A hard cutover should remove the old path end to end.
- Optimize for comprehensibility and a smaller state space, not raw line-count reduction at the expense of correctness.
- Measure user-visible latency before optimizing it, and avoid unnecessary serial work on critical paths.

## System ownership

- `packages/gsv/src/services/`: public Worker RPC contracts for installation directories, onboarding, entitlements, funded inference, mail, and adapters. Managed implementations belong to the deployment operator.
- `gateway/src/kernel/`: authentication, capabilities, syscall dispatch, configuration, process registry, routing, schedules, adapters, and user connections.
- `gateway/src/process/`: agent loop, history, queued input, pending tools, approvals, cancellation, context assembly, and process-scoped media.
- `gateway/src/conversation/`: canonical user-visible message history, immutable resource references, hot SQLite retention, and immutable R2 archive segments.
- `gateway/src/syscalls/` and `gateway/src/protocol/`: public runtime contracts and frame transport.
- `gateway/src/inference/`: provider integration and model transport.
- `packages/gsv/`: public client and protocol types.
- `web/`: desktop shell, setup/login, system UI, and browser-side gateway integration.
- `host/apps/desktop/`: GPUI desktop client, text-first interaction model, and native presentation.
- `host/apps/cli/`: user, deployment, administration, and OS service-control commands.
- `host/apps/machine/`: the `gsvd` machine driver, concrete tools, transfer ownership, reconnect, logging, and shutdown.
- `host/helpers/`: separately supervised local transcription and gesture processes.
- `host/crates/`: shared gateway transport, host configuration, Desktop IPC, and gesture protocol contracts. `host/` owns their Cargo workspace and build artifacts.
- `adapters/`: platform-specific messaging workers and identity normalization.
- `extension/`: browser-backed target and browser integration.
- `ripgit/`: git-backed repositories and filesystem storage operations.

Keep platform-specific identity and delivery behavior in its adapter. Keep visual presentation in the web and Desktop clients. Keep target selection below stable syscall contracts.

## Runtime invariants

### Processes and cancellation

- Provider history must remain structurally valid.
- Queued messages must not be lost accidentally.
- Pending tool calls and tool results must stay consistent.
- A stale run must not mutate active state.
- Cancellation must propagate to the component that owns the active operation.
- Request cancellation does not recursively kill an already-created durable shell session unless that contract explicitly says so.
- `proc.abort` stops the active run, `proc.reset` resets history while preserving the process, and `proc.kill` tears the process down.
- A successfully killed pid remains terminal across Durable Object eviction and must never be reused for a replacement process.
- Archive and media cleanup must remain coherent across reset and kill.

### Protocol and routing

- Payload types are explicit at syscall and protocol boundaries.
- Body streams have one owner and one terminal outcome: consumed, forwarded, or cancelled.
- Device disconnects, timeouts, malformed responses, and caller cancellation must clean up routes and bodies.
- Filesystem, shell, and network behavior must remain consistent between local gateway and device implementations.
- Adapters receive stable actor and surface semantics; channel-specific identifiers do not leak into generic RPCs.
- Private user surfaces default to the personal process. Direct access to another process is an explicit, visibly labeled work session; opening one surface must not silently redefine the user's personal intelligence elsewhere.
- A run route directs immediate message streaming and delivery to one originating endpoint; it does not own the canonical conversation. Other clients synchronize committed messages without inheriting that endpoint's delivery behavior.

### Data and security

- Enforce authorization in the Kernel, not only in UI or callers.
- Managed onboarding capabilities authorize only first-boot setup for one installation. Store them hashed in accounts, keep them out of URLs after the browser reads the fragment, and let only the Kernel create local credentials.
- Never hardcode or log secrets, raw authentication material, QR payloads, prompts, tool arguments, or private file contents.
- Persist file and media references in history, retain durable content once as immutable media under the run-as agent home, and scope temporary keys to the owning process. Hydrate bytes only while building model context or resolving an explicit resource read.
- Canonical Messages store immutable resource references rather than duplicating bytes. A Process must retain an exact source revision before committing a reference whose source lifetime is not already durable.
- Telemetry uses an explicit allowlist and records timings and outcomes rather than user content.

## Schema migrations

Durable Object SQLite and managed D1 schemas use versioned migrations in:

- `gateway/src/kernel/schema/`
- `gateway/src/process/schema/`
- `gateway/src/schema/runner.ts`
- `ripgit/src/schema.rs`

Do not create tables, indexes, or ad hoc `ensureColumn` migrations from store constructors. Do not edit a migration that has shipped; add the next numbered migration. Collapse to a new baseline only for an explicit release/reset policy, and preserve supported upgrade paths with migration tests.

Use Durable Object storage KV for a single opaque record that is read and written as a unit. Introduce SQL tables and migrations when the data needs relational queries, indexes, constraints, or multi-row operations.

## Change discipline

- Do not rewrite or delete maintainer-authored comments unless the maintainer explicitly requests it. If a change makes one stale, preserve it and call it out for direction.

### Protected prompt and context content

- Keep production prompt text and repository-defined defaults or seeds for system `config/ai/context.d/*` and user or agent account `~/context.d/*` in `gateway/src/prompts/**`.
- Treat `gateway/src/prompts/**` as read-only unless the user explicitly requests a prompt or standing-context content change.
- Do not edit prompt or seeded `context.d` content to work around runtime, protocol, tool-discovery, or UI behavior. Fix the owning implementation boundary.
- If a task appears to require changing protected prompt or context content without explicit authorization, stop and ask first.

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
├── packages/gsv/  # Public TypeScript client and protocol
├── web/           # Desktop shell and embedded app host
├── host/
│   ├── apps/      # Rust CLI, Desktop, and machine applications
│   ├── helpers/   # Isolated transcription and gesture processes
│   └── crates/    # Shared host transport, configuration, and IPC contracts
├── adapters/      # External-platform Worker implementations and test channel
├── extension/     # Browser target
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

- Managed service implementations: validate them in their owning deployment repository against `packages/gsv/src/services/`
- Gateway: `cd gateway && npx tsc --noEmit && npm run test:run`
- Web: `cd web && npm run check && npm run test:run && npm run build`
- Desktop and transcription helper: `cd host && cargo fmt --package desktop --package transcriber --check && cargo test --package desktop --package transcriber && cargo clippy --package desktop --package transcriber --all-targets -- -D warnings`
- Gesture helper and protocol: `cd host && cargo fmt --package gestures --package gesture-protocol --check && cargo test --package gestures --package gesture-protocol && cargo clippy --package gestures --package gesture-protocol --all-targets -- -D warnings`
- Public SDK: `npm run gsv:check && npm test --workspace packages/gsv`
- CLI: `cd host && cargo fmt --package gsv --check && cargo test --package gsv`
- Machine: `cd host && cargo fmt --package machine --check && cargo test --package machine`
- ripgit: `cd ripgit && npm test`
- Browser extension: `cd extension && npm run check && npm run test:run && npm run build`
- WhatsApp: `cd adapters/whatsapp && npx tsc --noEmit`
- Discord, Telegram, Slack, or test adapter: `cd adapters/<name> && npm run typecheck`

Protocol or client changes may affect gateway, web, CLI, devices, and adapters even when only one type definition changed. Validate each actual consumer.

## Deployment model

- Gateway code: `cd gateway && npm run deploy`
- Web code: build `web`, then deploy the gateway that serves the resulting assets.
- Adapter code: deploy the affected adapter worker.
- ripgit code: deploy that worker separately.
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
- Rust CLI, daemon, Desktop, and local IPC: `docs/architecture/rust-host-applications.md`
- Syscalls and protocol: `docs/reference/syscalls.md` and `docs/reference/websocket-protocol.md`
- Web product and app design: `engineering/builtin-app-design.md`

Read the relevant detailed guide before changing that subsystem; do not duplicate its full policy here.
