# gateway-os TODO

Everything that needs to happen to get gateway-os functional.
Items are grouped by subsystem and ordered roughly by dependency.

---

## Next slice (recommended start)

Consolidated plan for identity + auth work:

- [x] **Phase 0: machine token primitives**
  - token store in kernel SQLite
  - token validation wired into `sys.connect` (driver/service/user)
  - password auth retained for interactive user login
  - remaining: audit metadata updates (`last_used_at` + client info)
- [x] **Phase 2A: identity links + `adapter.*` transport plumbing**
  - done: inbound adapter resolution + `adapter.send` / `adapter.status`
  - done: manual `sys.link` / `sys.unlink` / `sys.link.list` syscalls
  - done: CLI commands + kernel unit tests for link management
- [x] **Phase 2B: pairing UX**
  - done: unknown DM identity challenge + `sys.link.consume`
  - done by design: no inbound replay after linking (first message is intentionally dropped)

## Unix identity model (`/etc/passwd`, `/etc/shadow`, `/etc/group`)

Use classic Linux flat-file formats so LLM agents can read/parse them naturally.
The `shell` field in `/etc/passwd` is `/bin/init` — the user's persistent root AI process.
Auth data lives in kernel SQLite (`AuthStore`), exposed at `/etc/*` via GsvFs virtual paths.
No R2 round-trips for auth, no credentials in object storage.

- [x] Define the in-memory types for passwd entries (uid, gid, username, home, shell)
- [x] Define the in-memory types for shadow entries (username, hashed password)
- [x] Define the in-memory types for group entries (group name, gid, member list)
- [x] Write parser: `/etc/passwd` colon-delimited format → typed entries
- [x] Write parser: `/etc/shadow` colon-delimited format → typed entries
- [x] Write parser: `/etc/group` colon-delimited format → typed entries
- [x] Write serializer for each (typed entries → flat-file format, for writes)
- [x] `AuthStore` class: SQLite tables for passwd, shadow, groups
- [x] `AuthStore.bootstrap()` — seed root user + default groups on first boot
- [x] `AuthStore.authenticate()` — verify credentials from SQLite (no R2)
- [x] `AuthStore.serialize*()` — produce flat-file format for virtual FS reads
- [x] `AuthStore.import*()` — parse flat-file writes back into SQLite
- [x] `AuthStore.uidToName()` / `gidToName()` — name resolution for ls/stat
- [x] Wire into `KernelContext`, initialize in Kernel DO
- [x] GsvFs routes `/etc/passwd`, `/etc/shadow`, `/etc/group` as virtual paths (read/write)
- [x] `/etc/shadow` read restricted to uid 0, stat shows mode 0640
- [x] `sys.connect` uses `AuthStore` instead of R2 for auth
- [x] Create `/root/` directory marker on first boot

## Credential model (passwords + machine tokens)

Passwords are for humans (interactive login). Tokens are for non-interactive clients
(nodes, services/channels, CI/automation) and must be revocable/rotatable.

- [x] `auth_tokens` table in kernel SQLite with lifecycle metadata:
  - `token_id`, `uid`, `kind` (`node` | `service` | `user`), `label`
  - `token_hash`, `token_prefix`, `created_at`, `last_used_at`
  - `expires_at`, `revoked_at`, `revoked_reason`
  - optional binding: `allowed_role`, `allowed_device_id`
- [x] `AuthStore.issueToken(...)` / `authenticateToken(...)` / `revokeToken(...)` / `listTokens(uid?)`
- [x] `sys.connect` token auth path:
  - driver role: require token (except explicit setup/dev override)
  - service role: require token
  - user role: password or token
  - enforce role/device binding when configured
- [x] `sys.token.create` / `sys.token.list` / `sys.token.revoke` syscalls
- [ ] Audit metadata updates on successful token use (`last_used_at`, client info)

## Identity links (channel → uid mapping)

Map external channel identities to internal UIDs. Stored in kernel SQLite.

- [x] `identity_links` table:
  - `(adapter TEXT, account_id TEXT, actor_id TEXT, uid INTEGER, created_at INTEGER, linked_by_uid INTEGER, metadata_json TEXT, PRIMARY KEY (adapter, account_id, actor_id))`
