# Syscalls Reference

Syscalls are GSV's stable operation surface. They are invoked over WebSocket request frames, by process tool calls, and by package or adapter code with the required permissions.

Source of truth:

- `gateway/src/syscalls/index.ts`
- `gateway/src/kernel/dispatch.ts`
- `shared/protocol/src/syscalls/*.ts`

## Calling Convention

Every syscall request uses the same frame shape:

```json
{
  "type": "req",
  "id": "uuid",
  "call": "fs.read",
  "args": { "target": "gsv", "path": "/home/alice/context.d" }
}
```

Successful dispatch returns a response frame with `ok: true` and syscall-specific `data`. Protocol, authorization, routing, or thrown handler failures return `ok: false` with `{ "code": number, "message": string }`. Many syscall payloads also carry their own `ok` field for operation-level status, so callers should check both the frame and returned data.

`fs.*` and `shell.exec` are hardware-routable. Their wire args may include `target`; dispatch strips it before the native or device handler receives the syscall.

## Shared Records

These aliases are used below to keep each syscall signature readable.

```ts
type Empty = Record<string, never>;
type OperationError = { ok: false; error: string };
type AiContextProfile =
  | "init" | "task" | "review" | "cron" | "mcp" | "app"
  | `${string}#${string}`;

type ProcessIdentity = {
  uid: number;
  gid: number;
  gids: number[];
  username: string;
  home: string;
  cwd: string;
  workspaceId: string | null;
};

type MediaInput = {
  type: "image" | "audio" | "video" | "document";
  mimeType: string;
  data?: string;
  url?: string;
  filename?: string;
  size?: number;
  duration?: number;
  transcription?: string;
};

type PkgRuntime = "dynamic-worker" | "node" | "web-ui";
type PkgEntrypointSummary = {
  name: string;
  kind: "command" | "http" | "rpc" | "ui";
  description?: string;
  command?: string;
  route?: string;
  icon?: { kind: "builtin"; id: string } | { kind: "svg"; svg: string };
  syscalls?: string[];
  windowDefaults?: { width: number; height: number; minWidth: number; minHeight: number };
};

type PkgSummary = {
  packageId: string;
  scope: { kind: "global" | "user" | "workspace"; uid?: number; workspaceId?: string };
  name: string;
  description: string;
  version: string;
  runtime: PkgRuntime;
  enabled: boolean;
  source: { repo: string; ref: string; subdir: string; resolvedCommit?: string | null; public: boolean };
  entrypoints: PkgEntrypointSummary[];
  bindingNames: string[];
  review: { required: boolean; approvedAt: number | null };
  installedAt: number;
  updatedAt: number;
};

type PkgCatalogEntry = {
  name: string;
  description: string;
  version: string;
  runtime: PkgRuntime;
  source: { repo: string; ref: string; subdir: string; resolvedCommit?: string | null };
  entrypoints: PkgEntrypointSummary[];
  bindingNames: string[];
};

type BootstrapPackageSummary = {
  packageId: string;
  name: string;
  description: string;
  version: string;
  runtime: PkgRuntime;
  enabled: boolean;
  source: { repo: string; ref: string; subdir: string; resolvedCommit: string | null };
  entrypoints: Array<{
    name: string;
    kind: "command" | "ui";
    description?: string;
    command?: string;
    route?: string;
    icon?: string;
    syscalls?: string[];
    windowDefaults?: { width: number; height: number; minWidth: number; minHeight: number };
  }>;
};

type ConnectionIdentity =
  | { role: "user"; process: ProcessIdentity; capabilities: string[] }
  | { role: "driver"; process: ProcessIdentity; capabilities: string[]; device: string; implements: string[] }
  | { role: "service"; process: ProcessIdentity; capabilities: string[]; channel: string };

type OAuthConnectionKind = "ai-provider" | "mcp-server" | "generic";
type OAuthFlowSummary = {
  flowId: string;
  uid: number;
  kind: OAuthConnectionKind;
  provider: string;
  accountKey: string;
  label: string | null;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string | null;
  resource: string | null;
  createdAt: number;
  expiresAt: number;
};
type OAuthAccountSummary = {
  accountId: string;
  uid: number;
  kind: OAuthConnectionKind;
  provider: string;
  accountKey: string;
  label: string | null;
  scope: string | null;
  resource: string | null;
  clientId: string;
  tokenType: string;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  metadata: Record<string, unknown>;
};
type McpTransportType = "auto" | "streamable-http" | "sse";
type McpConnectionState = "not-connected" | "authenticating" | "connecting" | "connected" | "discovering" | "ready" | "failed";
type McpToolSummary = {
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
};
type McpServerSummary = {
  serverId: string;
  uid: number;
  name: string;
  url: string;
  transport: McpTransportType;
  state: McpConnectionState;
  authUrl: string | null;
  error: string | null;
  instructions: string | null;
  capabilities: Record<string, unknown> | null;
  tools: McpToolSummary[];
  resourceCount: number;
  promptCount: number;
  createdAt: number;
  updatedAt: number;
};

type OnboardingDraft = {
  lane: "quick" | "customize" | "advanced";
  mode: "manual" | "guided";
  stage: "welcome" | "details" | "review";
  detailStep: "account" | "admin" | "system" | "ai" | "source" | "device";
  account: { username: string; password: string; passwordConfirm: string };
  admin: { mode: "same" | "custom"; password: string };
  system: { timezone: string };
  ai: { enabled: boolean; provider: string; model: string; apiKey: string };
  source: { enabled: boolean; value: string; ref: string };
  device: { enabled: boolean; deviceId: string; label: string; expiryDays: string };
};

type OnboardingAssistPatch = {
  op: "set" | "clear";
  path:
    | "account.username" | "admin.mode" | "system.timezone" | "ai.enabled" | "ai.provider" | "ai.model"
    | "source.enabled" | "source.value" | "source.ref"
    | "device.enabled" | "device.deviceId" | "device.label" | "device.expiryDays";
  value?: string | boolean;
};

type AdapterSurface = {
  kind: "dm" | "group" | "channel" | "thread";
  id: string;
  name?: string;
  handle?: string;
  threadId?: string;
};

type AdapterConnectChallenge = {
  type: string;
  message?: string;
  data?: string;
  expiresAt?: number;
  extra?: Record<string, unknown>;
};

type AdapterAccountStatus = {
  accountId: string;
  connected: boolean;
  authenticated: boolean;
  mode?: string;
  lastActivity?: number;
  error?: string;
  extra?: Record<string, unknown>;
};

