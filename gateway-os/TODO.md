# gateway-os TODO

Everything that needs to happen to get gateway-os functional.
Items are grouped by subsystem and ordered roughly by dependency.

---

## Unix identity model (`/etc/passwd`, `/etc/shadow`, `/etc/group`)

Use classic Linux flat-file formats so LLM agents can read/parse them naturally.
The `shell` field in `/etc/passwd` is `/bin/init` — the user's persistent root AI process.

- [x] Define the in-memory types for passwd entries (uid, gid, username, home, shell)
- [x] Define the in-memory types for shadow entries (username, hashed password)
- [x] Define the in-memory types for group entries (group name, gid, member list)
- [x] Write parser: `/etc/passwd` colon-delimited format → typed entries
- [x] Write parser: `/etc/shadow` colon-delimited format → typed entries
- [x] Write parser: `/etc/group` colon-delimited format → typed entries
- [x] Write serializer for each (typed entries → flat-file format, for writes)
- [x] Implement first-boot provisioning: create `/etc/passwd` with `root:x:0:0:root:/root:/bin/init`
- [x] Implement first-boot provisioning: create `/etc/shadow` with root entry (token hash or locked)
- [x] Implement first-boot provisioning: create `/etc/group` with `root:x:0:root` and default groups
- [ ] Create `/root/` directory marker on first boot

## Identity links (channel → uid mapping)

Map external channel identities to internal UIDs. Stored in kernel SQLite.

- [ ] `identity_links` table: `(channel TEXT, external_id TEXT, uid INTEGER, PRIMARY KEY (channel, external_id))`
- [ ] `linkIdentity(channel, externalId, uid)` — create mapping
- [ ] `unlinkIdentity(channel, externalId)` — remove mapping
- [ ] `resolveUid(channel, externalId)` → `uid | null` — lookup
- [ ] `listLinks(uid?)` — list all links, optionally filtered by user
- [ ] Pairing flow: when channel delivers message from unknown identity, respond with auth challenge
- [ ] `sys.link` / `sys.unlink` syscalls for managing identity links (uid 0 or self)

## Group-based capabilities (kernel SQLite)

Capabilities are NOT hardcoded — root can modify them. Stored in kernel DO SQLite.

- [x] Design the `group_capabilities` table schema
- [x] Seed default capabilities on first boot:
  - gid 0 (root) → `["*"]`
  - gid 100 (users) → `["fs.*", "shell.*", "proc.*", "sched.*"]`
  - gid 101 (drivers) → `["fs.*", "shell.*"]`
  - gid 102 (services) → `["ipc.*"]`
- [x] Implement `resolve(gids)` — union of all capabilities across groups
- [x] Implement `hasCapability(capabilities, syscall)` — matching logic (`*`, `domain.*`, exact)
- [x] Implement `grant` / `revoke` / `list` with format validation
- [x] Wire capabilities into `ConnectResult.identity.capabilities` during `sys.connect`

## R2FS permission model upgrade (uid/gid/mode)

- [x] `customMetadata`: `uid`, `gid`, `mode` (octal string)
- [x] `R2FS` constructor accepts `ProcessIdentity`
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
- [ ] On successful user connect: ensure user's init process exists (`ProcessRegistry.ensureInit`)
- [ ] Read user's `shell` field from `/etc/passwd` — if `/bin/init`, spawn/connect to init process

## Routing table (`kernel/routing.ts`)

Hibernate-safe routing for in-flight device-routed syscalls. SQLite-backed, per-entry
expiry via agents SDK `schedule()`.

- [x] `RoutingTable` class with `init`, `register`, `consume`, `expire`
- [x] `failForDevice` / `failForConnection` / `failForProcess` cleanup
- [ ] Unit tests

## Kernel syscall dispatcher (`kernel/dispatch.ts`)

Switch-based. `target` extracted and stripped at dispatch boundary.
Routable domains: `fs`, `shell`. Kernel-internal: `proc`, `sys`, `sched`, `ipc`.

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

- [ ] Track `lastInboundContext` per user in kernel (stored per init process):
  - `{ type: "channel", channel, accountId, peer }` — last message was from a channel
  - `{ type: "connection", uid }` — last message was from a WS connection
- [ ] Channel inbound → update `lastInboundContext`, deliver to init process
- [ ] WS connection inbound → update `lastInboundContext`, deliver to init process
- [ ] Process output routing:
  - If `lastInboundContext.type === "channel"` → route only to that specific channel/peer
  - If `lastInboundContext.type === "connection"` → broadcast to all WS connections for that uid
- [ ] Child process output routes back to parent (init), which decides delivery

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
- [x] Native driver: `R2BashFs` (R2-backed `IFileSystem`), virtual `/proc` + `/dev` mounts
- [x] Custom bash commands: `whoami`, `id`, `hostname`, `uname`, `chown`, `chmod`, `ps`

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
- [ ] Implement `proc.spawn` handler in dispatcher
- [ ] Implement `proc.kill` handler in dispatcher
- [ ] Implement `proc.list` handler in dispatcher
- [ ] Implement `proc.send` handler — deliver message to process, trigger agent loop
- [ ] Implement `proc.history` handler — read from process DO
- [ ] Implement `proc.reset` handler — archive + clear process conversation

## Native FS driver (`drivers/native/fs.ts`)

