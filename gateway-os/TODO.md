# gateway-os TODO

Everything that needs to happen to get gateway-os functional.
Items are grouped by subsystem and ordered roughly by dependency.

---

## Unix identity model (`/etc/passwd`, `/etc/shadow`, `/etc/group`)

Use classic Linux flat-file formats so LLM agents can read/parse them naturally.

- [x] Define the in-memory types for passwd entries (uid, gid, username, home, shell)
- [x] Define the in-memory types for shadow entries (username, hashed password)
- [x] Define the in-memory types for group entries (group name, gid, member list)
- [x] Write parser: `/etc/passwd` colon-delimited format → typed entries
- [x] Write parser: `/etc/shadow` colon-delimited format → typed entries
- [x] Write parser: `/etc/group` colon-delimited format → typed entries
- [x] Write serializer for each (typed entries → flat-file format, for writes)
- [x] Implement first-boot provisioning: if `/etc/passwd` doesn't exist in R2, create it with `root:x:0:0:root:/root:/bin/sh`
- [x] Implement first-boot provisioning: create `/etc/shadow` with root entry (token hash or locked; supports both password and token schemes)
- [x] Implement first-boot provisioning: create `/etc/group` with `root:x:0:root` and default groups (`users`, `drivers`, `services`)
- [ ] Create `/root/` directory marker on first boot

## Group-based capabilities (kernel SQLite)

Capabilities are NOT hardcoded — root can modify them. Stored in kernel DO SQLite.

- [x] Design the `group_capabilities` table schema: `(gid INTEGER, capability TEXT, PRIMARY KEY (gid, capability))`
- [x] Seed default capabilities on first boot:
  - gid 0 (root) → `["*"]`
  - gid 100 (users) → `["fs.*", "session.*", "proc.exec", "proc.list"]`
  - gid 101 (drivers) → `["fs.*", "proc.*"]`
  - gid 102 (services) → `["ipc.*"]`
- [x] Implement `getCapabilitiesForGids(gids: number[]): string[]` — union of all capabilities across groups
- [x] Implement `hasCapability(capabilities, syscall)` — matching logic (`*`, `domain.*`, exact)
- [x] Implement `grantCapability` / `revokeCapability` / `listCapabilities` with format validation
- [ ] Wire capabilities into `ConnectResult.identity.capabilities` during `sys.connect`

## R2FS permission model upgrade (uid/gid/mode)

Replace the current string-based `owner`/`permissions` customMetadata with numeric Unix permissions.

- [x] Change R2 `customMetadata` to store: `uid` (number), `gid` (number), `mode` (octal string, e.g. `"755"`)
- [x] Update `R2FS` constructor to accept `ProcessIdentity` (uid, gid, gids, username, home) instead of `user: string`
- [x] Rewrite `canRead()`: check mode bits — owner read if `uid` matches, group read if `gid` matches any of user's gids, other read otherwise. uid 0 always passes.
- [x] Rewrite `canWrite()`: same logic for write bits. uid 0 always passes.
- [x] Update `write()` to stamp `uid`, `gid`, `mode` on new files (default mode `"644"`)
- [x] Update `edit()` and `delete()` to use the new `canWrite()`
- [x] Add `chmod(path, mode)` method to R2FS (owner or root only)
- [x] Add `chown(path, uid, gid)` method to R2FS (uid 0 only)
- [x] Update first-boot `/etc/*` files to have proper modes: passwd/group `644`, shadow `640`

## `sys.connect` handler (kernel)

The first syscall any connection must make.

- [x] Read `/etc/passwd` and `/etc/shadow` from R2 on connect
- [x] Authenticate: match provided token/password against shadow entry (supports both PBKDF2-SHA-512 passwords and SHA-256 tokens)
- [x] Resolve uid, gid, supplementary gids from passwd + group files
- [x] Build `ConnectionIdentity` with uid, role, resolved capabilities (from group_capabilities table)
- [x] Store identity in `connection.setState()` (Agents SDK attachment)
- [x] Handle first-boot: if `/etc/passwd` doesn't exist, auto-provision and grant uid 0
- [x] Handle setup mode: if root account is locked (`!`), grant root without auth (persists until root sets a password)
- [x] Handle reconnect: same uid + client.id replaces old connection
- [x] Handle driver connections: validate implements patterns, register in device registry (SQLite)
- [x] Handle service connections: validate channel field
- [x] Return `ConnectResult` with identity, available syscalls, available signals
- [x] Reject all other syscalls if connection hasn't completed `sys.connect`
- [x] Capability check on every req frame before dispatch