type NotificationRecord = {
  notificationId: string;
  title: string;
  body?: string;
  level: "info" | "success" | "warning" | "error";
  createdAt: number;
  readAt: number | null;
  dismissedAt: number | null;
  expiresAt: number | null;
  actions: Array<{ kind: string; label: string; target?: string; args?: Record<string, unknown> }>;
  source:
    | { kind: "user" }
    | { kind: "process"; processId: string }
    | { kind: "app"; packageId: string; packageName: string; entrypointName: string };
};
```

## Filesystem: `fs.*`

Native `gsv` filesystem paths are Linux-like virtual paths such as `/home`, `/workspaces`, `/etc`, `/sys`, `/proc`, and `/dev`. Device targets use the target device's filesystem semantics.

Runtime behavior:

| Syscall | Handler | Behavior |
|---|---|---|
| `fs.read` | `handleFsRead`; CLI `Read` | Resolves paths against process `cwd` and home. Lists directories, reads text with numbered lines, or returns image content blocks. `offset` defaults to `0`; `limit` defaults to all lines. Native image reads cap at 25 MiB; CLI image reads cap at 10 MiB. |
| `fs.write` | `handleFsWrite`; CLI `Write` | Creates or replaces a complete file. Native writes through `GsvFs.writeFile`; CLI creates parent directories explicitly. Returns written path and size. |
| `fs.edit` | `handleFsEdit`; CLI `Edit` | Performs exact string replacement in a text file. `replaceAll` defaults to `false`; if multiple matches exist and `replaceAll` is false, the handler asks for a more specific edit. |
| `fs.delete` | `handleFsDelete`; CLI `Delete` | Deletes the path. Native checks existence then calls `rm` with force; CLI deletes files or directories recursively. This is destructive. |
| `fs.search` | `handleFsSearch`; CLI `Grep` | Plain-text search by public contract. Native uses backend search; CLI uses regex grep, but the bridge escapes `query` into a literal pattern. `path` defaults to process `cwd`; empty queries return an operation error. |

Device routing errors are frame-level errors: `403` for access denied, `503` for offline or missing connection, `400` for unsupported syscall, and `504` for route timeout.

```ts
type FilesystemSyscalls = {
  "fs.read": {
    args: { target?: string; path: string; offset?: number; limit?: number };
    result:
      | { ok: true; content: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; path: string; lines?: number; size: number }
      | { ok: true; path: string; files: string[]; directories: string[] }
      | OperationError;
  };

  "fs.write": {
    args: { target?: string; path: string; content: string };
    result: { ok: true; path: string; size: number } | OperationError;
  };

  "fs.edit": {
    args: { target?: string; path: string; oldString: string; newString: string; replaceAll?: boolean };
    result: { ok: true; path: string; replacements: number } | OperationError;
  };

  "fs.delete": {
    args: { target?: string; path: string };
    result: { ok: true; path: string } | OperationError;
  };

  "fs.search": {
    args: { target?: string; query: string; path?: string; include?: string };
    result:
      | { ok: true; matches: Array<{ path: string; line: number; content: string }>; count: number; truncated?: boolean }
      | OperationError;
  };
};
```

## Shell: `shell.exec`

`shell.exec` starts, polls, or writes to a shell command on the selected target. Use `gsv` for the Worker sandbox shell, or a device id for local source trees, private networks, OS packages, credentials, or hardware.

Runtime behavior:

| Syscall | Handler | Behavior |
|---|---|---|
| `shell.exec` | `handleShellExec`; CLI `Bash` | Native runs `just-bash` over `GsvFs` with process identity env, builtin commands such as `pkg`, `codemode`, `mcp`, and `notify`, and installed package CLI commands such as `wiki`. Device targets run a real local shell through the CLI. Device start calls return within a runtime-owned wait budget. If the command is still running, the result includes a `sessionId`; later calls with that `sessionId` poll or write stdin. |

```ts
type ShellSyscalls = {
  "shell.exec": {
    args: {
      target?: string;
      cwd?: string;
      input: string;
      sessionId?: string;
    };
    result:
      | { status: "completed"; output: string; exitCode: number; sessionId?: string; truncated?: boolean }
      | { status: "running"; output: string; sessionId: string; truncated?: boolean }
      | { status: "failed"; output: string; error: string; exitCode?: number; sessionId?: string; truncated?: boolean }
      | OperationError;
  };
};
```

Start a command:

```json
{ "target": "macbook", "cwd": "~/projects/gsv", "input": "npm test" }
```

Poll a running command:

```json
{ "sessionId": "sh_01JZTEST", "input": "" }
```

Write stdin to a running command:

```json
{ "sessionId": "sh_01JZTEST", "input": "y\n" }
```

CodeMode wrappers expose the same result shape:

```ts
let res = await shell("npm run test", { cwd: "/workspace/gsv/gateway" });
let output = res.output;

while (res.status === "running") {
  res = await shell("", { sessionId: res.sessionId });
  output += res.output;
}

return output;
```

## CodeMode: `codemode.exec`, `codemode.run`

`codemode.exec` runs one sandboxed async JavaScript block in the Process DO
using Cloudflare Worker Loader. It is exposed to models as the `CodeMode` tool
for multi-step workflows that are easier to express as code than as repeated
direct tool calls.

`codemode.run` is the manual/user-facing execution path used by the native
`codemode` shell command. It forwards to the target Process DO and runs the same
Worker Loader executor, but is not exposed as a model tool.

`codemode.exec` is process-local and internal-only. It is not handled by the
Kernel dispatcher and is not itself device-routed. `codemode.run` is public and
kernel-forwarded to a process, defaulting to the caller's init process. In both
cases, the sandboxed block receives wrappers for the existing filesystem and
shell tools, plus generated async functions for connected MCP tools:

```ts
const res = await shell("npm test", { target: "macbook", cwd: "~/projects/gsv" });
const file = await fs.read({ target: "macbook", path: "package.json" });
const toolResult = await lookup_record({ query: "gsv" });
```

Nested tool calls are dispatched back through the Process DO and Kernel as
ordinary `shell.exec`, `fs.*`, and `sys.mcp.*` request frames. They keep the
same capability, approval, target routing, async device response, and shell
session behavior as direct model tool calls.

Runtime behavior:

| Syscall | Handler | Behavior |
|---|---|---|
| `codemode.exec` | Process DO `executeCodeModeTool`; `executeCodeMode` | Runs code in an isolated Worker Loader worker with outbound network disabled. Provides `shell(input, options)`, `fs.read/write/edit/delete/search`, `mcpTools` metadata, and connected MCP tools as generated async functions. Returns a structured `completed` or `failed` CodeMode result. |
| `codemode.run` | Kernel `forwardToProcess`; Process DO `handleCodeModeRun`; `executeCodeMode` | Manual CodeMode execution for shell/CLI surfaces. Accepts code plus optional wrapper defaults and script arguments. Nested tools route through normal `shell.exec`, `fs.*`, and `sys.mcp.*` syscalls. |

```ts
type CodeModeSyscalls = {
  "codemode.exec": {
    args: {
      code: string;
    };
    result:
      | { status: "completed"; result: unknown; logs?: string[] }
      | { status: "failed"; error: string; logs?: string[] };
  };
  "codemode.run": {
    args: {
      pid?: string;
      code: string;
      target?: string;
      cwd?: string;
      argv?: string[];
      args?: unknown;
    };
    result:
      | { status: "completed"; result: unknown; logs?: string[] }
      | { status: "failed"; error: string; logs?: string[] };
  };
};
```

Native shell usage:

```bash
codemode ./script.js --target macbook --cwd ~/projects/gsv -- arg1 arg2
codemode run ./script.js --target macbook --cwd ~/projects/gsv -- arg1 arg2
codemode -e 'return await shell("pwd")'
```

Script files and `-e` code are treated as async function bodies. Top-level
`await` is valid, but the returned value should use an explicit `return`
statement:

```js
const pwd = await shell("pwd");
const packageJson = await fs.read({ path: "package.json" });
const found = await lookup_record({ query: "gsv" });
return { pwd: pwd.output, packageJson: packageJson.content, found };
```

Connected MCP tools are generated as direct async functions. A unique MCP tool
name such as `lookup-record` becomes `lookup_record(args)`, and a
server-qualified alias such as `Search_lookup_record(args)` is also generated
for clarity and collision handling. The `CodeMode` tool description includes
generated TypeScript declarations for ready MCP tools when their schemas are
known. `mcpTools` lists the generated function names, server ids, original tool
names, input schemas, and output schemas. Generated functions unwrap MCP result
envelopes: structured content is returned directly, text-only content is parsed
as JSON when possible or returned as a string, and MCP tool errors throw.

Inside manual CodeMode runs, `argv` contains positional arguments after `--` and
`args` contains values from `--arg key=value` or `--args-json`.

Without `--json`, the native shell command prints only the completed result.
With `--json`, it prints the full CodeMode envelope. Failed runs exit with code
`1` and, with `--json`, still print `{ status: "failed", error, logs? }`.

Shell calls inside CodeMode expose the direct `shell.exec` result shape. Code
that wants completion must handle `status: "running"` by polling the returned
session:

```ts
let res = await shell("npm run test", { target: "macbook", cwd: "~/projects/gsv" });
let output = res.output;

while (res.status === "running") {
  res = await shell("", { sessionId: res.sessionId });
  output += res.output;
}

if (res.status === "failed") {
  throw new Error(`${res.error}\n${output}`);
}

