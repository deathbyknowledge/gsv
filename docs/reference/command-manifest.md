# Command Manifest Reference

This document defines the proposed command manifest for `gateway-os`.

The goal is to make "instant intelligence shareable commands" a first-class,
portable object that can be issued once, shared as a link or CLI command, and
executed by any compatible GSV surface.

The design intentionally plugs into existing `proc.*` semantics instead of
creating a second execution model.

---

## Design Goals

- One canonical object for "run this intelligence action".
- Transport-neutral: works from web UI, CLI, adapter channels, or future APIs.
- Immutable once issued.
- Secret-free: manifests may reference secrets, but never embed secret values.
- Executable through the existing process model (`proc.spawn`, `proc.send`).
- Shareable without baking in a single return route.
- Capable of narrowing execution rights, but never widening them.

## Non-Goals

- Replacing profiles. Profiles are authoring conveniences; manifests are
  execution truth.
- Replacing tokens, identity links, or adapter routing. Commands sit on top of
  those systems.
- Defining a general package format for apps or skills.

---

## Core Model

There are three distinct objects:

1. `CommandManifest`
   The canonical, immutable execution spec.
2. `IssuedCommand`
   The stored record for a manifest after a user issues it.
3. `CommandExecution`
   A single run of an issued command.

This split matters.

- The manifest is what gets hashed and signed.
- The issued command adds issuer metadata and mutable lifecycle state.
- The execution record tracks an individual launch attempt.

---

## CommandManifest

`CommandManifest` is the canonical payload.

```ts
export type CommandManifest = {
  version: 1;
  kind: "gsv.command";

  title?: string;
  description?: string;

  subject: CommandSubject;
  validity?: CommandValidity;
  policy?: CommandPolicy;

  execution: CommandExecutionSpec;
  context?: CommandContext;
  metadata?: Record<string, string>;
};
```

### Subject

`subject` controls who the command is for.

```ts
export type CommandSubject =
  | { kind: "issuer" }
  | { kind: "uid"; uid: number }
  | { kind: "claim"; maxClaims?: number };
```

Rules:

- `issuer`: only the issuing uid may execute the command.
- `uid`: only the specified uid may execute the command.
- `claim`: the first successful executor claims the command; later execution is
  allowed or denied based on `maxClaims`.

`claim` is the shareable-command mode.

### Validity

```ts
export type CommandValidity = {
  notBeforeAt?: number;
  expiresAt?: number;
  singleUse?: boolean;
};
```

Rules:

- `notBeforeAt` and `expiresAt` are unix timestamps in milliseconds.
- `singleUse` means only one successful execution is allowed, regardless of
  claimant.

### Policy

`policy` narrows or validates execution. It does not grant new power.

```ts
export type CommandPolicy = {
  requiredCapabilities?: string[];
  requestedCapabilities?: string[];
  requiredDevices?: string[];
  preferredDevices?: string[];
};
```

Semantics:

- `requiredCapabilities`: execution fails if the resolved executor identity does
  not have all listed capabilities.
- `requestedCapabilities`: an optional narrowing set. If present, the effective
  execution scope is reduced to this subset.
- `requiredDevices`: execution fails if the listed devices are unavailable.
- `preferredDevices`: hint only. Good for default shell/fs targets.

Important invariant:

- A command may narrow rights. It may never widen rights beyond the executor's
  identity.

### Execution

`execution` maps directly onto `proc.*`.

```ts
export type CommandExecutionSpec = {
  process:
    | { kind: "init" }
    | { kind: "pid"; pid: string }
    | { kind: "spawn"; label?: string; parentPid?: string };

  input:
    | { kind: "message"; message: string };
};
```

Rules:

- `process.kind = "init"` means execute via `proc.send` to `init:{uid}`.
- `process.kind = "pid"` means execute via `proc.send` to an existing process.
- `process.kind = "spawn"` means the kernel creates a child process first, then
  delivers `input.message`.

For v1, `input.kind = "message"` is enough. It matches the current process DO
cleanly and avoids inventing a second agent invocation format.

### Context

`context` carries resolved execution hints, not mutable authoring abstractions.

```ts
export type CommandContext = {
  profile?: {
    id: string;
    version?: string;
    digest?: string;
  };

  ai?: {
    provider?: string;
    model?: string;
    reasoning?: "off" | "low" | "medium" | "high";
  };

  defaults?: {
    shellTarget?: string;
    fsTarget?: string;
  };

  workspace?: {
    repo?: {
      uri: string;
      ref?: string;
      mountPath?: string;
    };
    files?: Array<{
      path: string;
      content: string;
      encoding?: "utf8" | "base64";
    }>;
  };

  secretRefs?: string[];
};
```

Rules:

- `profile` is provenance only. The resolved values that matter for execution
  should be copied into the manifest.
- `secretRefs` contain identifiers only, never raw secret material.
- `workspace.files` should be used sparingly. Large payloads should be stored
  elsewhere and referenced.

---

## IssuedCommand

`IssuedCommand` is the stored record created when a user issues a manifest.

```ts
export type IssuedCommand = {
  commandId: string;
  issuerUid: number;
  createdAt: number;

  manifest: CommandManifest;

  digest: {
    alg: "sha256";
    value: string;
  };

  signature?: {
    alg: "ed25519";
    keyId: string;
    value: string;
  };

  revokedAt: number | null;
  revokedReason: string | null;

  claimedByUid: number | null;
  claimCount: number;
  lastExecutedAt: number | null;
};
```

Notes:

- `commandId` is the stable handle used in links and CLI.
- `digest` is computed from canonical JSON serialization of `manifest`.
- `signature` is optional for local development, but the storage model should
  support it from day one.