- [x] `link(adapter, accountId, actorId, uid)` / `unlink(...)` / `resolveUid(...)` / `list(uid?)` in `IdentityLinkStore`
- [x] Pairing flow (Phase 2B base): unknown DM identity returns challenge prompt
- [x] `link_challenges` table/store for one-time code + expiry + use tracking
- [x] `sys.link.consume` syscall — redeem code and create link for current user
- [x] `sys.link` / `sys.unlink` / `sys.link.list` management syscalls (uid 0 or self)
- [x] Decision: do not queue/replay first inbound message after link completion

## Group-based capabilities (kernel SQLite)

Capabilities are NOT hardcoded — root can modify them. Stored in kernel DO SQLite.

- [x] Design the `group_capabilities` table schema
- [x] Seed default capabilities on first boot:
  - gid 0 (root) → `["*"]`
  - gid 100 (users) → `["fs.*", "shell.*", "proc.*", "sched.*", "sys.config.get", "sys.config.set", "sys.token.create", "sys.token.list", "sys.token.revoke", "sys.link", "sys.unlink", "sys.link.list", "sys.link.consume"]`
  - gid 101 (drivers) → `["fs.*", "shell.*"]`
  - gid 102 (services) → `["adapter.*"]`
- [x] Implement `resolve(gids)` — union of all capabilities across groups
- [x] Implement `hasCapability(capabilities, syscall)` — matching logic (`*`, `domain.*`, exact)
- [x] Implement `grant` / `revoke` / `list` with format validation
- [x] Wire capabilities into `ConnectResult.identity.capabilities` during `sys.connect`

## R2FS permission model upgrade (uid/gid/mode)

Merged into unified `GsvFs`. The R2 permission logic now lives in `GsvFs` alongside virtual paths.

- [x] `customMetadata`: `uid`, `gid`, `mode` (octal string)
- [x] `GsvFs` constructor accepts `ProcessIdentity` + optional kernel registries
- [x] `canRead()` / `canWrite()` — check mode bits, uid 0 bypasses
- [x] `write()` stamps `uid`/`gid`/`mode` on new files
- [x] `edit()` and `delete()` use `checkMode()`
- [x] `chmod(path, mode)` — owner or root only
- [x] `chown(path, uid, gid)` — uid 0 only
- [x] First-boot `/etc/*` files: passwd/group `644`, shadow `640`

## `sys.connect` handler (kernel)

- [x] Read `/etc/passwd` and `/etc/shadow` from R2, authenticate
- [x] Build `ConnectionIdentity` with resolved capabilities
- [x] Handle first-boot, setup mode, reconnect
- [x] Handle driver + service connections
- [x] Return `ConnectResult`, reject pre-connect syscalls, capability check per req
- [x] On successful user connect: ensure user's init process exists (`ProcessRegistry.ensureInit`)
- [ ] Read user's `shell` field from `/etc/passwd` — if `/bin/init`, spawn/connect to init process

## Routing table (`kernel/routing.ts`)

Hibernate-safe routing for in-flight device-routed syscalls. SQLite-backed, per-entry
expiry via agents SDK `schedule()`.

- [x] `RoutingTable` class with `init`, `register`, `consume`, `expire`
- [x] `failForDevice` / `failForConnection` / `failForProcess` cleanup
- [ ] Unit tests

## Kernel syscall dispatcher (`kernel/dispatch.ts`)

Switch-based. `target` extracted and stripped at dispatch boundary.
Routable domains: `fs`, `shell`. Kernel-internal: `proc`, `sys`, `sched`, `adapter`.

- [x] `dispatch(frame, origin, ctx, deps)` → `DispatchResult`
- [x] Target extraction → device routing → routing table registration
- [x] Exhaustive switch over all syscalls
- [x] Native `fs.*` handlers wired

## Kernel DO wiring (`kernel/do.ts`)

- [x] `RoutingTable` + `ProcessRegistry` instances
- [x] `handleReq` → `dispatch()`, `handleRes` → routing table consumption
- [x] `recvFrame(processId, frame)` RPC for Process DO → Kernel
- [x] `onClose` cleanup, `onRouteExpired` schedule callback
- [ ] Use `scheduleEvery` for periodic device heartbeat checks (future)