return { exitCode: res.exitCode, output };
```

## Processes: `proc.*`

`proc.*` controls GSV AI processes. These are long-lived agent processes, not shell commands.

Runtime behavior:

| Syscall | Handler | Behavior |
|---|---|---|
| `proc.list` | `handleProcList` | Reads the kernel process registry. Root defaults to all processes; non-root defaults to own uid, though an explicit `uid` is currently honored by the handler. |
| `proc.profile.list` | `handleProcProfileList` | Returns system AI profiles plus enabled package-backed profiles visible to the caller. Package entries are sorted by package name and display name. |
| `proc.spawn` | `handleProcSpawn` | Resolves the run-as identity, registers the process, sends kernel-only `proc.setidentity`, and optionally sends the initial prompt. A default interactive top-level spawn reuses the caller's default conversation executor; custom spawns get UUID pids. |
| `proc.send` | Process DO `handleProcSend` | Defaults `pid` to `init:<uid>` when forwarded and `conversationId` to `default`. Stores media, appends a user message, starts a run if idle, or queues the message if a run is active. Touches workspace activity before forwarding. |
| `proc.ipc.send` | `handleProcIpcSend` | Process-callable same-owner IPC. Validates that the caller is a registered process, the target exists, and source/target uids match, then sends kernel-only `proc.ipc.deliver` to the target Process DO. The target receives a visible user message envelope and starts or queues a run. |
| `proc.ipc.call` | `handleProcIpcCall` | Process-callable bounded same-owner IPC. Creates a call id and deadline, delivers the request to the target process, and later sends either `ipc.reply` or `ipc.timeout` to the source process. The syscall returns after acceptance, not after the target replies. |
| `proc.abort` | Process DO | Logical cancellation of the active run. Clears pending HIL and current run, emits `chat.complete` with `aborted: true`, and may promote the next queued run. In-flight external work can still resolve later but stale handling guards state. |
| `proc.hil` | Process DO | Resolves a pending human-in-the-loop request. `approve` dispatches the original syscall; `deny` appends a synthetic error tool result. `remember: true` with `approve` stores a process-local allow override for the syscall and target class. |
| `proc.kill` | Process DO | Checkpoints workspace, optionally archives every non-empty conversation under one archive directory, clears active run, tool state, HIL, queue, media, and all conversation messages, then increments conversation generations. Does not remove the kernel process registry entry in normal syscall use. |
| `proc.history` | Process DO | Returns paged stored messages for `conversationId` or `default`, plus message ids, message count, cursor flags, truncation status, timestamps, pending HIL, and the latest context-pressure state when available. Offset paging reads from the beginning. `tail: true` reads the latest page, `beforeMessageId` reads older messages, and `afterMessageId` reads newer messages. Tool results and assistant metadata are expanded into structured content. |
| `proc.conversation.open` | Process DO | Creates or reopens a process-local conversation. If `conversationId` is omitted, the Process DO generates one. Optional `title` is trimmed and stored. |
| `proc.conversation.list` | Process DO | Lists open conversations by default. `includeClosed: true` includes closed conversations. Each record includes generation, status, title, message count, and timestamps. |
| `proc.conversation.get` | Process DO | Returns one conversation record for `conversationId` or `default`; unknown conversations return `conversation: null`. |
| `proc.conversation.close` | Process DO | Marks a conversation closed without deleting history. Future `proc.send` calls to that conversation fail until it is reopened. |
| `proc.conversation.reset` | Process DO | Archives the selected conversation by default, clears its active messages and queued/runtime state, increments its generation, and reopens it. Other conversations are left intact. |
| `proc.conversation.policy.get` | Process DO | Returns the visible context-overflow policy for `conversationId` or `default`. Default policy is manual compaction at 90% pressure with 80 live messages retained if auto-compaction is later enabled. |
| `proc.conversation.policy.set` | Process DO | Sets the visible context-overflow policy. Supported `overflow` values are `manual`, `auto-compact`, and `fail`; automatic execution happens only during the normal process run preflight. |
| `proc.conversation.compact` | Process DO | Explicitly archives an old prefix of a conversation, inserts a visible system summary marker at the prefix boundary, and records a `compaction` segment. Requires either caller-provided `summary` or `generateSummary: true`, plus exactly one selector: `keepLast` or `throughMessageId`. |
| `proc.conversation.fork` | Process DO | Branches a live conversation through `throughMessageId`, or restores a compacted `segmentId` into a new process-local conversation. Segment restore includes the live suffix that existed at the compaction boundary unless `includeLiveSuffix: false`. |
| `proc.conversation.segment.read` | Process DO | Reads paged messages from a compacted segment archive without restoring those messages into the live conversation. |
| `proc.conversation.segments` | Process DO | Lists recorded lifecycle segments for `conversationId` or `default`, including archive paths and summary marker ids. |
| `proc.reset` | Process DO | Checkpoints workspace, archives every non-empty conversation under `/var/sessions/<username>/<pid>/<archiveId>/`, clears active execution state, queues, process media, and all conversation messages, then increments conversation generations. |
| `proc.ipc.deliver` | Process DO direct path | Kernel-only through public dispatch. Delivers the validated IPC envelope from the kernel into the target conversation. |
| `proc.setidentity` | Process DO direct path | Kernel-only through public dispatch. Stores pid, identity, interaction mode, assignment context, and conversation hydration pointers; `assignment.autoStart` can create a run immediately. |

```ts
type ProcContextFile = { name: string; text: string };
type ProcSpawnAssignment = { contextFiles: ProcContextFile[]; autoStart?: boolean };

type ProcHilRequest = {
  requestId: string;
  runId: string;
  conversationId?: string;
  callId: string;
  toolName: string;
  syscall: string;
  args: Record<string, unknown>;
  createdAt: number;
};

type ProcConversation = {
  id: string;
  generation: number;
  status: "open" | "closed";
  title: string | null;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
};

type ProcArchiveEntry = {
  conversationId: string;
  generation: number;
  messages: number;
  path: string;
};

type ProcConversationSegment = {
  id: string;
  conversationId: string;
  generation: number;
  kind: "compaction";
  fromMessageId: number;
  toMessageId: number;
  archivePath: string;
  summaryMessageId: number | null;
  createdAt: number;
};

type ProcIpcSendArgs = {
  pid: string;
  conversationId?: string;
  message: string;
  metadata?: Record<string, unknown>;
};

type ProcIpcDeliverArgs = {
  sourcePid: string;
  source: ProcessIdentity;
  conversationId?: string;
  message: string;
  metadata?: Record<string, unknown>;
  sentAt: number;
  call?: {
    callId: string;
    replyToPid: string;
    deadlineAt: number;
  };
};

type ProcIpcSendResult =
  | { ok: true; status: "started"; pid: string; sourcePid: string; conversationId: string; runId: string; queued?: boolean }
  | OperationError;

type ProcIpcCallArgs = ProcIpcSendArgs & {
  timeoutMs?: number;
};

type ProcIpcCallResult =
  | { ok: true; status: "started"; callId: string; pid: string; sourcePid: string; conversationId: string; runId: string; deadlineAt: number; queued?: boolean }
  | OperationError;

