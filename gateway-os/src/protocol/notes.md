# Protocol Design Notes

Decisions made during the gateway → gateway-os refactor.

---

## Frame Types

Four frame types over WebSocket. JSON for control, raw binary for data.

### Text WebSocket frames (JSON)

```typescript
type Frame = RequestFrame | ResponseFrame | SignalFrame;

type RequestFrame = {
  type: "req";
  id: string;
  call: string;
  args?: unknown;
};

type ResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  data?: unknown;
  error?: ErrorShape;
};

type SignalFrame = {
  type: "sig";
  signal: string;
  payload?: unknown;
  seq?: number;
};

type ErrorShape = {
  code: number;
  message: string;
  details?: unknown;
  retryable?: boolean;
};
```

### Binary WebSocket frames (stream data)

Raw bytes, not JSON. Used for file transfers and LLM token streaming.

```
Binary frame layout:
  [fd: u16] [flags: u8] [payload: bytes]

  flags: 0x01 = EOF
```

Stream fds get allocated by a syscall (e.g. `proc.exec` returns `{pid, stdout: 3, stderr: 4}`)
and data flows as binary frames multiplexed by `fd`. JSON `req`/`res` frames handle stream
lifecycle (open, close, error). Binary frames carry the actual data with zero encoding overhead.

---

## Bidirectional req/res

Both sides (kernel ↔ connection) can send `req` and receive `res`. This fixes the old protocol
where kernel → node tool dispatch was modeled as an event + a reverse request correlated by callId.

Driver (node) dispatch now works as proper req/res:

```
User req("fs.read", {path, target: "macbook"}) → Kernel
  Kernel req("fs.read", {path}) → Node(macbook)
  Node res({ok, content}) → Kernel
Kernel res({ok, content}) → User
```

---

## Syscall Domains

Methods are organized by OS subsystem. Each domain maps to a permission scope.

```typescript
type SyscallDomains = {
  // Filesystem
  "fs.read": { args: FsReadArgs; result: FsReadResult };
  "fs.write": { args: FsWriteArgs; result: FsWriteResult };
  "fs.edit": { args: FsEditArgs; result: FsEditResult };
  "fs.delete": { args: FsDeleteArgs; result: FsDeleteResult };
  "fs.search": { args: FsSearchArgs; result: FsSearchResult };

  // Process management
  "proc.exec": { args: ExecArgs; result: { pid: number; stdout: number; stderr: number } };
  "proc.signal": { args: { pid: number; signal: string }; result: { ok: true } };
  "proc.list": { args: {}; result: { processes: ProcessInfo[] } };

  // Session (process-level agent state)
  "session.send": { args: { message: string }; result: SessionSendResult };
  "session.reset": { args: {}; result: ResetResult };
  "session.history": { args: { limit?: number }; result: HistoryResult };

  // System
  "sys.connect": { args: ConnectArgs; result: ConnectResult };
  "sys.config.get": { args: { path?: string }; result: unknown };
  "sys.config.set": { args: { path: string; value: unknown }; result: { ok: true } };

  // Scheduler (cron)
  "sched.list": { args: SchedulerListArgs; result: SchedulerListResult };
  "sched.add": { args: SchedulerAddArgs; result: { job: CronJob } };
  "sched.update": { args: { id: string; patch: CronJobPatch }; result: { job: CronJob } };
  "sched.remove": { args: { id: string }; result: { removed: boolean } };
  "sched.run": { args: { id?: string; mode?: "due" | "force" }; result: SchedulerRunResult };

  // IPC (channels are just IPC endpoints)
  "ipc.send": { args: IpcSendArgs; result: IpcSendResult };
  "ipc.status": { args: { channel: string }; result: ChannelStatus };
};
```

When a syscall has a `target` field (injected by `intoSyscallTool`), the kernel routes it to the
appropriate driver. Without `target` (or `target: "gsv"`), the kernel handles it natively using the
R2 filesystem / built-in implementations.

---

## ConnectionIdentity

Replaces the old static `mode` field (client/node/channel). Established during `sys.connect`.

```typescript
type ConnectionIdentity = {
  uid: string;
  role: "user" | "driver" | "service";
  capabilities: string[];   // ["fs.*", "proc.*", "session.*"]
  node?: string;             // for drivers: which node this represents
  channel?: string;          // for services: which channel
};
```

