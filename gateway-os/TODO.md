# gateway-os TODO

Everything that needs to happen to get gateway-os functional.
Items are grouped by subsystem and ordered roughly by dependency.

---

## Unix identity model (`/etc/passwd`, `/etc/shadow`, `/etc/group`)

Use classic Linux flat-file formats so LLM agents can read/parse them naturally.

- [ ] Define the in-memory types for passwd entries (uid, gid, username, home, shell)
- [ ] Define the in-memory types for shadow entries (username, hashed password)
- [ ] Define the in-memory types for group entries (group name, gid, member list)
- [ ] Write parser: `/etc/passwd` colon-delimited format → typed entries
- [ ] Write parser: `/etc/shadow` colon-delimited format → typed entries
- [ ] Write parser: `/etc/group` colon-delimited format → typed entries
- [ ] Write serializer for each (typed entries → flat-file format, for writes)
- [ ] Implement first-boot provisioning: if `/etc/passwd` doesn't exist in R2, create it with `root:x:0:0:root:/home/root:/bin/sh`
- [ ] Implement first-boot provisioning: create `/etc/shadow` with root entry (no password or a configured token hash)
- [ ] Implement first-boot provisioning: create `/etc/group` with `root:x:0:root` and default groups (`users`, `drivers`, `services`)
- [ ] Create `/home/root/` directory marker on first boot

## Group-based capabilities (kernel SQLite)

Capabilities are NOT hardcoded — root can modify them. Stored in kernel DO SQLite.

- [ ] Design the `group_capabilities` table schema: `(group_name TEXT, capability TEXT, PRIMARY KEY (group_name, capability))`
- [ ] Seed default capabilities on first boot:
  - `root` → `["*"]`
  - `users` → `["fs.*", "session.*", "proc.exec", "proc.list"]`
  - `drivers` → `["fs.*", "proc.*"]`
  - `services` → `["ipc.*"]`
- [ ] Implement `getCapabilitiesForGids(gids: number[]): string[]` — union of all capabilities across groups
- [ ] Add syscalls for root to manage capabilities: list, add, remove capabilities for a group
- [ ] Wire capabilities into `ConnectResult.identity.capabilities` during `sys.connect`

## R2FS permission model upgrade (uid/gid/mode)

Replace the current string-based `owner`/`permissions` customMetadata with numeric Unix permissions.

- [ ] Change R2 `customMetadata` to store: `uid` (number), `gid` (number), `mode` (octal string, e.g. `"755"`)
- [ ] Update `R2FS` constructor to accept `uid: number`, `gid: number`, `gids: number[]` instead of `user: string`
- [ ] Rewrite `canRead()`: check mode bits — owner read if `uid` matches, group read if `gid` matches any of user's gids, other read otherwise. uid 0 always passes.
- [ ] Rewrite `canWrite()`: same logic for write bits. uid 0 always passes.
- [ ] Update `write()` to stamp `uid`, `gid`, `mode` on new files (default mode `"644"`)
- [ ] Update `edit()` and `delete()` to use the new `canWrite()`
- [ ] Add `chmod(path, mode)` method to R2FS
- [ ] Add `chown(path, uid, gid)` method to R2FS (uid 0 only)
- [ ] Update first-boot `/etc/*` files to have `uid: 0, gid: 0, mode: "644"` (readable by all, writable by root)

## `sys.connect` handler (kernel)

The first syscall any connection must make.

- [ ] Read `/etc/passwd` and `/etc/shadow` from R2 on connect
- [ ] Authenticate: match provided token/password against shadow entry
- [ ] Resolve uid, gid, supplementary gids from passwd + group files
- [ ] Build `ConnectionIdentity` with uid, role, resolved capabilities (from group_capabilities table)
- [ ] Store identity in `connection.setState()` (Agents SDK attachment)
- [ ] Handle first-boot: if `/etc/passwd` doesn't exist, auto-provision and grant uid 0
- [ ] Handle driver connections: validate tools, register in node registry
- [ ] Handle service connections: validate channel, register in channel registry
- [ ] Return `ConnectResult` with identity, available syscalls, available signals
- [ ] Reject all other syscalls if connection hasn't completed `sys.connect`

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

## Node driver registration & tool routing

Handle nodes (physical machines) connecting as drivers.

- [ ] On driver `sys.connect`: register node's tools in a node registry (kernel KV or in-memory map)
- [ ] Build the tool → node resolution logic (which node provides which syscall implementations)
- [ ] When a syscall targets a node: forward as bidirectional `req` to the driver connection
- [ ] Handle node disconnect: fail pending requests, mark node offline in registry
- [ ] Handle node reconnect: re-register tools, reconcile stale state
- [ ] Implement `intoSyscallTool()` to inject `target` param for LLM-facing tool definitions

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

- [ ] Define signal types: `chat.chunk`, `chat.complete`, `process.exit`, `node.status`, `channel.status`
- [ ] Implement signal delivery in kernel: `sendSignal(connection, signal, payload)`
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