type ProcessSyscalls = {
  "proc.list": {
    args: { uid?: number };
    result: { processes: Array<{ pid: string; uid: number; username: string; interactive: boolean; parentPid: string | null; state: string; activeRunId: string | null; activeConversationId: string | null; queuedCount: number; lastActiveAt: number | null; label: string | null; createdAt: number; cwd: string; isDefaultConversation?: boolean }> };
  };

  "proc.profile.list": {
    args: Empty;
    result: { profiles: Array<{ id: AiContextProfile; alias?: string; kind: "system" | "package"; displayName: string; description?: string; interactive: boolean; startable: boolean; background: boolean; spawnMode: "singleton" | "new"; packageId?: string; packageName?: string }> };
  };

  "proc.spawn": {
    args: { runAs?: string; interactive?: boolean; fresh?: boolean; label?: string; prompt?: string; assignment?: ProcSpawnAssignment; parentPid?: string; cwd?: string };
    result: { ok: true; pid: string; label?: string; cwd: string } | OperationError;
  };

  "proc.send": {
    args: { pid?: string; conversationId?: string; message: string; media?: MediaInput[] };
    result: { ok: true; status: "started"; runId: string; queued?: boolean } | OperationError;
  };

  "proc.ipc.send": {
    args: ProcIpcSendArgs;
    result: ProcIpcSendResult;
  };

  "proc.ipc.call": {
    args: ProcIpcCallArgs;
    result: ProcIpcCallResult;
  };

  "proc.ipc.deliver": {
    args: ProcIpcDeliverArgs;
    result: ProcIpcSendResult;
  };

  "proc.abort": {
    args: { pid?: string };
    result: { ok: true; pid: string; aborted: boolean; runId?: string; interruptedToolCalls?: number; continuedQueuedRunId?: string } | OperationError;
  };

  "proc.hil": {
    args: { pid?: string; requestId: string; decision: "approve" | "deny"; remember?: boolean };
    result: { ok: true; pid: string; requestId: string; decision: "approve" | "deny"; resumed: boolean; remembered?: boolean; pendingHil?: ProcHilRequest | null } | OperationError;
  };

  "proc.kill": {
    args: { pid: string; archive?: boolean };
    result: { ok: true; pid: string; archivedMessages: number; archivedTo?: string; archives: ProcArchiveEntry[] } | OperationError;
  };

  "proc.history": {
    args: { pid?: string; conversationId?: string; limit?: number; offset?: number; beforeMessageId?: number; afterMessageId?: number; tail?: boolean };
    result: { ok: true; pid: string; conversationId?: string; messages: Array<{ id?: number; role: "user" | "assistant" | "system" | "toolResult"; content: unknown; timestamp?: number }>; messageCount: number; truncated?: boolean; hasMoreBefore?: boolean; hasMoreAfter?: boolean; pendingHil?: ProcHilRequest | null; context?: ProcContextState | null } | OperationError;
  };

  "proc.conversation.open": {
    args: { pid?: string; conversationId?: string; title?: string };
    result: { ok: true; pid: string; conversation: ProcConversation; created: boolean } | OperationError;
  };

  "proc.conversation.list": {
    args: { pid?: string; includeClosed?: boolean };
    result: { ok: true; pid: string; conversations: ProcConversation[] } | OperationError;
  };

  "proc.conversation.get": {
    args: { pid?: string; conversationId?: string };
    result: { ok: true; pid: string; conversation: ProcConversation | null } | OperationError;
  };

  "proc.conversation.close": {
    args: { pid?: string; conversationId: string };
    result: { ok: true; pid: string; conversationId: string; closed: boolean } | OperationError;
  };

  "proc.conversation.reset": {
    args: { pid?: string; conversationId?: string; archive?: boolean };
    result: { ok: true; pid: string; conversationId: string; generation: number; archivedMessages: number; archivedTo?: string } | OperationError;
  };

  "proc.conversation.policy.get": {
    args: { pid?: string; conversationId?: string };
    result: { ok: true; pid: string; policy: ProcConversationContextPolicy } | OperationError;
  };

  "proc.conversation.policy.set": {
    args: { pid?: string; conversationId?: string; overflow?: "manual" | "auto-compact" | "fail"; compactAtPressure?: number; keepLast?: number };
    result: { ok: true; pid: string; policy: ProcConversationContextPolicy } | OperationError;
  };

  "proc.conversation.compact": {
    args: { pid?: string; conversationId?: string; summary?: string; generateSummary?: boolean; keepLast?: number; throughMessageId?: number };
    result: { ok: true; pid: string; conversationId: string; segment: ProcConversationSegment; archivedMessages: number; archivedTo: string; summaryMessageId: number } | OperationError;
  };

  "proc.conversation.fork": {
    args: { pid?: string; conversationId?: string; segmentId?: string; throughMessageId?: number; targetConversationId?: string; title?: string; includeLiveSuffix?: boolean };
    result: { ok: true; pid: string; sourceConversationId: string; targetConversation: ProcConversation; segment?: ProcConversationSegment; throughMessageId?: number; restoredMessages: number; includedLiveSuffix: boolean } | OperationError;
  };

  "proc.conversation.segment.read": {
    args: { pid?: string; conversationId?: string; segmentId: string; limit?: number; offset?: number };
    result: { ok: true; pid: string; conversationId: string; segment: ProcConversationSegment; messages: ProcHistoryMessage[]; messageCount: number; truncated?: boolean } | OperationError;
  };

  "proc.conversation.segments": {
    args: { pid?: string; conversationId?: string };
    result: { ok: true; pid: string; conversationId: string; segments: ProcConversationSegment[] } | OperationError;
  };

  "proc.reset": {
    args: { pid?: string };
    result: { ok: true; pid: string; archivedMessages: number; archivedTo?: string; archives: ProcArchiveEntry[] } | OperationError;
  };

  "proc.setidentity": {
    args: { pid: string; identity: ProcessIdentity; interactive?: boolean; assignment?: ProcSpawnAssignment; conversationId?: string; hydrateFrom?: string };
    result: { ok: true; startedRunId?: string };
  };
};
```

`proc.ipc.deliver` and `proc.setidentity` are kernel-only. User and device callers receive a forbidden response.

## Packages: `pkg.*`

`pkg.*` manages installed packages, package catalogs, review state, and package visibility. Use `repo.*` for generic repository operations against package source repos.

Runtime behavior:

| Syscall | Handler | Behavior |
|---|---|---|
| `pkg.list` | `handlePkgList` | Lists visible packages with optional `enabled`, exact trimmed `name`, and `runtime` filters. Visible scope is actor user scope first, then global. |
| `pkg.add` | `handlePkgAdd` | Imports a package from `remoteUrl` or GitHub `repo`, resolves and assembles it, stores the artifact, and upserts the package record. Defaults `ref` to `main` and `subdir` to `.`. Imports outside `root/gsv` stay disabled and review-required by default. |
| `pkg.sync` | `handlePkgSync` | Re-resolves one installed package at its recorded source ref, or an explicit `ref`, and replaces the installed manifest/artifact through the same path as `pkg.checkout`. Requires a package specifier. |
| `pkg.checkout` | `handlePkgCheckout` | Re-resolves an existing package at a new ref and replaces manifest and artifact while preserving grants, enabled state, review flags, and install time. Requires mutable package access. |
| `pkg.install` | `handlePkgInstall` | Enables an installed package. Errors if review is required and not approved. Idempotent when already enabled. |
| `pkg.review.approve` | `handlePkgReviewApprove` | Sets review approval metadata for review-required packages. If review is not required, returns unchanged. |
| `pkg.remove` | `handlePkgRemove` | Removes the package row and revokes the caller owner's run-as access for package agents. Returns a disabled summary of the removed package. |
| `pkg.remote.list` | `handlePkgRemoteList` | Lists current user package catalog remotes from config, sorted by name. Requires identity. |
| `pkg.remote.add` | `handlePkgRemoteAdd` | Stores a current-user remote config key. Remote names must be alphanumeric with dashes; URLs must be HTTP or HTTPS and are normalized. |
| `pkg.remote.remove` | `handlePkgRemoteRemove` | Deletes a current-user remote config key. Returns whether anything was removed. |
| `pkg.public.list` | `handlePkgPublicList` | Lists local public packages, or fetches `<baseUrl>/public/packages` from a named/URL remote. Invalid remote catalog entries are dropped. |
| `pkg.public.set` | `handlePkgPublicSet` | Marks a source repo public or private in config. Requires repo owner, root, or wildcard capability. |

Mutating package calls require root, wildcard capability, or ownership of the package user scope. `pkg.add`, `pkg.create`, `pkg.sync`, `pkg.install`, `pkg.remove`, and `pkg.checkout` broadcast `pkg.changed` to that scope after success.

```ts
type PackageSyscalls = {
  "pkg.list": {
    args: { enabled?: boolean; name?: string; runtime?: PkgRuntime };
    result: { packages: PkgSummary[] };
  };

  "pkg.add": {
    args: { remoteUrl?: string; repo?: string; ref?: string; subdir?: string; enable?: boolean };
    result: { changed: boolean; imported: { repo: string; remoteUrl: string; ref: string; head: string | null }; package: PkgSummary };
  };

  "pkg.sync": {
    args: { packageId: string; ref?: string };
    result: { packages: PkgSummary[] };
  };

  "pkg.checkout": {
    args: { packageId: string; ref: string };
    result: { changed: boolean; package: PkgSummary };
  };

  "pkg.install": {
    args: { packageId: string };
    result: { changed: boolean; package: PkgSummary };
  };

  "pkg.review.approve": {
    args: { packageId: string };
    result: { changed: boolean; package: PkgSummary };
  };

  "pkg.remove": {
    args: { packageId: string };
    result: { changed: boolean; package: PkgSummary };
  };

  "pkg.remote.list": {
    args: Empty;
    result: { remotes: Array<{ name: string; baseUrl: string }> };
  };

  "pkg.remote.add": {
    args: { name: string; baseUrl: string };
    result: { changed: boolean; remote: { name: string; baseUrl: string }; remotes: Array<{ name: string; baseUrl: string }> };
  };

  "pkg.remote.remove": {
    args: { name: string };
    result: { removed: boolean; remotes: Array<{ name: string; baseUrl: string }> };
  };

  "pkg.public.list": {
    args: { remote?: string };
    result: { serverName: string; source: { kind: "local" | "remote"; name: string; baseUrl?: string }; packages: PkgCatalogEntry[] };
  };

  "pkg.public.set": {
    args: { packageId?: string; repo?: string; public: boolean };
    result: { changed: boolean; repo: string; public: boolean };
  };
};
```

## Repositories: `repo.*`

`repo.*` is the kernel-level interface to ripgit repositories. It exposes versioned content, history, diffs, imports, and atomic commits without modeling a Git index or separate `add` step. In the native GSV shell, `/src/repos/{owner}/{repo}` edits are staged per process and committed through `rgit commit`; direct `repo.apply` callers still submit one explicit atomic commit.

Runtime behavior:

| Syscall | Handler | Behavior |
|---|---|---|
| `repo.list` | `handleRepoList` | Lists repositories visible to the caller. Results include home, workspace, visible package source, and registered user repos. Optional `owner` filters by repo owner. |
| `repo.create` | `handleRepoCreate` | Creates a repository by writing an empty initial commit to `ref`, default `main`. Existing refs return `created: false`. Only root, wildcard, or the username owner can write. |
| `repo.refs` | `handleRepoRefs` | Reads heads and tags. Allows owned repos, public repos, and visible package source repos. |
| `repo.read` | `handleRepoRead` | Reads a tree or file at `repo`, `ref`, and `path`. Defaults `ref` to `main` and `path` to root. Binary files return `content: null`. |
| `repo.search` | `handleRepoSearch` | Searches text in a repo, optionally under `prefix`. Requires a non-empty query. |
| `repo.log` | `handleRepoLog` | Reads first-parent commit history. `limit` defaults to 30 and clamps to 1-100; `offset` defaults to 0. |
| `repo.diff` | `handleRepoDiff` | Reads one commit diff. Requires `commit`; `context` defaults to 3 and clamps to 0-20. |
| `repo.compare` | `handleRepoCompare` | Compares `base` and `head` refs or hashes. `stat: true` omits hunks from ripgit. |
| `repo.apply` | `handleRepoApply` | Atomically commits `put`, `delete`, and `move` operations to one ref. `expectedHead` enables optimistic concurrency. `allowEmpty` permits an empty commit. |
| `repo.import` | `handleRepoImport` | Imports or refreshes a repo from an upstream Git URL/ref into a local ripgit repo. Omit `remoteUrl` to pull from the repo's stored upstream. |
| `repo.delete` | `handleRepoDelete` | Deletes a writable ripgit repository and unregisters its repo metadata. Refuses repositories still backing installed packages. |

Write access is intentionally narrower than read access. Non-root users can write repos owned by their username. Public repos and visible package source repos are readable but not writable unless ownership also matches. Native shell writes under `/src/repos` stage in a process-local overlay until `rgit commit` or `rgit discard`.

```ts
type RepoDiffFile = {
  path: string;
  status: "added" | "deleted" | "modified";
  oldHash?: string;
  newHash?: string;
  hunks?: Array<{
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: Array<{ tag: "context" | "add" | "delete" | "binary"; content: string }>;
  }>;
};