- [x] `handleFsRead` / `handleFsWrite` / `handleFsEdit` / `handleFsDelete` / `handleFsSearch`
- [ ] Unit tests

## Process DO skeleton (`process/do.ts`)

- [x] `Process` class extending `Agent<Env>`
- [x] `recvFrame(frame)` RPC method (res/req/sig handling)
- [x] SQLite: `pending_tool_calls` + `process_meta` tables
- [x] `registerToolCall` / `resolveToolCall` / `failToolCall` / `getToolResults`
- [x] `dispatchSyscall` — send req to kernel, handle sync/async receipt
- [ ] Load shared identity files (SOUL.md) from user's home dir on init
- [ ] Track `lastInboundContext` for response routing
- [ ] Agent loop: LLM call → tool dispatch → result collection → continue
- [x] Export + bind in `wrangler.jsonc` / `index.ts`

## Process DO — agent loop (port from Session)

- [ ] Port message history storage from old Session DO (SQLite-backed)
- [ ] Port agent loop (model call → tool dispatch → model call cycle)
- [ ] Implement `proc.send` — inject a user message and start the agent loop
- [ ] Implement `proc.reset` — archive messages, create new session id
- [ ] Implement `proc.history` — return message history with limit/offset
- [ ] Wire up LLM token streaming via `sig` frames (chat.chunk, chat.complete)

## User onboarding flow

First-boot experience when the system has no users. Setup mode walks through configuration.

- [ ] Detect setup mode: `/etc/passwd` doesn't exist or root shadow is locked
- [ ] Onboarding steps: timezone → username/password → optional model config
- [ ] Model config stored as user-private file (e.g. `/home/{user}/.config/gsv.yaml`)
- [ ] On completion: create user, create home dir, spawn init process, set password
- [ ] Exit setup mode (root shadow no longer locked)

## Device registry & driver routing

- [x] `DeviceRegistry` class (SQLite: `devices` + `device_access`)
- [x] Register, online/offline, ACL, canHandle, findDevice
- [x] Device routing via dispatcher + routing table
- [x] Fail routing entries on disconnect

## IPC (channel integration)

Wire channel workers as IPC endpoints. Channels deliver messages to the kernel,
kernel resolves uid via identity links, routes to user's init process.

- [ ] On service `sys.connect`: register channel in channel registry
- [ ] `ipc.send` handler: route outbound messages to channel via Service Binding RPC
- [ ] `ipc.status` handler: query channel status
- [ ] Channel inbound flow: channel → kernel → `resolveUid(channel, externalId)` → init process
- [ ] Handle unknown external identity: initiate pairing flow
- [ ] Handle group/multi-user channels: per-sender routing via identity links

## Scheduler (cron)

Uses agents SDK `schedule()` / `scheduleEvery()`.

- [ ] Port `CronStore` to kernel DO SQLite
- [ ] Port `CronService` (schedule evaluation, job execution)
- [ ] Implement `sched.list`, `sched.add`, `sched.update`, `sched.remove`, `sched.run` handlers
- [ ] Cron execution: spawn `cron:{jobId}` process as child of user's init, run, archive, destroy
- [ ] `scheduleEvery()` for periodic cron evaluation

## System config (`sys.config.*`)

- [ ] Config storage (R2 at `/etc/gsv/config` or similar)
- [ ] `sys.config.get` / `sys.config.set` handlers
- [ ] Port config schema and defaults from old gateway

## User management syscalls

- [ ] `sys.useradd` — create passwd/shadow/group entries, home dir, init process, `/var/sessions/{user}/`
- [ ] `sys.userdel` — remove user entries, kill init + children (uid 0 only)
- [ ] `sys.usermod` — modify user groups, shell, home (uid 0 only)
- [ ] `sys.passwd` — change password (own password or any as uid 0)
- [ ] `sys.groupadd` / `sys.groupdel` — manage groups (uid 0 only)
- [ ] `sys.cap.list` / `sys.cap.grant` / `sys.cap.revoke` — manage group capabilities (uid 0 only)
- [ ] `sys.link` / `sys.unlink` — manage identity links (uid 0 or self)

## Binary stream frames

- [ ] Binary frame layout: `[fd: u16] [flags: u8] [payload: bytes]`
- [ ] `parseBinaryFrame` / `buildBinaryFrame`
- [ ] fd allocation per connection
- [ ] Wire in `kernel.onMessage` for non-string messages
- [ ] Stream routing: `fd → destination` map

## Signal infrastructure

### Kernel → client (outbound)
- [ ] `chat.chunk` — LLM token streaming
- [ ] `chat.complete` — LLM response finished
- [ ] `process.exit` — process terminated
- [ ] `device.status` — device online/offline
- [ ] `channel.status` — channel connected/disconnected

### Client → kernel (inbound)
- [ ] `device.heartbeat` — periodic health check from device

### Plumbing
- [ ] `sendSignal(connection, signal, payload)` in kernel
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
- [x] Add auth: password/token in `ConnectArgs.auth`
- [x] Device commands use `shell.*` domain instead of `proc.*`
- [x] `gsv shell` interactive REPL (connects as user, sends `shell.exec`)
- [x] `gsv node` connects as driver with `implements: ["fs.*", "shell.*"]`
- [ ] Update binary frame format