## Process registry (kernel SQLite)

Kernel tracks all alive processes. Process kind is derived from the processId convention:
`init:{uid}` = persistent root agent, `task:{uuid}` = ephemeral task, `cron:{jobId}` = cron job.

- [x] `processes` table with `process_id`, `parent_pid`, `uid`, `gid`, `gids`, `username`, `home`, `state`, `label`, `created_at`
- [x] `spawn(processId, identity, { parentPid?, label? })` — insert record
- [x] `getIdentity(processId)` — look up ProcessIdentity
- [x] `kill(processId)` / `setState(processId, state)` / `list(uid?)` / `children(parentPid)`
- [x] `getInit(uid)` / `ensureInit(identity)` — init process helpers
- [ ] Unit tests

## Init process lifecycle

Every user has a persistent "init" process (`init:{uid}`) — their root AI agent.
All messages from any channel converge to the user's init process. The init process is
the equivalent of a login shell in Linux.

- [ ] Spawn init process on user creation (setup mode / `sys.useradd`)
- [ ] On `sys.connect` for user role: ensure init exists, track which connection/channel the user is on
- [ ] Init process loads shared identity from user's home dir (SOUL.md, etc.)
- [ ] Init process can spawn child processes for tasks via `proc.spawn` through the kernel
- [ ] When cron fires, kernel spawns `cron:{jobId}` as child of user's init

## Response routing

Processes produce output; the kernel routes it to the right place based on context.

- [x] `run_routes` table keyed by `runId` with route kind (`connection` | `adapter`) + TTL
- [x] Capture route on `proc.send` from WS connections
- [x] Capture route on adapter inbound -> `proc.send`
- [x] Route process `chat.*` signals by `runId` (not `lastInboundContext`)
- [x] Cleanup route on `chat.complete` and on connection close
- [ ] Add integration tests for run-route delivery/fallback behavior (TTL/store tests done)

## Conversation archival

Active conversation is process RAM (SQLite in DO). Archives go to R2 filesystem.

- [ ] Archive path convention: `/var/sessions/{username}/{processId}/{sessionId}.jsonl.gz`
- [ ] `proc.reset` archives current conversation to R2, starts fresh in the same process
- [ ] `proc.kill` archives before destroying the Process DO
- [ ] Ephemeral processes (task/cron) auto-archive on completion, then kernel destroys the DO
- [ ] Init process periodically compacts: summarize old messages, flush full transcript to R2
- [ ] Any process can `fs.read` archived conversations to load context
- [ ] Create `/var/sessions/` directory structure on first boot / user creation

## Syscall domain: `shell.*` (device commands)

Replaces old `proc.*` for device-level shell execution. Always routable (requires `target`).

- [x] `shell.exec` — execute a command on a device
- [x] `shell.signal` — send signal to running shell command
- [x] `shell.list` — list running shell commands on a device
- [x] Types in `syscalls/shell.ts`
- [x] Constants in `syscalls/constants.ts`
- [x] Dispatch wired (device routing + native `shell.exec` via `just-bash`)
- [x] Native driver: unified `GsvFs` (R2 + virtual `/proc`, `/dev`, `/sys` mounts)
- [x] Custom bash commands: `whoami`, `id`, `hostname`, `uname`, `chown`, `chmod`, `ps`
- [x] Network access: `curl`/`wget` enabled via `dangerouslyAllowFullInternetAccess` (Workers are sandboxed)
- [x] Shell limits/timeout/network read from `ConfigStore` at runtime
- [x] `processInfo` wired with real uid/gid from identity
- [x] Deleted obsolete `r2-bash-fs.ts` (fully replaced by `GsvFs`)
- [x] Custom `ls` command: uses real mode bits, uid/gid from `statExtended`, resolves names via `AuthStore`
- [x] Custom `stat` command: uses real mode/uid/gid, supports `-c FORMAT`
- [x] Name cache (`uidToName`/`gidToName`) reads directly from `AuthStore` (no FS round-trip)

## Syscall domain: `proc.*` (OS process management)

Kernel-internal process management. Not routable (no `target`).