type RepoSyscalls = {
  "repo.list": {
    args: { owner?: string };
    result: { repos: Array<{ repo: string; owner: string; name: string; kind: "home" | "workspace" | "package" | "user"; writable: boolean; public: boolean; ref?: string; baseRef?: string; sources?: Array<{ kind: "package"; subdir: string; ref?: string; baseRef?: string; packageId?: string; name?: string; updatedAt?: number }>; description?: string; updatedAt?: number }> };
  };

  "repo.create": {
    args: { repo: string; ref?: string; description?: string };
    result: { repo: string; ref: string; head: string | null; created: boolean };
  };

  "repo.refs": {
    args: { repo: string };
    result: { repo: string; heads: Record<string, string>; tags: Record<string, string>; remotes?: Record<string, string> };
  };

  "repo.read": {
    args: { repo: string; ref?: string; path?: string };
    result:
      | { repo: string; ref: string; path: string; kind: "tree"; entries: Array<{ name: string; path: string; mode: string; hash: string; type: "tree" | "blob" | "symlink" }> }
      | { repo: string; ref: string; path: string; kind: "file"; size: number; isBinary: boolean; content: string | null };
  };

  "repo.search": {
    args: { repo: string; ref?: string; query: string; prefix?: string };
    result: { repo: string; ref: string; query: string; prefix?: string; truncated?: boolean; matches: Array<{ path: string; line: number; content: string }> };
  };

  "repo.log": {
    args: { repo: string; ref?: string; limit?: number; offset?: number };
    result: { repo: string; ref: string; limit: number; offset: number; entries: Array<{ hash: string; treeHash: string; author: string; authorEmail: string; authorTime: number; committer: string; committerEmail: string; commitTime: number; message: string; parents: string[] }> };
  };

  "repo.diff": {
    args: { repo: string; commit: string; context?: number };
    result: { repo: string; commitHash: string; parentHash?: string | null; stats: { filesChanged: number; additions: number; deletions: number }; files: RepoDiffFile[] };
  };

  "repo.compare": {
    args: { repo: string; base: string; head: string; context?: number; stat?: boolean };
    result: { repo: string; base: string; head: string; stats: { filesChanged: number; additions: number; deletions: number }; files: RepoDiffFile[] };
  };

  "repo.apply": {
    args: { repo: string; ref?: string; message: string; expectedHead?: string; allowEmpty?: boolean; ops: Array<{ type: "put"; path: string; content?: string; contentBase64?: string } | { type: "delete"; path: string; recursive?: boolean } | { type: "move"; from: string; to: string }> };
    result: { ok: true; repo: string; ref: string; head: string | null };
  };

  "repo.import": {
    args: { repo: string; ref?: string; remoteUrl?: string; remoteRef?: string; message?: string };
    result: { repo: string; ref: string; head: string | null; changed: boolean; remoteUrl: string; remoteRef: string; trackingRef?: string; upstreamHead?: string; upstreamChanged?: boolean; localChanged?: boolean; diverged?: boolean };
  };

  "repo.delete": {
    args: { repo: string };
    result: { deleted: boolean; repo: string };
  };
};
```

## System: `sys.*`

`sys.*` covers setup, configuration, devices, workspaces, tokens, and account links.

Runtime behavior:

| Syscall | Handler | Behavior |
|---|---|---|
| `sys.connect` | `handleConnect` | First request on a WebSocket connection. Authenticates, assigns identity, returns capabilities as `syscalls`, returns signal list, registers driver devices, closes older same-client connections, and starts/reconciles the user init process. Setup mode rejects with `425` and `next: "sys.setup"`. |
| `sys.setup.assist` | `handleSysSetupAssist` | Pre-connect setup helper. Uses app AI config to guide onboarding, redacts secrets from drafts, and only accepts whitelisted non-secret patches from model output. Rejected if already connected or initialized. |
| `sys.setup` | `handleSysSetup` | Pre-connect setup-mode bootstrap. Creates first user, root password, groups/home, optional timezone, optional AI config, optional node token, home layout, and optional system bootstrap. Username, password, and timezone are validated. |
| `sys.bootstrap` | `handleSysBootstrap` | Imports `root/gsv`, seeds builtin packages, refreshes hosted stable/dev CLI assets, stores default CLI channel, and broadcasts `pkg.changed`. Explicit args win; otherwise `GSV_BOOTSTRAP_UPSTREAM` can override the default `deathbyknowledge/gsv#main`; it accepts `owner/repo`, a git URL, or either form with `#ref`. `GSV_BOOTSTRAP_REF` can set or override the env ref separately. Requires `RIPGIT` and storage. |
| `sys.config.get` | `handleSysConfigGet` | Reads exact config key or visible prefix. Root sees all; non-root sees own `users/<uid>/` keys and non-sensitive `config/` keys. Sensitive names such as password, token, secret, and api key are hidden from non-root. |
| `sys.config.set` | `handleSysConfigSet` | Writes a config value. Root can write any key; non-root can write only own user-overridable keys, currently under `users/<uid>/ai/`. Values are coerced with `String(value)`. |
| `sys.device.list` | `handleSysDeviceList` | Lists devices accessible by owner uid or group ACL. Root sees all. Defaults to online devices only unless `includeOffline` is true. |
| `sys.device.get` | `handleSysDeviceGet` | Reads one device descriptor. Missing or inaccessible devices return `device: null` rather than a permission error. |
| `sys.device.update` | `handleSysDeviceUpdate` | Updates owner-managed device metadata. Root or the device owner may update the process-visible `description`; group-only device access can use the device but cannot edit its metadata. Missing or inaccessible devices return `device: null`. |
| `sys.device.delete` | `handleSysDeviceDelete` | Forgets an owned physical device, disconnects any live device socket, and revokes active node tokens bound to that device. Group-only access cannot forget. Missing or inaccessible devices return `deleted: false`. |
| `sys.workspace.list` | `handleSysWorkspaceList` | Lists workspaces for caller uid by default. Root may request any uid; non-root may only request self. Adds active process summary and process count. |
| `sys.oauth.start` | `handleSysOAuthStart` | Starts an OAuth authorization-code + PKCE flow for an AI provider, MCP server, or generic integration. Returns an authorization URL and pending flow summary. Redirects must target `/oauth/callback` on the deployed GSV origin. Non-root is scoped to self. |
| `sys.oauth.list` | `handleSysOAuthList` | Lists OAuth account summaries without access or refresh tokens. Non-root is scoped to self; root can list all or one uid. `includePending: true` also returns unexpired pending flows. |
| `sys.oauth.forget` | `handleSysOAuthForget` | Deletes a stored OAuth account. Non-root can delete only own accounts. Missing or inaccessible accounts return `forgotten: false`. |
| `sys.mcp.add` | `handleSysMcpAdd` | Connects a user-owned HTTP MCP server through the Kernel MCP client manager. Server URLs and callback hosts must use HTTPS except localhost development URLs. Returns the server summary, including `authUrl` when OAuth sign-in is required. Uses `/oauth/callback` and client metadata when possible. Non-root is scoped to self. |
| `sys.mcp.list` | `handleSysMcpList` | Lists caller-owned MCP servers with connection state, OAuth URL, discovered tools, resource count, and prompt count. Root may pass `uid`; non-root is scoped to self. |
| `sys.mcp.remove` | `handleSysMcpRemove` | Removes a caller-owned MCP server from GSV ownership metadata and the underlying MCP client manager. Missing or inaccessible servers return `removed: false`. |
| `sys.mcp.refresh` | `handleSysMcpRefresh` | Reconnects and rediscovers a caller-owned MCP server when possible. Returns the latest summary or `server: null` when inaccessible. |
| `sys.mcp.call` | `handleSysMcpCall` | Calls a tool on a caller-owned MCP server. Generated CodeMode MCP functions and the native shell `mcp call` command use this path. Native `mcp status/tools/describe/search/codemode` provide discovery around the same summaries returned by `sys.mcp.list`. |
| `sys.token.create` | `handleSysTokenCreate` | Creates a hashed node, service, or user token. Root may target any uid. Role defaults must match token kind; driver/node tokens may bind to `allowedDeviceId`. Raw token is returned only once. |
| `sys.token.list` | `handleSysTokenList` | Lists token metadata, including revoked tokens, never raw token values. Non-root is scoped to self; root can list all or one uid. |
| `sys.token.revoke` | `handleSysTokenRevoke` | Revokes a token by id with optional reason. Non-root can revoke only own tokens. Missing or inaccessible token returns `revoked: false`. |
| `sys.link` | `handleSysLink` | User-role only. Links an adapter/account/actor to a uid. Adapter is lowercased; root may link to any uid, non-root only self. |
| `sys.unlink` | `handleSysUnlink` | User-role only. Removes an adapter identity link. Missing links return `removed: false`; non-root can unlink only self-owned links. |
| `sys.link.list` | `handleSysLinkList` | User-role only. Lists identity links newest-first. Non-root is implicitly scoped to self; root may list all or filter by uid. |
| `sys.link.consume` | `handleSysLinkConsume` | User-role only. Consumes an uppercase link challenge code for the caller uid, marks the challenge used, and creates/replaces the identity link. Invalid, expired, or used codes throw. |
| `sys.update` | `handleSysUpdate` | Runs system-managed update work without re-running bootstrap. Today this refreshes hosted stable/dev CLI binaries, checksums, install scripts, and the default CLI channel in storage. If `channel` is omitted, the existing stored default is preserved, falling back to `dev` when missing. The Kernel also schedules this once per server version after an authenticated user connection so old upgrade CLIs can still reseed hosted binaries. |

