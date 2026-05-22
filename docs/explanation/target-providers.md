# Target Providers

GSV agents currently see the world mostly through a small Linux-like toolset:
filesystem operations, shell execution, process control, schedules, and targetable
devices. That is the right interaction model, but the set of targets is too
narrow. The user's real operating surface also includes the web shell, open apps,
browser-local state, and external adapters such as WhatsApp or Discord.

The goal is to make those surfaces visible through the same tool model instead of
adding special-purpose agent tools.

## Principle

Every user interaction surface can be a target provider.

The agent-facing invariant stays:

```text
same tools + target parameter + advertised capabilities
```

Targets may include:

- `gsv`: the native Kernel/GSV filesystem and shell target.
- local devices connected through the CLI daemon.
- browser shell sessions connected from the web desktop.
- adapter accounts such as WhatsApp or Discord.
- later, package app surfaces or individual app windows.

Targets advertise which operations they implement. A target does not need to
support every filesystem or shell operation to be useful.

## Trust Model

The process agent is the user's personal agent running in the user's trusted GSV
environment. We should not design this as if the agent were an untrusted web
script.

Powerful operations such as DOM mutation, clipboard writes, JavaScript execution,
or sending adapter messages are valid capabilities. Safety belongs in the
existing GSV layers:

- user and package capability grants
- process profile configuration
- tool approval policy
- target-specific implementation checks
- audit/history/logging

This means browser-side JavaScript execution can be a first-class browser shell
command when the target exposes it, rather than a permanently hidden debug escape
hatch.

## Target Descriptor

The current device registry can evolve into a more general target registry while
keeping device compatibility.

Useful target metadata:

```ts
type TargetKind =
  | "gsv"
  | "native-device"
  | "browser-shell"
  | "adapter"
  | "app-surface";

type TargetDescriptor = {
  targetId: string;
  kind: TargetKind;
  ownerUid: number;
  label: string;
  description?: string;
  online: boolean;
  implements: Array<"fs.read" | "fs.write" | "fs.edit" | "fs.delete" | "fs.search" | "shell.exec">;
  commandNamespaces?: string[];
  fsRoots?: Array<{ path: string; description: string; writable: boolean }>;
};
```

For now, the existing device descriptor shape is enough. Browser targets,
native devices, and future adapter targets can keep using the same routable
target IDs and `implements` metadata unless a concrete product need appears for
a separate target registry.

## Browser Shell Target

The web shell should register a target after authenticated `sys.connect`.

Current naming:

```text
browser:<connectionId>
```

It should expose a browser-local filesystem plus live desktop/app state.

Current filesystem layout:

```text
/
  run/gsv/
    desktop/
      windows.json
      active-window
      active-window.json
    windows/
      <windowId>/
        meta.json
        app.txt
        mode.txt
        route.txt
        title.txt
    apps/
      <appId>/
        manifest.json
        windows.json
    apps.json
  home/browser/
  tmp/
```

ZenFS is a good fit for browser-local backing storage:

- `/run/gsv`: read-only live mount backed by web shell state.
- `/home/browser`: browser-private persistent files.
- `/tmp`: local scratch space.

The browser target can also ship a browser build of `just-bash` with extra
builtins:

```bash
windows list
window focus <windowId>
app open shell
open /tmp/report.pdf
open rearden:/home/hank/image.png
clipboard read
clipboard write "text"
dom snapshot <windowId>
dom query <windowId> "button[data-action=save]"
dom click <windowId> "button[data-action=save]"
dom click <windowId> --xy 120 80
dom focus <windowId> "input[name=email]"
dom input <windowId> "input[name=email]" "hank@example.com"
js run --window <windowId> "return document.title"
notify --level success "Done" "The browser task finished."
```

These are normal target capabilities. The target decides how each command maps to
browser APIs and app/window internals.

## Adapter Surfaces

Adapters, previously called channels in some older code/docs, are the same
concept here: external communication surfaces such as WhatsApp or Discord.

Adapter workers should keep owning platform-specific behavior:

- inbound event normalization through `adapter.inbound`
- outbound delivery through `adapter.send`
- account/auth state through adapter control syscalls
- platform-specific commands such as send, reply, react, upload, or typing

We should not pretend that an adapter account is a mounted phone filesystem.
WhatsApp does not provide generic `fs.read` access to the user's phone. The
useful abstraction is "the user has WhatsApp available" plus specific adapter
commands and surfaces.

An adapter may still expose a target when that is useful, but the descriptor
should advertise only real capabilities. For example, a WhatsApp target might
support custom shell commands for sending a message, replying, reacting, and
attaching a file. A minimal read-only recent-message window could be added later,
but it should not be required for adapter integration.

## Work Batches

### Batch 1: Interaction Origin

Status: implemented.

- Add a persisted `InteractionOrigin` message metadata shape.
- Have the Kernel derive trusted origins for client, app, device, process, and
  adapter sends instead of trusting caller-supplied metadata.
- Store origin metadata in process messages and queued messages.
- Return origin metadata through `proc.history`.
- Preserve existing run routes for replies; origin metadata is provenance, not
  the response route.

### Batch 2: Origin-Aware Context And UI

Status: implemented.

- Render origin metadata in process model context where it helps the agent
  understand where a request came from, using source-boundary `[From: ...]`
  markers instead of repeating the same source on every message.
- Stop encoding origin-like information in message role or ad hoc text prefixes
  when structured origin is available.
- Show origin in Chat/process history UI in a compact native way.
- Keep process, app, and adapter messages structurally valid for provider
  history.

### Batch 3: Adapter Availability And Commands

- Expose per-user adapter availability as a simple capability surface, for
  example "available: WhatsApp, Discord".
- Keep account identifiers and linked external actor IDs out of the main
  agent-facing surface unless needed for a specific operation.
- Add adapter-specific command surfaces for send, reply, react, attach, typing,
  and status.
- Keep generic `adapter.*` syscalls as adapter control/ingress paths.

### Batch 4: Unified Target Provider

- Use one target provider/descriptor path for native devices, browser targets,
  and adapter-provided targets.
- Keep the current target descriptor shape until a concrete product need requires
  more metadata.
- Preserve `target` as the single selector for routed filesystem and shell
  operations.
- Do not add a separate adapter target registry.

### Batch 5: Browser Automation

- Add live window snapshots:
  - DOM snapshot
  - accessibility-oriented DOM metadata
  - screenshot if feasible
- Add DOM interaction commands:
  - query
  - click
  - focus
  - input text
- Add `js run` for explicit JavaScript execution in a selected window/app
  context.
- Wire actions through the web shell host bridge so package app windows can opt
  into the right level of state/action exposure.

### Batch 6: Browser Filesystem

- Add ZenFS to the browser target.
- Mount in-memory `/tmp`.
- Mount persistent IndexedDB-backed `/home` or `/browser`.
- Keep live desktop/app paths as synthetic mounts.
- Decide whether browser-local files should sync or remain local-only by default.

### Batch 7: Polish and Observability

- Add target status UI in the GSV system console.
- Add target activity/audit logs.
- Show target capabilities, command namespaces, and mounted roots.
- Make approval policy messages target-aware.
- Add docs for target implementers.

## Open Design Questions

- Exact naming for browser targets and any adapter-provided targets.
- Whether `sys.target.*` should be introduced immediately or after the device
  registry grows target kinds.
- Whether browser target registration should be tied to each web shell tab,
  each authenticated user session, or one active desktop per user.
- How much app state is exposed automatically versus through app-declared host
  bridge methods.
- Whether binary/browser file transfer should use existing stream/pipe work from
  the cross-target transfer path.