- **user**: a human client connecting via CLI or UI. Gets routed to a Process DO.
- **driver**: a node providing syscall implementations (filesystem, exec on a physical machine).
- **service**: a channel worker (WhatsApp, Discord) providing IPC.

Capabilities gate which syscall domains a connection can invoke. The kernel checks these on
every incoming `req`.

---

## User Permissions

Orthogonal to connection capabilities. Per-user authorization managed by root/admin.

```typescript
type UserPermissions = {
  uid: string;
  grants: string[];    // ["fs.*", "session.*", "proc.exec"]
  denials: string[];   // ["sys.config.set", "sched.*"]
};
```

Stored in R2 at `/etc/users/{uid}/permissions` or in kernel KV. Root/admin manages these via
`sys.config.set` or a dedicated `sys.users.*` syscall domain.

Defaults:
- **root**: `["*"]` — unrestricted
- **new user**: `["fs.*", "session.*", "proc.exec"]` — basic operations, no config/scheduler/channel management

### Syscall dispatch checks (in order)

1. **Connection capability check**: Does this connection type have access to this syscall domain?
   (drivers can't call `session.*`, users can't call driver-internal syscalls)
2. **User permission check**: Does this authenticated user have permission for this operation?
   (child account can't call `sys.config.set`, admin can do everything)

Both must pass. Failure returns `{ ok: false, error: { code: 403, message: "Permission denied" } }`.

---

## Process DO (née Session DO)

The agent loop + message state lives in a Process DO. This IS the OS process:
- Has a PID (the session key / process identifier)
- Has memory (conversation context, message history)
- Makes syscalls (tool calls routed through the kernel)
- Has lifecycle (spawn, run, reset/kill, archive)

A user connection attaches to a Process DO like a terminal attaching to a shell.
The kernel manages Process DO lifecycle: spawning, routing syscalls, forwarding signals.

---

## R2 Filesystem (R2FS)

Already implemented in `fs/index.ts`. The gateway's native driver for `fs.*` syscalls.

### Hierarchy

```
/                              → root
/home/{uid}/                   → user home directory (default workspace)
/home/{uid}/sessions/          → session/process archives
/etc/                          → system config (system-owned, read-only for non-root)
/etc/users/{uid}/permissions   → per-user permission grants/denials
/media/                        → media files
```

### Permissions

R2 objects carry `customMetadata`:
- `owner`: uid of the file owner (or `"system"`, `"public"`)
- `permissions`: optional flags like `"public-read"`

Write operations check `owner === currentUser`. System-owned files are readable by all but
writable only by root. No hardcoded path blocks — permissions are entirely metadata-driven.

### Content-type handling

On read, the content type from `httpMetadata.contentType` determines the behavior:
- `image/*` → size-guarded (10MB max), read as `arrayBuffer()`, base64 encoded, returned as
  multimodal content blocks `[{type: "text", ...}, {type: "image", data, mimeType}]`
- Text types (`text/*`, `application/json`, etc.) → read as `text()`, supports `offset`/`limit`
  with line numbering
- Other binary → rejected with descriptive error

On write, content type is inferred from file extension and stored in `httpMetadata`.

### Operations

- **read(args: FsReadArgs)** → text (with offset/limit), image (multimodal), or directory listing
- **write(args: FsWriteArgs)** → creates/overwrites, stamps owner + inferred content-type
- **edit(args: FsEditArgs)** → read-modify-write, preserves metadata, enforces match uniqueness
- **delete(args: FsDeleteArgs)** → existence check, owner check, then delete

---

## Exec I/O

Exec output stays buffered (req/res), not streamed. The LLM needs complete output to reason
about it. Long-running process lifecycle is handled via signals (`sig`), not streaming.

---

## What NOT to change

- **JSON for control plane**: Debug-ability in browser devtools and logs outweighs serialization
  gains from binary formats (Cap'n Proto, FlatBuffers, protobuf). Control frames are small and
  infrequent enough that JSON overhead is negligible.
- **Single WebSocket per connection**: Multiplexing via `fd` on one socket is simpler than
  managing multiple connections.
- **Correlation by ID**: The `id` field on req/res is simple, stateless, and works.