- [x] `proc.spawn` — create a child process
- [x] `proc.kill` — archive + destroy a process
- [x] `proc.list` — list processes (own or all for root)
- [x] `proc.send` — send a message to a process (defaults to caller's init)
- [x] `proc.history` — read conversation history from a process
- [x] `proc.reset` — archive + clear conversation, process stays alive
- [x] Types in `syscalls/proc.ts`
- [x] Constants in `syscalls/constants.ts`
- [x] Implement `proc.spawn` handler in dispatcher
- [x] Implement `proc.kill` handler in dispatcher
- [x] Implement `proc.list` handler in dispatcher
- [x] Implement `proc.send` handler — deliver message to process, trigger agent loop
- [x] Implement `proc.history` handler — read from process DO
- [x] Implement `proc.reset` handler — archive + clear process conversation

## Native FS driver (`drivers/native/fs.ts`)

- [x] `handleFsRead` / `handleFsWrite` / `handleFsEdit` / `handleFsDelete` / `handleFsSearch`
- [ ] Unit tests

## Process DO skeleton (`process/do.ts`)

- [x] `Process` class extending `Agent<Env>`
- [x] `recvFrame(frame)` RPC method (res/req/sig handling)
- [x] SQLite: `pending_tool_calls` + `process_meta` tables
- [x] `registerToolCall` / `resolveToolCall` / `failToolCall` / `getToolResults`
- [x] `dispatchSyscall` — send req to kernel, handle sync/async receipt
- [x] Prompt assembly: system prompt (ConfigStore) + `~/CONSTITUTION.md` + `~/context.d/*.md`
- [x] Response routing delegated to kernel `run_routes` (no process-local `lastInboundContext`)
- [x] Agent loop: LLM call → tool dispatch → result collection → continue
- [x] Export + bind in `wrangler.jsonc` / `index.ts`

## Process DO — agent loop

- [x] Message history storage (SQLite-backed via `ProcessStore`)
- [x] Agent loop (`continueAgentLoop`: LLM call → tool dispatch → result collection → continue)
- [x] `proc.send` — inject user message and start agent loop (or queue if busy)
- [x] `proc.reset` — archive messages to R2, clear conversation
- [x] `proc.history` — return message history with limit/offset
- [x] Message queue: FIFO with tool-result-boundary injection (drain queue before next LLM call)
- [x] Signal delivery: `chat.text`, `chat.tool_call`, `chat.tool_result`, `chat.complete`
- [x] Run state: per-run cache of ai.config, ai.tools, assembled prompt
- [x] `kernelRpc` helper for synchronous kernel calls (ai.config, ai.tools)
- [x] Reverse tool map: LLM tool name → syscall name
- [ ] Token-level streaming (`streamSimple` + `chat.chunk` deltas)
- [ ] Context overflow handling / compaction
- [ ] Max turns / loop safety limits

## User onboarding flow

First-boot experience when the system has no users. Setup mode walks through configuration.

- [x] Detect setup mode in kernel auth state (root locked and no non-root users)
- [x] `sys.setup` one-shot syscall (pre-connect only in setup mode):
  - create first user + home dir marker
  - set first-user password
  - optional root password (or keep root locked)
  - optional initial AI config (`provider`, `model`, `api_key`)
  - optional first node token issuance (device-bound)
- [x] `sys.connect` setup-mode rejection details: `{ setupMode: true, next: "sys.setup" }`
- [ ] Full interactive onboarding flow: timezone + richer validation + confirmations
- [x] On completion: spawn/init first user process immediately

## Device registry & driver routing

- [x] `DeviceRegistry` class (SQLite: `devices` + `device_access`)
- [x] Register, online/offline, ACL, canHandle, findDevice
- [x] Device routing via dispatcher + routing table
- [x] Fail routing entries on disconnect

## Adapter integration

Wire adapter workers as kernel endpoints. Adapters deliver inbound activity to the kernel,
kernel resolves uid via identity links, routes to user processes, and sends outbound replies via adapter bindings.

- [x] Re-enable `GatewayEntrypoint` Service Binding RPC bridge (`serviceFrame`) for adapter service calls
- [x] `adapter.send` handler: route outbound messages to adapter via Service Binding RPC
- [x] `adapter.status` handler: return last-known status with optional live refresh
- [x] Adapter inbound flow: adapter → kernel → `resolveUid(adapter, accountId, actorId)` → process routing
- [x] Handle unknown DM identity (Phase 2B base): issue pairing challenge code
- [x] Track adapter account status updates in kernel store and emit `adapter.status` signal
- [x] Explicit adapter/account lifecycle: native `adapter.connect` / `adapter.disconnect` across adapters
- [ ] Group/multi-user policy refinements (membership/authz semantics per adapter surface)

## Scheduler (cron)

Uses agents SDK `schedule()` / `scheduleEvery()`.

- [ ] Port `CronStore` to kernel DO SQLite
- [ ] Port `CronService` (schedule evaluation, job execution)
- [ ] Implement `sched.list`, `sched.add`, `sched.update`, `sched.remove`, `sched.run` handlers
- [ ] Cron execution: spawn `cron:{jobId}` process as child of user's init, run, archive, destroy
- [ ] `scheduleEvery()` for periodic cron evaluation

## Unified filesystem: `GsvFs` (`fs/gsv-fs.ts`)

Single `IFileSystem` implementation used by both `fs.*` syscall handlers and the bash shell driver.
Replaces the old separate `R2FS`, `R2BashFs`, `composeMounts`, and `InMemoryFs` setup.

Routes paths internally:
- `/proc/*` → reads from `ProcessRegistry` (kernel SQLite)
- `/dev/*`  → inline device nodes
- `/sys/*`  → reads/writes `ConfigStore` + `DeviceRegistry` + `CapabilityStore` (kernel SQLite)
- `/*`      → R2 bucket (with uid/gid/mode permission checks)

- [x] Create `GsvFs` class implementing `IFileSystem` with virtual path routing + R2 fallback
- [x] `/proc/{pid}/status`, `/proc/{pid}/identity`, `/proc/self/*` — from `ProcessRegistry`
- [x] `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom`
- [x] `/sys/config/*` — read/write from `ConfigStore`
- [x] `/sys/users/{uid}/*` — per-user config from `ConfigStore`
- [x] `/sys/devices/*` — read-only from `DeviceRegistry`
- [x] `/sys/capabilities/*` — read-only from `CapabilityStore`
- [x] Permission enforcement: root reads/writes all `/sys/`, non-root only own `/sys/users/{uid}/`
- [x] Wire into shell driver (replace `R2BashFs` + `composeMounts` + `InMemoryFs`)
- [x] Wire into `fs.*` syscall handlers (replace `R2FS`)
- [x] `readdir` for virtual directories (`/proc/`, `/sys/`, `/sys/devices/`, etc.)
- [ ] Unit tests

## ConfigStore (`kernel/config.ts`)

SQLite key-value store for runtime config exposed at `/sys/config/*` and `/sys/users/{uid}/*`.
System config is the runtime truth — R2 dotfiles (`/etc/gsv/config`, `~/.config/gsv/config`)
are seed files loaded on first connect (like `sysctl -p` loading `/etc/sysctl.conf`).

- [x] `config_kv` table: `(key TEXT PRIMARY KEY, value TEXT NOT NULL)`
- [x] `get(key)`, `set(key, value)`, `delete(key)`, `list(prefix)`
- [x] `seed(defaults)` — populate defaults on first boot
- [x] Add to `KernelContext`, initialize in Kernel DO alongside other registries
- [x] Explicit `SYSTEM_CONFIG_DEFAULTS` with documented fields (ai, server, shell, process)
- [x] `USER_OVERRIDABLE_PREFIXES` restricts which config keys users can override
- [x] Kernel seeds defaults on init (INSERT OR IGNORE — never overwrites)
- ~~Reconciliation~~ — removed; `/sys/config/*` + `sys.config.set` are the config interfaces, no need for `/etc/gsv/config` dotfile duplication
- [x] `sys.config.get` / `sys.config.set` syscall handlers

## System config (`sys.config.*`)

- [x] `sys.config.get` / `sys.config.set` handlers — thin wrappers around `ConfigStore` + permission checks
- [x] Key-level permission model: root full access; non-root reads `config/*` + own `users/{uid}/*`; writes only `users/{uid}/{overridable}/*`
- [x] Users group granted `sys.config.get` + `sys.config.set` capabilities (fine-grained check in handler)

## File transfer (`fs.transfer`)

Orchestrated binary streaming between R2 and devices. Future work — port from old Transfer protocol.

- [ ] `fs.transfer` syscall types: `{ source: string, destination: string }` with `device:path` format
- [ ] Multi-step handshake: metadata → accept → stream chunks → complete
- [ ] R2 → Device, Device → R2, Device → Device routing
- [ ] Wire binary stream frames for chunk relay
- [ ] Bash command: `transfer` / `cp` with cross-device syntax

## User management syscalls

- [ ] `sys.useradd` — create passwd/shadow/group entries, home dir, init process, `/var/sessions/{user}/`
- [ ] `sys.userdel` — remove user entries, kill init + children (uid 0 only)
- [ ] `sys.usermod` — modify user groups, shell, home (uid 0 only)
- [ ] `sys.passwd` — change password (own password or any as uid 0)
- [ ] `sys.groupadd` / `sys.groupdel` — manage groups (uid 0 only)
- [ ] `sys.cap.list` / `sys.cap.grant` / `sys.cap.revoke` — manage group capabilities (uid 0 only)
- [x] `sys.link` / `sys.unlink` / `sys.link.list` — manage identity links (uid 0 or self)

## Binary stream frames

- [ ] Binary frame layout: `[fd: u16] [flags: u8] [payload: bytes]`
- [ ] `parseBinaryFrame` / `buildBinaryFrame`
- [ ] fd allocation per connection
- [ ] Wire in `kernel.onMessage` for non-string messages
- [ ] Stream routing: `fd → destination` map

## Signal infrastructure

### Kernel → client (outbound)
- [ ] `chat.chunk` — LLM token streaming
- [x] `chat.text` — assistant text at tool-call boundary (pre-dispatch)
- [x] `chat.tool_call` — tool dispatched
- [x] `chat.tool_result` — tool completed
- [x] `chat.complete` — run finished (final text + usage)
- [ ] `process.exit` — process terminated
- [ ] `device.status` — device online/offline
- [ ] `channel.status` — channel connected/disconnected

### Client → kernel (inbound)
- [ ] `device.heartbeat` — periodic health check from device

### Plumbing
- [x] `broadcastToUid(uid, signal, payload)` in kernel
- [x] Process → Kernel signal relay (`recvFrame` handles `sig` frames from processes)
- [ ] Inbound signal routing in `onMessage`
- [ ] Wire LLM streaming, process lifecycle events

## Worker entrypoint & routing

- [x] Update `src/index.ts` fetch handler
- [x] Wire `/ws`, `/health`, `/media/*`
- [ ] Port `GatewayEntrypoint` Service Binding RPC for channel inbound
- [x] Export Process DO + Kernel DO in `wrangler.jsonc`

## CLI updates (Rust)

- [x] Update frame types: `method` → `call`, add `sig` frame, `session` domain → `proc` domain
- [x] Update connect flow: `sys.connect` with new `ConnectResult`
- [x] Add auth fields in `ConnectArgs.auth` (`username`, `password`, `token`)
- [x] Clarify current behavior: kernel auth treats `token` as alternate credential input (`token ?? password`) and validates against `/etc/shadow`
- [ ] Design first-class token model (issuance, rotation, revoke, scope) separate from password auth
- [x] Add dedicated token management syscalls once first-class token model exists
- [x] Device commands use `shell.*` domain instead of `proc.*`
- [x] `gsv shell` interactive REPL (connects as user, sends `shell.exec`)
- [x] `gsv node` connects as driver with `implements: ["fs.*", "shell.*"]`
- [x] `gsv auth setup` command for first-time kernel onboarding (`sys.setup`)
- [x] `gsv auth token create|list|revoke` commands
- [ ] `gsv node enroll` flow (password once → issue node token → store locally)
- [ ] `gsv node` runtime auth policy:
  - prefer token always
  - password fallback only in explicit setup/dev mode
- [ ] Update binary frame format
