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
  | "init" | "task" | "review" | "cron" | "mcp" | "app" | "archivist" | "curator"
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

type OnboardingDraft = {
  lane: "quick" | "customize" | "advanced";
  mode: "manual" | "guided";
  stage: "welcome" | "details" | "review";
  detailStep: "account" | "admin" | "ai" | "source" | "device";
  account: { username: string; password: string; passwordConfirm: string };
  admin: { mode: "same" | "custom"; password: string };
  ai: { enabled: boolean; provider: string; model: string; apiKey: string };
  source: { enabled: boolean; value: string; ref: string };
  device: { enabled: boolean; deviceId: string; label: string; expiryDays: string };
};

type OnboardingAssistPatch = {
  op: "set" | "clear";
  path:
    | "account.username" | "admin.mode" | "ai.enabled" | "ai.provider" | "ai.model"
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

`shell.exec` runs a command on the selected target. Use `gsv` for the Worker sandbox shell, or a device id for local source trees, private networks, OS packages, credentials, or hardware.

Runtime behavior:

| Syscall | Handler | Behavior |
|---|---|---|
| `shell.exec` | `handleShellExec`; CLI `Bash` | Native runs `just-bash` over `GsvFs` with process identity env, core commands such as `pkg` and `notify`, and installed package CLI commands such as `wiki`. Device targets run a real local shell through the CLI. Native defaults `workdir` to process `cwd`, `timeout` to `config/shell/timeout_ms` or 30000 ms, ignores `background` and `yieldMs`, truncates output by `config/shell/max_output_bytes`, and returns command failures as `ok: true` with non-zero `exitCode`. CLI supports background and yielded sessions. |

```ts
type ShellSyscalls = {
  "shell.exec": {
    args: {
      target?: string;
      command: string;
      workdir?: string;
      timeout?: number;
      background?: boolean;
      yieldMs?: number;
    };
    result:
      | { ok: true; pid: number; exitCode: number; stdout: string; stderr: string }
      | { ok: true; pid: number; backgrounded: true }
      | OperationError;
  };
};
```

## Processes: `proc.*`

`proc.*` controls GSV AI processes. These are long-lived agent processes, not shell commands.

Runtime behavior:

| Syscall | Handler | Behavior |
|---|---|---|
| `proc.list` | `handleProcList` | Reads the kernel process registry. Root defaults to all processes; non-root defaults to own uid, though an explicit `uid` is currently honored by the handler. |
| `proc.profile.list` | `handleProcProfileList` | Returns system AI profiles plus enabled package-backed profiles visible to the caller. Package entries are sorted by package name and display name. |
| `proc.spawn` | `handleProcSpawn` | Validates the AI profile, resolves package profiles, materializes workspace and mounts, registers the process, sends kernel-only `proc.setidentity`, and optionally sends the initial prompt. `init` is singleton; other profiles get UUID pids. |
| `proc.send` | Process DO `handleProcSend` | Defaults `pid` to `init:<uid>` when forwarded. Stores media, appends a user message, starts a run if idle, or queues the message if a run is active. Touches workspace activity before forwarding. |
| `proc.abort` | Process DO | Logical cancellation of the active run. Clears pending HIL and current run, emits `chat.complete` with `aborted: true`, and may promote the next queued run. In-flight external work can still resolve later but stale handling guards state. |
| `proc.hil` | Process DO | Resolves a pending human-in-the-loop request. `approve` dispatches the original syscall; `deny` appends a synthetic error tool result. |
| `proc.kill` | Process DO | Checkpoints workspace, clears active run, tool state, HIL, queue, media, and messages. Archives messages unless `archive: false`. Does not remove the kernel process registry entry in normal syscall use. |
| `proc.history` | Process DO | Returns paged stored messages plus message count, truncation status, timestamps, and pending HIL. Tool results and assistant metadata are expanded into structured content. |
| `proc.reset` | Process DO | Checkpoints workspace, clears active execution state and process media, archives existing messages to `/var/sessions/<username>/<pid>/...jsonl.gz`, then clears history. |
| `proc.setidentity` | Process DO direct path | Kernel-only through public dispatch. Stores pid, identity, profile, and assignment context; `assignment.autoStart` can create a run immediately. |

```ts
type ProcWorkspaceSpec =
  | { mode: "none" }
  | { mode: "new"; label?: string; kind?: "thread" | "app" | "shared" }
  | { mode: "inherit" }
  | { mode: "attach"; workspaceId: string };

type ProcContextFile = { name: string; text: string };
type ProcSpawnAssignment = { contextFiles: ProcContextFile[]; autoStart?: boolean };
type ProcSpawnMountSpec =
  | { kind: "package-source"; packageId: string; mountPath?: string }
  | { kind: "package-repo"; packageId: string; mountPath?: string };

type ProcHilRequest = {
  requestId: string;
  runId: string;
  callId: string;
  toolName: string;
  syscall: string;
  args: Record<string, unknown>;
  createdAt: number;
};

type ProcessSyscalls = {
  "proc.list": {
    args: { uid?: number };
    result: { processes: Array<{ pid: string; uid: number; profile: AiContextProfile; parentPid: string | null; state: string; label: string | null; createdAt: number; workspaceId: string | null; cwd: string }> };
  };

  "proc.profile.list": {
    args: Empty;
    result: { profiles: Array<{ id: AiContextProfile; alias?: string; kind: "system" | "package"; displayName: string; description?: string; interactive: boolean; startable: boolean; background: boolean; spawnMode: "singleton" | "new"; packageId?: string; packageName?: string }> };
  };

  "proc.spawn": {
    args: { profile: AiContextProfile; label?: string; prompt?: string; assignment?: ProcSpawnAssignment; parentPid?: string; workspace?: ProcWorkspaceSpec; mounts?: ProcSpawnMountSpec[] };
    result: { ok: true; pid: string; label?: string; profile: AiContextProfile; workspaceId: string | null; cwd: string } | OperationError;
  };

  "proc.send": {
    args: { pid?: string; message: string; media?: MediaInput[] };
    result: { ok: true; status: "started"; runId: string; queued?: boolean } | OperationError;
  };

  "proc.abort": {
    args: { pid?: string };
    result: { ok: true; pid: string; aborted: boolean; runId?: string; interruptedToolCalls?: number; continuedQueuedRunId?: string } | OperationError;
  };

  "proc.hil": {
    args: { pid?: string; requestId: string; decision: "approve" | "deny" };
    result: { ok: true; pid: string; requestId: string; decision: "approve" | "deny"; resumed: boolean; pendingHil?: ProcHilRequest | null } | OperationError;
  };

  "proc.kill": {
    args: { pid: string; archive?: boolean };
    result: { ok: true; pid: string; archivedTo?: string } | OperationError;
  };

  "proc.history": {
    args: { pid?: string; limit?: number; offset?: number };
    result: { ok: true; pid: string; messages: Array<{ role: "user" | "assistant" | "system" | "toolResult"; content: unknown; timestamp?: number }>; messageCount: number; truncated?: boolean; pendingHil?: ProcHilRequest | null } | OperationError;
  };

  "proc.reset": {
    args: { pid?: string };
    result: { ok: true; pid: string; archivedMessages: number; archivedTo?: string } | OperationError;
  };

  "proc.setidentity": {
    args: { pid: string; identity: ProcessIdentity; profile: AiContextProfile; assignment?: ProcSpawnAssignment };
    result: { ok: true; startedRunId?: string };
  };
};
```

`proc.setidentity` is kernel-only. User and device callers receive a forbidden response.

## Packages: `pkg.*`

`pkg.*` manages installed packages, package catalogs, review state, and package visibility. Use `repo.*` for generic repository operations against package source repos.

Runtime behavior:

| Syscall | Handler | Behavior |
|---|---|---|
| `pkg.list` | `handlePkgList` | Lists visible packages with optional `enabled`, exact trimmed `name`, and `runtime` filters. Visible scope is actor user scope first, then global. |
| `pkg.add` | `handlePkgAdd` | Imports a package from `remoteUrl` or GitHub `repo`, resolves and assembles it, stores the artifact, and upserts the package record. Defaults `ref` to `main` and `subdir` to `.`. Non-system imports stay disabled and review-required by default. |
| `pkg.sync` | `handlePkgSync` | Rebuilds builtin package seeds from `system/gsv`, removes stale builtin rows, and preserves existing enabled state. Requires `RIPGIT` and `ASSEMBLER`. Broadcasts `pkg.changed` after success. |
| `pkg.checkout` | `handlePkgCheckout` | Re-resolves an existing package at a new ref and replaces manifest and artifact while preserving grants, enabled state, review flags, and install time. Requires mutable package access. |
| `pkg.install` | `handlePkgInstall` | Enables an installed package. Errors if review is required and not approved. Idempotent when already enabled. |
| `pkg.review.approve` | `handlePkgReviewApprove` | Sets review approval metadata for review-required packages. If review is not required, returns unchanged. |
| `pkg.remove` | `handlePkgRemove` | Disables the package; it does not delete the row. Cannot disable the package named `packages`. |
| `pkg.remote.list` | `handlePkgRemoteList` | Lists current user package catalog remotes from config, sorted by name. Requires identity. |
| `pkg.remote.add` | `handlePkgRemoteAdd` | Stores a current-user remote config key. Remote names must be alphanumeric with dashes; URLs must be HTTP or HTTPS and are normalized. |
| `pkg.remote.remove` | `handlePkgRemoteRemove` | Deletes a current-user remote config key. Returns whether anything was removed. |
| `pkg.public.list` | `handlePkgPublicList` | Lists local public packages, or fetches `<baseUrl>/public/packages` from a named/URL remote. Invalid remote catalog entries are dropped. |
| `pkg.public.set` | `handlePkgPublicSet` | Marks a source repo public or private in config. Requires repo owner, root, or wildcard capability. |

Mutating package calls require root, wildcard capability, or ownership of the package user scope. `pkg.add`, `pkg.sync`, `pkg.install`, `pkg.remove`, and `pkg.checkout` broadcast `pkg.changed` after success.

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
    args: Empty;
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

`repo.*` is the kernel-level interface to ripgit repositories. It exposes versioned content, history, diffs, imports, and atomic commits without modeling a Git index or separate `add` step.

Runtime behavior:

| Syscall | Handler | Behavior |
|---|---|---|
| `repo.list` | `handleRepoList` | Lists repositories visible to the caller. Results include home, workspace, visible package source, and registered user repos. Optional `owner` filters by repo owner. |
| `repo.create` | `handleRepoCreate` | Creates a repository by writing an empty initial commit to `ref`, default `main`. Existing refs return `created: false`. Only root, wildcard, the username owner, or `uid-{uid}` owner can write. |
| `repo.refs` | `handleRepoRefs` | Reads heads and tags. Allows owned repos, public repos, `system/*`, and visible package source repos. |
| `repo.read` | `handleRepoRead` | Reads a tree or file at `repo`, `ref`, and `path`. Defaults `ref` to `main` and `path` to root. Binary files return `content: null`. |
| `repo.search` | `handleRepoSearch` | Searches text in a repo, optionally under `prefix`. Requires a non-empty query. |
| `repo.log` | `handleRepoLog` | Reads first-parent commit history. `limit` defaults to 30 and clamps to 1-100; `offset` defaults to 0. |
| `repo.diff` | `handleRepoDiff` | Reads one commit diff. Requires `commit`; `context` defaults to 3 and clamps to 0-20. |
| `repo.compare` | `handleRepoCompare` | Compares `base` and `head` refs or hashes. `stat: true` omits hunks from ripgit. |
| `repo.apply` | `handleRepoApply` | Atomically commits `put`, `delete`, and `move` operations to one ref. `expectedHead` enables optimistic concurrency. `allowEmpty` permits an empty commit. |
| `repo.import` | `handleRepoImport` | Imports or refreshes a repo from an upstream Git URL/ref into a local ripgit repo. |

Write access is intentionally narrower than read access. Non-root users can write repos owned by their username or by `uid-{uid}`. Public repos and visible package source repos are readable but not writable unless ownership also matches.

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
    result: { repos: Array<{ repo: string; owner: string; name: string; kind: "home" | "workspace" | "package" | "user"; writable: boolean; public: boolean; description?: string; updatedAt?: number }> };
  };

  "repo.create": {
    args: { repo: string; ref?: string; description?: string };
    result: { repo: string; ref: string; head: string | null; created: boolean };
  };

  "repo.refs": {
    args: { repo: string };
    result: { repo: string; heads: Record<string, string>; tags: Record<string, string> };
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
    args: { repo: string; ref?: string; remoteUrl: string; remoteRef?: string; message?: string };
    result: { repo: string; ref: string; head: string | null; changed: boolean; remoteUrl: string; remoteRef: string };
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
| `sys.setup` | `handleSysSetup` | Pre-connect setup-mode bootstrap. Creates first user, root password, groups/home, optional AI config, optional node token, home layout, and optional system bootstrap. Username and password are validated. |
| `sys.bootstrap` | `handleSysBootstrap` | Imports `system/gsv`, seeds builtin packages, mirrors stable/dev CLI assets, stores default CLI channel, and broadcasts `pkg.changed`. Defaults repo to `deathbyknowledge/gsv` and ref to `main`. Requires `RIPGIT` and storage. |
| `sys.config.get` | `handleSysConfigGet` | Reads exact config key or visible prefix. Root sees all; non-root sees own `users/<uid>/` keys and non-sensitive `config/` keys. Sensitive names such as password, token, secret, and api key are hidden from non-root. |
| `sys.config.set` | `handleSysConfigSet` | Writes a config value. Root can write any key; non-root can write only own user-overridable keys, currently under `users/<uid>/ai/`. Values are coerced with `String(value)`. |
| `sys.device.list` | `handleSysDeviceList` | Lists devices accessible by owner uid or group ACL. Root sees all. Defaults to online devices only unless `includeOffline` is true. |
| `sys.device.get` | `handleSysDeviceGet` | Reads one device descriptor. Missing or inaccessible devices return `device: null` rather than a permission error. |
| `sys.workspace.list` | `handleSysWorkspaceList` | Lists workspaces for caller uid by default. Root may request any uid; non-root may only request self. Adds active process summary and process count. |
| `sys.token.create` | `handleSysTokenCreate` | Creates a hashed node, service, or user token. Root may target any uid. Role defaults must match token kind; driver/node tokens may bind to `allowedDeviceId`. Raw token is returned only once. |
| `sys.token.list` | `handleSysTokenList` | Lists token metadata, including revoked tokens, never raw token values. Non-root is scoped to self; root can list all or one uid. |
| `sys.token.revoke` | `handleSysTokenRevoke` | Revokes a token by id with optional reason. Non-root can revoke only own tokens. Missing or inaccessible token returns `revoked: false`. |
| `sys.link` | `handleSysLink` | User-role only. Links an adapter/account/actor to a uid. Adapter is lowercased; root may link to any uid, non-root only self. |
| `sys.unlink` | `handleSysUnlink` | User-role only. Removes an adapter identity link. Missing links return `removed: false`; non-root can unlink only self-owned links. |
| `sys.link.list` | `handleSysLinkList` | User-role only. Lists identity links newest-first. Non-root is implicitly scoped to self; root may list all or filter by uid. |
| `sys.link.consume` | `handleSysLinkConsume` | User-role only. Consumes an uppercase link challenge code for the caller uid, marks the challenge used, and creates/replaces the identity link. Invalid, expired, or used codes throw. |

`sys.connect`, `sys.setup`, and `sys.setup.assist` are special-cased before normal auth/capability dispatch. Other `sys.*` calls require a connected identity and are denied in setup mode.

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
    args: { username: string; password: string; rootPassword?: string; bootstrap?: { remoteUrl?: string; repo?: string; ref?: string }; ai?: { provider?: string; model?: string; apiKey?: string }; node?: { deviceId: string; label?: string; expiresAt?: number } };
    result: { user: ProcessIdentity; rootLocked: boolean; bootstrap?: SystemSyscalls["sys.bootstrap"]["result"]; nodeToken?: { tokenId: string; token: string; tokenPrefix: string; uid: number; kind: "node"; label: string | null; allowedRole: "driver" | null; allowedDeviceId: string | null; createdAt: number; expiresAt: number | null } };
  };

  "sys.bootstrap": {
    args: { remoteUrl?: string; repo?: string; ref?: string };
    result: { repo: string; remoteUrl: string; ref: string; head: string | null; changed: boolean; cli: { defaultChannel: "stable" | "dev"; mirroredChannels: Array<"stable" | "dev">; assets: string[] }; packages: BootstrapPackageSummary[] };
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
    result: { devices: Array<{ deviceId: string; ownerUid: number; platform: string; version: string; online: boolean; lastSeenAt: number }> };
  };

  "sys.device.get": {
    args: { deviceId: string };
    result: { device: ({ deviceId: string; ownerUid: number; platform: string; version: string; online: boolean; lastSeenAt: number; implements: string[]; firstSeenAt: number; connectedAt: number | null; disconnectedAt: number | null }) | null };
  };

  "sys.workspace.list": {
    args: { uid?: number; kind?: "thread" | "app" | "shared"; state?: "active" | "archived"; limit?: number };
    result: { workspaces: Array<{ workspaceId: string; ownerUid: number; label: string | null; kind: "thread" | "app" | "shared"; state: "active" | "archived"; createdAt: number; updatedAt: number; defaultBranch: string; headCommit: string | null; activeProcess: { pid: string; label: string | null; cwd: string; createdAt: number } | null; processCount: number }> };
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
| `ai.tools` | `handleAiTools` | Process-internal. Lists online accessible devices and filters built-in tool definitions by caller capabilities. Routable filesystem and shell tools are wrapped with required `target`. |
| `ai.config` | `handleAiConfig` | Process-internal. Resolves user override then system AI config. Defaults profile to `task`, provider to `workers-ai`, model to `@cf/nvidia/nemotron-3-120b-a12b`, max tokens to 8192, and context budget to 32768 bytes. Package profiles load manifest context files and approval policy. |

External callers cannot normally invoke `ai.*`; these syscalls are exposed to process-originated calls.

```ts
type AiSyscalls = {
  "ai.tools": {
    args: Empty;
    result: { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>; devices: Array<{ id: string; implements: string[]; platform?: string }> };
  };

  "ai.config": {
    args: { profile?: AiContextProfile };
    result: { profile?: AiContextProfile; provider: string; model: string; apiKey: string; reasoning?: string; maxTokens: number; profileContextFiles?: Array<{ name: string; text: string }>; profileApprovalPolicy?: string | null; maxContextBytes: number };
  };
};
```

## Adapters: `adapter.*`

`adapter.*` is the control plane for external chat or channel connectors.

Runtime behavior:

| Syscall | Handler | Behavior |
|---|---|---|
| `adapter.connect` | `handleAdapterConnect` | Calls service binding `CHANNEL_<ADAPTER>.adapterConnect(accountId, config)`, then best-effort refreshes live status. Requires non-empty adapter and account id. Missing service or method returns operation error. |
| `adapter.disconnect` | `handleAdapterDisconnect` | Calls adapter disconnect, upserts local status as disconnected and unauthenticated, then best-effort refreshes live status. |
| `adapter.inbound` | `handleAdapterInbound` | Service-role only. Lowercases adapter, resolves linked user, drops unlinked non-DM messages, issues link challenges for unlinked DMs, ensures the user init process exists, handles pending HIL confirmations, and otherwise forwards rendered text/media to `proc.send`. |
| `adapter.state.update` | `handleAdapterStateUpdate` | Service-role only. Upserts local adapter status and broadcasts `adapter.status` to service-role connections after successful dispatch. |
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

Scheduler syscalls are typed but currently return `501 not yet implemented` from the dispatcher.

Runtime behavior:

| Syscall | Handler | Behavior |
|---|---|---|
| `sched.list` | none | Dispatch returns `501 sched.list not yet implemented`. |
| `sched.add` | none | Dispatch returns `501 sched.add not yet implemented`. |
| `sched.update` | none | Dispatch returns `501 sched.update not yet implemented`. |
| `sched.remove` | none | Dispatch returns `501 sched.remove not yet implemented`. |
| `sched.run` | none | Dispatch returns `501 sched.run not yet implemented`. |

```ts
type CronSchedule =
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "at"; atMs: number }
  | { kind: "cron"; expr: string; tz?: string };

type CronMode = {
  sessionKey?: string;
  message?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  deliver?: boolean;
  channel?: string;
  to?: string;
};

type CronJob = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  spec: CronMode;
  state: {
    nextRunAtMs?: number;
    runningAtMs?: number;
    lastRunAtMs?: number;
    lastStatus?: "ok" | "error" | "skipped";
    lastError?: string;
    lastDurationMs?: number;
  };
};

type SchedulerSyscalls = {
  "sched.list": {
    args: { includeDisabled?: boolean; limit?: number; offset?: number };
    result: { jobs: CronJob[]; count: number };
  };

  "sched.add": {
    args: { name: string; description?: string; enabled?: boolean; deleteAfterRun?: boolean; schedule: CronSchedule; spec: CronMode };
    result: { job: CronJob };
  };

  "sched.update": {
    args: { id: string; patch: { name?: string; description?: string; enabled?: boolean; deleteAfterRun?: boolean; schedule?: CronSchedule; spec?: Partial<CronMode> } };
    result: { job: CronJob };
  };

  "sched.remove": {
    args: { id: string };
    result: { removed: boolean };
  };

  "sched.run": {
    args: { id?: string; mode?: "due" | "force" };
    result: { ran: number; results: Array<{ jobId: string; status: "ok" | "error" | "skipped"; error?: string; summary?: string; durationMs: number; nextRunAtMs?: number }> };
  };
};
```