## Kernel syscall dispatcher

Route incoming `req` frames to the right handler with permission enforcement.

- [ ] Build syscall handler registry: map of `SyscallName → handler function`
- [ ] On `req` frame: look up handler by `frame.call`
- [ ] Permission check 1: connection capability check (does this connection's capabilities cover this syscall domain?)
- [ ] Permission check 2: user permission check (does `uid` have access via group capabilities?)
- [ ] For `fs.*` / `proc.*` syscalls with `target` field: route to the appropriate driver connection via bidirectional req/res
- [ ] For `fs.*` / `proc.*` without `target` (or `target: "gsv"`): handle natively using R2FS
- [ ] Send `res` frame back to caller with result or error
- [ ] Handle unknown syscalls: return `{ code: 404, message: "Unknown syscall" }`
- [ ] Handle timeout for driver-routed syscalls (driver doesn't respond)

## Bidirectional req/res plumbing

Enable the kernel to send `req` frames to drivers and correlate `res` frames back.

- [ ] Implement pending request map: `Map<requestId, { resolve, reject, timeout }>`
- [ ] `sendReq(connection, call, args): Promise<ResponseFrame>` — sends req, returns promise that resolves on matching res
- [ ] On incoming `res` frame in kernel: look up pending request by `id`, resolve/reject the promise
- [ ] Add configurable timeout per pending request (default 60s for tool calls)
- [ ] Clean up pending requests when a connection closes (reject with "disconnected" error)

## Binary stream frames

Replace the old transfer binary hack with fd-multiplexed binary frames.

- [ ] Define binary frame layout: `[fd: u16] [flags: u8] [payload: bytes]`
- [ ] Implement `parseBinaryFrame(data: ArrayBuffer): { fd: number, eof: boolean, payload: Uint8Array }`
- [ ] Implement `buildBinaryFrame(fd: number, payload: Uint8Array, eof?: boolean): ArrayBuffer`
- [ ] Add fd allocation in the kernel: `allocateFd(): number` (simple incrementing counter per connection)
- [ ] Wire binary frame handling in `kernel.onMessage` for non-string messages
- [ ] Implement stream routing: kernel maintains `fd → destination` map, forwards binary frames

## Process DO (agent loop)

Migrate the Session DO into a Process DO with OS semantics.

- [ ] Port message history storage from old Session DO
- [ ] Port agent loop (model call → tool dispatch → model call cycle)
- [ ] Replace direct tool dispatch with kernel syscall routing (Process DO asks kernel to execute syscalls)
- [ ] Add process lifecycle: spawn, running, paused, killed states
- [ ] Add process metadata: pid, uid (owner), gid, started_at, label
- [ ] Implement `session.send` — inject a user message and start the agent loop
- [ ] Implement `session.reset` — archive messages, create new session id
- [ ] Implement `session.history` — return message history with limit/offset
- [ ] Wire up LLM token streaming via binary stream frames (allocate fd, push chunks as `sig` or binary frames)

## Native driver (R2FS syscall handlers)

Wire R2FS methods as the native handler for `fs.*` syscalls when `target` is `"gsv"` or absent.

- [ ] `fs.read` → `R2FS.read()` (already implemented)
- [ ] `fs.write` → `R2FS.write()` (already implemented)
- [ ] `fs.edit` → `R2FS.edit()` (already implemented)
- [ ] `fs.delete` → `R2FS.delete()` (already implemented)
- [ ] `fs.search` → implement text search over R2 objects (list + filter + regex match)
- [ ] Register native handlers in the syscall dispatcher

## Device registry & driver routing

Handle devices (physical machines) connecting as drivers.

- [x] `DeviceRegistry` class backed by kernel SQLite (`devices` + `device_access` tables)
- [x] On driver `sys.connect`: register device with implements list, platform, version
- [x] Device access ACL: `device_access (device_id, gid)` — owner + group-based access, uid 0 bypasses
- [x] `canHandle(deviceId, syscall)` — check if device implements a syscall (reuses `hasCapability` matching)
- [x] `findDevice(syscall, uid, gids)` — find an accessible online device that implements a syscall
- [x] `grantAccess` / `revokeAccess` / `listAccess` for managing device ACLs
- [x] Handle device disconnect: mark offline in registry
- [x] Handle device reconnect: update implements/platform/version, mark online
- [ ] When a syscall targets a device: forward as bidirectional `req` to the driver connection
- [ ] Handle timeout for driver-routed syscalls (driver doesn't respond)
- [ ] Fail pending requests on device disconnect

## IPC (channel integration)

Wire channel workers as IPC endpoints.

- [ ] On service `sys.connect`: register channel in channel registry
- [ ] Implement `ipc.send` handler: route outbound messages to channel via Service Binding RPC or WS
- [ ] Implement `ipc.status` handler: query channel status
- [ ] Handle inbound messages from channels → route to appropriate Process DO
- [ ] Port channel routing logic from old gateway (session key resolution, pairing)

## Scheduler (cron)

Port the cron system.

- [ ] Port `CronStore` to use kernel DO SQLite
- [ ] Port `CronService` (schedule evaluation, job execution)
- [ ] Implement `sched.list`, `sched.add`, `sched.update`, `sched.remove`, `sched.run` handlers
- [ ] Wire cron execution to Process DOs (create/send to a process for each cron trigger)
- [ ] Set up kernel alarm for periodic cron evaluation

## System config (`sys.config.*`)

- [ ] Implement config storage (kernel KV or R2 at `/etc/gsv/config`)
- [ ] Implement `sys.config.get` handler (dotpath traversal)
- [ ] Implement `sys.config.set` handler (uid 0 only, or based on group capabilities)
- [ ] Port config schema and defaults from old gateway

## User management syscalls

- [ ] Add `sys.useradd` — create entry in `/etc/passwd`, `/etc/shadow`, `/etc/group`, create `/home/{user}/`
- [ ] Add `sys.userdel` — remove user entries (uid 0 only)
- [ ] Add `sys.usermod` — modify user groups, shell, home (uid 0 only)
- [ ] Add `sys.passwd` — change password (own password or any as uid 0)
- [ ] Add `sys.groupadd` / `sys.groupdel` — manage groups (uid 0 only)
- [ ] Add `sys.cap.list` / `sys.cap.grant` / `sys.cap.revoke` — manage group capabilities in kernel SQLite (uid 0 only)

## Signal infrastructure

Signals are bidirectional fire-and-forget messages. The kernel both sends and receives them.

### Kernel → client (outbound)
- [ ] `chat.chunk` — LLM token streaming to user connections
- [ ] `chat.complete` — LLM response finished
- [ ] `process.exit` — a Process DO terminated (to user connections)
- [ ] `device.status` — device came online/offline (to user connections)
- [ ] `channel.status` — channel connected/disconnected (to user connections)

### Client → kernel (inbound)
- [ ] `process.exit` — device notifies kernel that a background process exited
- [ ] `device.heartbeat` — periodic health check from device
- [ ] Define additional inbound signals as needed

### Plumbing
- [ ] Implement signal delivery in kernel: `sendSignal(connection, signal, payload)`
- [ ] Implement inbound signal routing in `onMessage` for `sig` frames
- [ ] Wire LLM streaming as `chat.chunk` signals to the attached user connection
- [ ] Wire process lifecycle events as `process.exit` signals

## Worker entrypoint & routing

- [ ] Update `src/index.ts` fetch handler for the new kernel
- [ ] Wire `/ws` to kernel DO
- [ ] Wire `/health` endpoint
- [ ] Wire `/media/*` R2 serving (with auth check)
- [ ] Port `GatewayEntrypoint` Service Binding RPC for channel inbound/status
- [ ] Ensure Process DO is exported and bound in `wrangler.jsonc`

## CLI updates (Rust)

- [ ] Update `cli/src/protocol.rs` frame types: `method` → `call`, `payload` → `data`, add `sig` frame type
- [ ] Update connect flow: send `sys.connect` instead of old `connect` method, handle new `ConnectResult` with identity
- [ ] Add auth: send password/token in `ConnectArgs.auth`, handle rejection
- [ ] Update tool result flow: respond with `res` frame instead of sending `tool.result` req
- [ ] Update binary frame format: new `[fd: u16] [flags: u8] [payload]` layout