`sys.connect`, `sys.setup`, and `sys.setup.assist` are special-cased before normal auth/capability dispatch. Other `sys.*` calls require a connected identity and are denied in setup mode.

OAuth callbacks are handled by the Gateway HTTP route `GET /oauth/callback`.
Gateway forwards that route to the Kernel, where the inherited Agent MCP client
manager gets first chance to consume MCP OAuth callbacks before the generic
`sys.oauth.*` callback handler runs. `sys.oauth.start` callers must pass the
exact redirect URI they registered with the remote provider, normally
`https://<gsv-origin>/oauth/callback`. The Gateway also serves client metadata
at `/.well-known/oauth-client/gsv.json` for providers that accept client
metadata URLs; in those cases the `clientId` can be that metadata URL, and the
metadata document advertises the same URL as its `client_id`.

```ts
type SystemSyscalls = {
  "sys.connect": {
    args: { protocol: number; client: { id: string; version: string; platform: string; role: "user" | "driver" | "service"; channel?: string }; driver?: { implements: string[] }; auth?: { username: string; password?: string; token?: string } };
    result: { protocol: number; server: { version: string; connectionId: string }; identity: ConnectionIdentity; syscalls: string[]; signals: string[] };
  };

  "sys.setup.assist": {
    args: { lane: "quick" | "customize" | "advanced"; draft: OnboardingDraft; messages: Array<{ role: "user" | "assistant"; content: string }> };
    result: { message: string; patches: OnboardingAssistPatch[]; reviewReady: boolean; focus?: string };
  };

  "sys.setup": {
    args: { username: string; password: string; rootPassword?: string; timezone?: string; bootstrap?: { remoteUrl?: string; repo?: string; ref?: string }; ai?: { provider?: string; model?: string; apiKey?: string }; node?: { deviceId: string; label?: string; expiresAt?: number } };
    result: { user: ProcessIdentity; rootLocked: boolean; bootstrap?: SystemSyscalls["sys.bootstrap"]["result"]; nodeToken?: { tokenId: string; token: string; tokenPrefix: string; uid: number; kind: "node"; label: string | null; allowedRole: "driver" | null; allowedDeviceId: string | null; createdAt: number; expiresAt: number | null } };
  };

  "sys.bootstrap": {
    args: { remoteUrl?: string; repo?: string; ref?: string };
    result: { repo: string; remoteUrl: string; ref: string; head: string | null; changed: boolean; cli: { defaultChannel: "stable" | "dev"; mirroredChannels: Array<"stable" | "dev">; assets: string[]; refreshedAt: number }; packages: BootstrapPackageSummary[] };
  };

  "sys.update": {
    args: { channel?: "stable" | "dev" };
    result: { updatedAt: number; cli: { defaultChannel: "stable" | "dev"; mirroredChannels: Array<"stable" | "dev">; assets: string[]; refreshedAt: number } };
  };

  "sys.config.get": {
    args: { key?: string };
    result: { entries: Array<{ key: string; value: string }> };
  };

  "sys.config.set": {
    args: { key: string; value: string };
    result: { ok: true };
  };

  "sys.device.list": {
    args: { includeOffline?: boolean };
    result: { devices: Array<{ deviceId: string; ownerUid: number; description: string; platform: string; version: string; online: boolean; lastSeenAt: number }> };
  };

  "sys.device.get": {
    args: { deviceId: string };
    result: { device: ({ deviceId: string; ownerUid: number; description: string; platform: string; version: string; online: boolean; lastSeenAt: number; implements: string[]; firstSeenAt: number; connectedAt: number | null; disconnectedAt: number | null }) | null };
  };

  "sys.device.update": {
    args: { deviceId: string; description: string };
    result: { device: ({ deviceId: string; ownerUid: number; description: string; platform: string; version: string; online: boolean; lastSeenAt: number; implements: string[]; firstSeenAt: number; connectedAt: number | null; disconnectedAt: number | null }) | null };
  };

  "sys.device.delete": {
    args: { deviceId: string };
    result: { deleted: boolean; deviceId: string; revokedTokens: number };
  };

  "sys.workspace.list": {
    args: { uid?: number; kind?: "thread" | "app" | "shared"; state?: "active" | "archived"; limit?: number };
    result: { workspaces: Array<{ workspaceId: string; ownerUid: number; label: string | null; kind: "thread" | "app" | "shared"; state: "active" | "archived"; createdAt: number; updatedAt: number; defaultBranch: string; headCommit: string | null; activeProcess: { pid: string; label: string | null; cwd: string; createdAt: number } | null; processCount: number }> };
  };

  "sys.oauth.start": {
    args: { uid?: number; kind: OAuthConnectionKind; provider: string; accountKey?: string; label?: string; authorizationEndpoint: string; tokenEndpoint: string; clientId: string; redirectUri: string; scope?: string; resource?: string; extraAuthParams?: Record<string, string> };
    result: { authorizationUrl: string; flow: OAuthFlowSummary };
  };

  "sys.oauth.list": {
    args: { uid?: number; includePending?: boolean };
    result: { accounts: OAuthAccountSummary[]; flows?: OAuthFlowSummary[] };
  };

  "sys.oauth.forget": {
    args: { accountId: string; uid?: number };
    result: { forgotten: boolean };
  };

  "sys.mcp.add": {
    args: { uid?: number; name: string; url: string; callbackHost?: string; transport?: { type?: McpTransportType; headers?: Record<string, string> } };
    result: { server: McpServerSummary };
  };

  "sys.mcp.list": {
    args: { uid?: number };
    result: { servers: McpServerSummary[] };
  };

  "sys.mcp.remove": {
    args: { uid?: number; serverId: string };
    result: { removed: boolean };
  };

  "sys.mcp.refresh": {
    args: { uid?: number; serverId: string };
    result: { server: McpServerSummary | null };
  };

  "sys.mcp.call": {
    args: { uid?: number; serverId: string; name: string; arguments?: Record<string, unknown> };
    result: { content?: unknown; structuredContent?: unknown; isError?: boolean };
  };

  "sys.token.create": {
    args: { uid?: number; kind: "node" | "service" | "user"; label?: string; allowedRole?: "driver" | "service" | "user"; allowedDeviceId?: string; expiresAt?: number };
    result: { token: { tokenId: string; token: string; tokenPrefix: string; uid: number; kind: "node" | "service" | "user"; label: string | null; allowedRole: "driver" | "service" | "user" | null; allowedDeviceId: string | null; createdAt: number; expiresAt: number | null } };
  };

  "sys.token.list": {
    args: { uid?: number };
    result: { tokens: Array<{ tokenId: string; uid: number; kind: "node" | "service" | "user"; label: string | null; tokenPrefix: string; allowedRole: "driver" | "service" | "user" | null; allowedDeviceId: string | null; createdAt: number; lastUsedAt: number | null; expiresAt: number | null; revokedAt: number | null; revokedReason: string | null }> };
  };

  "sys.token.revoke": {
    args: { tokenId: string; reason?: string; uid?: number };
    result: { revoked: boolean };
  };

  "sys.link": {
    args: { adapter: string; accountId: string; actorId: string; uid?: number };
    result: { linked: boolean; link?: { adapter: string; accountId: string; actorId: string; uid: number; createdAt: number } };
  };

  "sys.unlink": {
    args: { adapter: string; accountId: string; actorId: string };
    result: { removed: boolean };
  };

  "sys.link.list": {
    args: { uid?: number };
    result: { links: Array<{ adapter: string; accountId: string; actorId: string; uid: number; createdAt: number; linkedByUid: number }> };
  };

  "sys.link.consume": {
    args: { code: string };
    result: { linked: boolean; link?: { adapter: string; accountId: string; actorId: string; uid: number; createdAt: number } };
  };
};
```