- Claim state is mutable record state, not manifest state.

---

## CommandExecution

Each execution attempt gets its own record.

```ts
export type CommandExecutionRecord = {
  executionId: string;
  commandId: string;
  executorUid: number;
  invokedAt: number;

  pid: string;
  runId: string | null;

  routeKind: "connection" | "adapter" | "none";
  routeRef?: Record<string, string>;

  status: "started" | "completed" | "failed";
  error?: string;
};
```

`routeRef` is execution metadata, not manifest data. The same command should be
shareable across different invokers and surfaces.

---

## Recommended Invariants

These are the rules worth being strict about:

1. A manifest is immutable once issued.
2. The canonical manifest does not include mutable counters, claim state, or
   per-execution routing.
3. Commands do not contain raw secrets.
4. Commands do not embed live connection IDs.
5. Commands can narrow capabilities, never widen them.
6. Profiles are resolved at issue time; the manifest is the execution truth.
7. A compliant executor must reject expired, revoked, or malformed commands.

---

## Example

```json
{
  "version": 1,
  "kind": "gsv.command",
  "title": "Fix gateway-os pairing flow",
  "description": "Open the rewrite, implement the bugfix, and report back in the same session.",
  "subject": {
    "kind": "claim",
    "maxClaims": 1
  },
  "validity": {
    "expiresAt": 1775000000000,
    "singleUse": true
  },
  "policy": {
    "requiredCapabilities": ["proc.send", "fs.read", "fs.edit", "shell.exec"],
    "preferredDevices": ["laptop", "buildbox"]
  },
  "execution": {
    "process": {
      "kind": "spawn",
      "label": "pairing-fix"
    },
    "input": {
      "kind": "message",
      "message": "Open gsv/gateway-os, investigate the pairing flow, fix the issue, run tests if available, and summarize the outcome."
    }
  },
  "context": {
    "profile": {
      "id": "fullstack-builder",
      "version": "v3",
      "digest": "sha256:9a3d..."
    },
    "ai": {
      "provider": "workersai",
      "model": "@cf/meta/llama-4-scout-17b-16e-instruct",
      "reasoning": "high"
    },
    "defaults": {
      "shellTarget": "laptop",
      "fsTarget": "laptop"
    },
    "workspace": {
      "repo": {
        "uri": "github:deathbyknowledge/gsv",
        "ref": "main",
        "mountPath": "/workspace"
      }
    },
    "secretRefs": ["github_app", "npm_token"]
  },
  "metadata": {
    "source": "share-link",
    "team": "agents-sdk"
  }
}
```

---

## URL and CLI Form

Do not make the full manifest the primary URL payload.

Preferred pattern:

- Web link: `/c/<commandId>`
- CLI: `gsv command run <commandId-or-url>`

The link resolves to the stored `IssuedCommand`. This keeps URLs small, makes
revocation possible, and avoids giant encoded blobs.

Optional later:

- offline form: `gsv command run --manifest ./command.json`
- signed export/import bundles for air-gapped workflows

---

## Proposed Syscalls

The manifest becomes useful when paired with a minimal syscall surface.

```ts
"sys.command.issue"
"sys.command.get"
"sys.command.list"
"sys.command.revoke"
"sys.command.execute"
```

### sys.command.issue

Create an `IssuedCommand` from a manifest.

```ts
type SysCommandIssueArgs = {
  manifest: CommandManifest;
};

type SysCommandIssueResult = {
  command: IssuedCommand;
  url: string;
  cli: string;
};
```

### sys.command.get

Fetch one issued command by ID.

```ts
type SysCommandGetArgs = {
  commandId: string;
};

type SysCommandGetResult = {
  command: IssuedCommand | null;
};
```

### sys.command.list

List commands visible to the caller.

```ts
type SysCommandListArgs = {
  issuerUid?: number;
  includeRevoked?: boolean;
};

type SysCommandListResult = {
  commands: IssuedCommand[];
};
```

### sys.command.revoke

Revoke an issued command.

```ts
type SysCommandRevokeArgs = {
  commandId: string;
  reason?: string;
};

type SysCommandRevokeResult = {
  revoked: boolean;
};
```

### sys.command.execute

Validate the command, resolve subject/claim state, and translate it into
`proc.spawn` + `proc.send` or plain `proc.send`.

```ts
type SysCommandExecuteArgs = {
  commandId: string;
};

type SysCommandExecuteResult =
  | {
      ok: true;
      commandId: string;
      pid: string;
      runId: string | null;
      claimedByUid?: number;
    }
  | {
      ok: false;
      error: string;
    };
```

Execution behavior:

- `process.kind = "init"`:
  resolve target uid, send to `init:{uid}`, capture `runId`.
- `process.kind = "pid"`:
  validate ownership/access, send directly.
- `process.kind = "spawn"`:
  create child process under the target init, then send the message.

Output routing follows the invoking connection or adapter, exactly like a normal
`proc.send` flow.

---

## Mapping to Current gateway-os

This model fits the current rewrite well:

- `subject` complements existing users, tokens, and identity links.
- `execution` maps directly to `proc.spawn` and `proc.send`.
- `policy.requiredDevices` lines up with the device registry.
- `preferredDevices` can seed future shell/fs defaults without changing syscall
  routing.
- Per-execution output still uses `run_routes`.

That means the manifest is additive. It does not force a re-architecture.

---

## What Should Stay Out of v1

Avoid these in the first version:

- raw secret payloads
- embedded adapter return routes
- arbitrary shell scripts as a top-level execution mode
- complex branching workflows
- mutable profile references as execution truth

Those can come later once the basic issue/share/claim/execute loop is stable.