## AI Bootstrap: `ai.*`

`ai.*` is used by Process Durable Objects to prepare agent runs.

Runtime behavior:

| Syscall | Handler | Behavior |
|---|---|---|
| `ai.tools` | `handleAiTools` | Process-internal. Lists online accessible devices and filters built-in tool definitions by caller capabilities. Routable filesystem and shell tools are wrapped with required `target`; CodeMode is exposed as a process-local programmable tool. MCP tools are used through CodeMode or shell, not expanded into this direct tool list. |
| `ai.config` | `handleAiConfig` | Process-internal. Resolves user override then system AI config. Defaults profile to `task`, provider to `workers-ai`, model to `@cf/zai-org/glm-5.2`, fallback profile to `workers-ai-kimi-k2-6`, max tokens to 8192, context window to provider/model metadata or configured fallback, and context budget to 32768 bytes. Package profiles load manifest context files and approval policy. |

External callers cannot normally invoke `ai.*`; these syscalls are exposed to process-originated calls.

```ts
type AiSyscalls = {
  "ai.tools": {
    args: Empty;
    result: { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>; devices: Array<{ id: string; implements: string[]; description?: string; platform?: string }> };
  };

  "ai.config": {
    args: { profile?: AiContextProfile };
    result: { profile?: AiContextProfile; provider: string; model: string; apiKey: string; reasoning?: string; maxTokens: number; contextWindowTokens: number | null; contextWindowSource: "model" | "config" | "unknown"; systemContextFiles?: Array<{ name: string; text: string }>; profileContextFiles?: Array<{ name: string; text: string }>; skillIndex?: Array<{ id: string; name: string; description: string; source: { kind: "profile" | "home" | "workspace" | "package"; label: string; writable: boolean } }>; profileApprovalPolicy?: string | null; maxContextBytes: number };
  };
};
```

## Adapters: `adapter.*`

`adapter.*` is the control plane for external chat or channel connectors.

Runtime behavior:

| Syscall | Handler | Behavior |
|---|---|---|
| `adapter.connect` | `handleAdapterConnect` | User-role only. Rejects foreign-owned accounts, serializes lifecycle operations per account, durably assigns new accounts to the caller's owning human, and calls `CHANNEL_<ADAPTER>.adapterConnect(accountId, config)`. Ownership survives failed provisioning so the owner can retry safely. |
| `adapter.disconnect` | `handleAdapterDisconnect` | Owner-or-root only. Serializes with connect, calls adapter disconnect, upserts local status as disconnected and unauthenticated, then best-effort refreshes live status. |
| `adapter.inbound` | `handleAdapterInbound` | Service-role only. Lowercases adapter, resolves linked user, drops unlinked non-DM messages, issues link challenges for unlinked DMs, ensures the user init process exists, handles pending HIL confirmations, and otherwise forwards rendered text/media to `proc.send`. |
| `adapter.state.update` | `handleAdapterStateUpdate` | Service-role only. Updates status without changing ownership and broadcasts a minimal `adapter.status` invalidation to root, the account owner, and linked users. |
| `adapter.send` | `handleAdapterSend` | Validates adapter/account/surface and forwards outbound text, media, and reply id to the adapter service. Returns adapter message id when available. |
| `adapter.status` | `handleAdapterStatus` | Attempts live status refresh, swallowing live errors, then returns last known local statuses sorted newest first and optionally filtered by account id. |

Adapter status intentionally remains useful when a live adapter service is unavailable; stale local state may be returned.

```ts
type AdapterSyscalls = {
  "adapter.connect": {
    args: { adapter: string; accountId: string; config?: Record<string, unknown> };
    result:
      | { ok: true; adapter: string; accountId: string; connected: boolean; authenticated: boolean; message?: string; challenge?: AdapterConnectChallenge }
      | { ok: false; error: string; challenge?: AdapterConnectChallenge };
  };

  "adapter.disconnect": {
    args: { adapter: string; accountId: string };
    result: { ok: true; adapter: string; accountId: string; message?: string } | OperationError;
  };

  "adapter.inbound": {
    args: { adapter: string; accountId: string; message: { messageId: string; surface: AdapterSurface; actor?: { id: string; name?: string; handle?: string }; text: string; media?: MediaInput[]; replyToId?: string; replyToText?: string; timestamp?: number; wasMentioned?: boolean } };
    result: { ok: boolean; delivered?: { uid: number; pid: string; runId: string; queued: boolean }; reply?: { text: string; replyToId?: string }; challenge?: { code: string; prompt: string; expiresAt: number }; droppedReason?: string; error?: string };
  };

  "adapter.state.update": {
    args: { adapter: string; accountId: string; status: AdapterAccountStatus };
    result: { ok: true };
  };

  "adapter.send": {
    args: { adapter: string; accountId: string; surface: AdapterSurface; text: string; replyToId?: string; media?: MediaInput[] };
    result: { ok: true; adapter: string; accountId: string; surfaceId: string; messageId?: string } | OperationError;
  };

  "adapter.status": {
    args: { adapter: string; accountId?: string };
    result: { adapter: string; accounts: AdapterAccountStatus[] };
  };
};
```

## Notifications and Watches

Runtime behavior:

| Syscall | Handler | Behavior |
|---|---|---|
| `notification.create` | `handleNotificationCreate` | Creates a per-user notification with UUID, normalized actions, derived source, and expiry. Default level is `info`; default unread TTL is 30 days and custom TTL clamps to 1 second through 90 days. Broadcasts `notification.created`. |
| `notification.list` | `handleNotificationList` | Prunes expired notifications, then lists current user notifications. Defaults include read notifications, exclude dismissed notifications, and limit to 100; limit clamps to 1-500. |
| `notification.mark_read` | `handleNotificationMarkRead` | Marks a current-user notification read if found and resets expiry to seven days. Missing, expired, or wrong-user ids return `notification: null`. Broadcasts update when found. |
| `notification.dismiss` | `handleNotificationDismiss` | Marks a current-user notification dismissed and expires it after three days. Missing ids return `notification: null`. Broadcasts dismissal when found. |
| `signal.watch` | `handleSignalWatch` | App/process-originated only. Creates or upserts a durable signal watch. Requires non-empty signal; TTL defaults to 24 hours and clamps to 1 second through 30 days; `once` defaults true. Process runtimes must pass an explicit `processId` and cannot watch themselves. |
| `signal.unwatch` | `handleSignalUnwatch` | App/process-originated only. Removes watches for the current app entrypoint or target process by `watchId` or `key`. Returns number removed. |

Signal watch delivery is handled by the kernel when matching signals are emitted. Once-watches are deleted after successful handling; failed deliveries mark the watch failed.

```ts
type NotificationAndSignalSyscalls = {
  "notification.create": {
    args: { title: string; body?: string; level?: "info" | "success" | "warning" | "error"; actions?: Array<{ kind: string; label: string; target?: string; args?: Record<string, unknown> }>; ttlMs?: number };
    result: { notification: NotificationRecord };
  };

  "notification.list": {
    args: { includeRead?: boolean; includeDismissed?: boolean; limit?: number };
    result: { notifications: NotificationRecord[] };
  };

  "notification.mark_read": {
    args: { notificationId: string };
    result: { notification: NotificationRecord | null };
  };

  "notification.dismiss": {
    args: { notificationId: string };
    result: { notification: NotificationRecord | null };
  };

  "signal.watch": {
    args: { signal: string; processId?: string; key?: string; state?: unknown; once?: boolean; ttlMs?: number };
    result: { watchId: string; created: boolean; createdAt: number; expiresAt: number | null };
  };

  "signal.unwatch": {
    args: { watchId: string; key?: never } | { watchId?: never; key: string };
    result: { removed: number };
  };
};
```

Signal frames themselves are described in [WebSocket Protocol Reference](/reference/websocket-protocol#signals).

## Scheduler: `sched.*`

Scheduler syscalls are Kernel-owned. Schedule records live in Kernel SQLite,
GSV computes timezone-aware next fire times, and Cloudflare Agent schedules are
used only as concrete wake-ups.

The normal user-facing interface for recurring shell-command jobs is `crontab`
or `/var/spool/cron/<user>`. Cron files are desired state: installing or
rewriting a crontab removes and recreates the linked `sched.*` records, so
crontab-backed schedule ids are operational ids, not stable cron identifiers.
Use `sched.list` for status, last result, source, and low-level control.

Runtime behavior:

| Syscall | Handler | Behavior |
|---|---|---|
| `sched.list` | `handleSchedulerList` | Lists schedules visible to the caller. Non-root callers see schedules for their owning user; root may pass `ownerUid`. |
| `sched.add` | `handleSchedulerAdd` | Creates a user-owned schedule, validates the expression and target, computes the next run, and arms a Kernel wake. |
| `sched.update` | `handleSchedulerUpdate` | Updates schedule metadata, expression, enabled state, or target, then re-arms the wake. |
| `sched.remove` | `handleSchedulerRemove` | Removes a schedule and cancels its pending wake when present. |
| `sched.run` | `handleSchedulerRun` | Runs due schedules or force-runs one schedule. `force` requires `id`. |

```ts
type ScheduleExpression =
  | { kind: "at"; atMs: number }
  | { kind: "after"; afterMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; timezone: string };

type ScheduleTarget =
  | { kind: "command.exec"; command: string; cwd?: string; timeoutMs?: number }
  | { kind: "process.spawn"; runAs?: string; label?: string; prompt: string; parentPid?: string; cwd?: string; assignment?: unknown }
  | { kind: "process.event"; pid: string; conversationId?: string; message: string; data?: Record<string, unknown> };

type ScheduleRecord = {
  id: string;
  ownerUid: number;
  name: string;
  description?: string;
  enabled: boolean;
  expression: ScheduleExpression;
  target: ScheduleTarget;
  overlapPolicy: "skip";
  createdAtMs: number;
  updatedAtMs: number;
  state: {
    nextRunAtMs: number | null;
    runningAtMs: number | null;
    lastRunAtMs: number | null;
    lastStatus: "ok" | "error" | "skipped" | null;
    lastError: string | null;
    lastDurationMs: number | null;
    runCount: number;
  };
};

type SchedulerSyscalls = {
  "sched.list": {
    args: { ownerUid?: number; includeDisabled?: boolean; limit?: number; offset?: number };
    result: { schedules: ScheduleRecord[]; count: number };
  };

  "sched.add": {
    args: { name: string; description?: string; enabled?: boolean; expression: ScheduleExpression; target: ScheduleTarget };
    result: { schedule: ScheduleRecord };
  };

  "sched.update": {
    args: { id: string; patch: { name?: string; description?: string | null; enabled?: boolean; expression?: ScheduleExpression; target?: ScheduleTarget } };
    result: { schedule: ScheduleRecord };
  };

  "sched.remove": {
    args: { id: string };
    result: { removed: boolean };
  };

  "sched.run": {
    args: { id?: string; mode?: "due" | "force" };
    result: { ran: number; results: Array<{ scheduleId: string; status: "ok" | "error" | "skipped"; error?: string; summary?: string; durationMs: number; nextRunAtMs?: number | null }> };
  };
};
```

## See also

- [Routing Reference](./routing.md)
- [WebSocket Protocol](./websocket-protocol.md)
- [Architecture Overview](../architecture/)
