export type ArchitectureSubsystemId =
  | "gateway"
  | "kernel"
  | "process"
  | "conversation"
  | "protocol"
  | "native-target"
  | "inference"
  | "sdk"
  | "services"
  | "web"
  | "host"
  | "adapters"
  | "extension"
  | "ripgit";

export type ArchitectureCategory =
  | "edge"
  | "control"
  | "execution"
  | "record"
  | "contract"
  | "target"
  | "provider"
  | "client"
  | "service"
  | "transport"
  | "storage";

export type ArchitectureComponent = {
  id: string;
  label: string;
  summary: string;
  mechanics: readonly string[];
  paths: readonly string[];
};

export type ArchitectureSubsystem = {
  id: ArchitectureSubsystemId;
  label: string;
  shortLabel: string;
  category: ArchitectureCategory;
  sourceRoot: string;
  summary: string;
  owns: readonly string[];
  boundary: string;
  invariant: string;
  position: { x: number; y: number; height: number };
  components: readonly ArchitectureComponent[];
};

export type ArchitectureEdgeKind = "request" | "control" | "data" | "contract";

export type ArchitectureEdge = {
  id: string;
  from: ArchitectureSubsystemId;
  to: ArchitectureSubsystemId;
  label: string;
  kind: ArchitectureEdgeKind;
};

export type ArchitectureFlowStep = {
  subsystemId: ArchitectureSubsystemId;
  componentId?: string;
  label: string;
  detail: string;
};

export type ArchitectureFlow = {
  id: string;
  label: string;
  summary: string;
  steps: readonly ArchitectureFlowStep[];
};

export type ArchitectureSearchResult = {
  subsystemId: ArchitectureSubsystemId;
  componentId?: string;
  label: string;
  path?: string;
  summary: string;
  score: number;
};

export const ARCHITECTURE_SUBSYSTEMS = [
  {
    id: "gateway",
    label: "GATEWAY EDGE",
    shortLabel: "GATEWAY",
    category: "edge",
    sourceRoot: "gateway/src/",
    summary: "The globally reachable front door. It resolves a trusted installation before routing HTTP, WebSocket, Git, asset, and service-binding traffic to the installation's durable owners.",
    owns: [
      "HTTP, WebSocket, Git, OAuth, asset, and service-binding entrypoints",
      "Trusted hostname to immutable installation identity resolution",
      "Installation lifecycle admission and physical storage scoping",
    ],
    boundary: "The edge selects an installation and transport route. Authorization and durable control-plane truth begin in the Kernel.",
    invariant: "A public caller never chooses an installationId, and an arbitrary wildcard hostname must not allocate Durable Object state.",
    position: { x: 50, y: 23, height: 78 },
    components: [
      {
        id: "edge-router",
        label: "EDGE ROUTER",
        summary: "Classifies public requests and forwards only resolved installation traffic to the correct owner.",
        mechanics: [
          "Serves health, browser assets, OAuth metadata, WebSockets, Git HTTP, federation, and private service entrypoints.",
          "Exports the Kernel, Process, and Conversation Durable Object classes used by the deployment.",
        ],
        paths: ["gateway/src/index.ts", "gateway/src/public-assets.ts", "gateway/src/git.ts"],
      },
      {
        id: "installation-routing",
        label: "INSTALLATION ROUTING",
        summary: "Converts trusted host routing into the immutable identity used to address every installation-owned resource.",
        mechanics: [
          "Managed hosts resolve through the installation directory before a named Kernel is addressed.",
          "Standalone deployments preserve the explicit singleton projection for supported upgrades.",
        ],
        paths: [
          "gateway/src/installation/identity.ts",
          "gateway/src/installation/routing.ts",
          "gateway/src/installation/lifecycle.ts",
        ],
      },
      {
        id: "installation-storage",
        label: "PHYSICAL SCOPING",
        summary: "Injects installation scope into R2 and ripgit addresses while retaining the supported standalone layout.",
        mechanics: [
          "Creates installation-qualified storage views instead of trusting paths supplied by callers.",
          "Keeps the physical isolation rule below stable filesystem and repository contracts.",
        ],
        paths: ["gateway/src/installation/storage.ts", "gateway/src/installation/ripgit.ts"],
      },
      {
        id: "service-entrypoints",
        label: "SERVICE ENTRYPOINTS",
        summary: "Admits first-party adapters and managed mail through deployment-owned, attenuated service identities.",
        mechanics: [
          "Binding props choose adapter identity and callable grants; an incoming frame cannot self-declare either.",
          "Body ownership is cancelled on failed handoff so binary streams cannot be orphaned.",
        ],
        paths: ["gateway/src/index.ts", "gateway/src/adapter-interface.ts"],
      },
    ],
  },
  {
    id: "kernel",
    label: "KERNEL CONTROL PLANE",
    shortLabel: "KERNEL",
    category: "control",
    sourceRoot: "gateway/src/kernel/",
    summary: "GSV's policy authority and switchboard. The Kernel authenticates peers, enforces capabilities, owns control-plane state, and routes every syscall to its durable or target owner.",
    owns: [
      "Identity, authorization, capabilities, configuration, and registries",
      "Syscall dispatch, peer routing, process lifecycle, schedules, and signals",
      "Adapter links, run routes, MCP connections, responsibilities, and user connections",
    ],
    boundary: "The Kernel coordinates work but does not own model-loop history, provider quirks, UI presentation, or platform-native execution.",
    invariant: "Authority is derived from an authenticated principal and Kernel grant—never from transport, claimed peer ID, or advertised implementations.",
    position: { x: 50, y: 43, height: 128 },
    components: [
      {
        id: "kernel-do",
        label: "KERNEL DURABLE OBJECT",
        summary: "The serialized, installation-scoped control-plane actor and composition root for Kernel stores and handlers.",
        mechanics: [
          "Kernel SQLite stores the directories and registries required for policy, routing, and recovery.",
          "A narrow context object supplies dependencies to handlers instead of hiding ownership in globals.",
        ],
        paths: ["gateway/src/kernel/do.ts", "gateway/src/kernel/context.ts", "gateway/src/kernel/schema/"],
      },
      {
        id: "identity-policy",
        label: "IDENTITY + POLICY",
        summary: "Authenticates humans, machines, and services, then intersects group capabilities with resource ownership rules.",
        mechanics: [
          "Connection metadata describes a peer; credentials determine its principal and grant.",
          "Capabilities are necessary but handlers still enforce account, process, workspace, target, and repository ownership.",
        ],
        paths: [
          "gateway/src/kernel/connect.ts",
          "gateway/src/kernel/peer.ts",
          "gateway/src/kernel/capabilities.ts",
          "gateway/src/kernel/account-access.ts",
        ],
      },
      {
        id: "dispatch-routing",
        label: "DISPATCH + ROUTING",
        summary: "Resolves syscall ownership and target selection at one central boundary.",
        mechanics: [
          "Native calls stay in-process; remote calls create a fenced route to a visible, online peer that implements the syscall.",
          "Timeouts, disconnects, cancellation, responses, and body streams clean up the same owned route.",
        ],
        paths: [
          "gateway/src/kernel/dispatch.ts",
          "gateway/src/kernel/routing.ts",
          "gateway/src/kernel/targets.ts",
          "gateway/src/kernel/shell-sessions.ts",
        ],
      },
      {
        id: "process-control",
        label: "PROCESS CONTROL",
        summary: "Owns the process registry, admission policy, IPC routing, schedules, and terminal lifecycle decisions.",
        mechanics: [
          "Spawn, fork, send, abort, reset, and kill remain distinct operations with explicit ownership checks.",
          "A killed PID is terminal and cannot silently name a replacement after Durable Object eviction.",
        ],
        paths: [
          "gateway/src/kernel/processes.ts",
          "gateway/src/kernel/proc-handlers.ts",
          "gateway/src/kernel/ipc-calls.ts",
          "gateway/src/kernel/scheduler.ts",
        ],
      },
      {
        id: "delivery-coordination",
        label: "DELIVERY + COORDINATION",
        summary: "Bridges processes to canonical conversations, endpoint routes, adapters, responsibilities, and durable follow-up work.",
        mechanics: [
          "A run route directs transient output to one origin; it never owns canonical history.",
          "The responsibility ledger survives individual runs and remains visible according to the process's role.",
        ],
        paths: [
          "gateway/src/kernel/conversation-handlers.ts",
          "gateway/src/kernel/run-routes.ts",
          "gateway/src/kernel/adapter-handlers.ts",
          "gateway/src/kernel/responsibilities.ts",
        ],
      },
      {
        id: "schema",
        label: "KERNEL SCHEMA",
        summary: "Evolves relational control-plane state through ordered, immutable SQLite migrations.",
        mechanics: [
          "Migrations run before stores use the schema and are checksummed by the shared runner.",
          "Relational state is never created ad hoc from store constructors.",
        ],
        paths: ["gateway/src/kernel/schema/", "gateway/src/schema/runner.ts"],
      },
    ],
  },
  {
    id: "process",
    label: "DURABLE PROCESS",
    shortLabel: "PROCESS",
    category: "execution",
    sourceRoot: "gateway/src/process/",
    summary: "A real durable agent process. It owns one serialized model loop, private execution history, queued input, pending tools, approvals, cancellation, context epochs, and process-scoped media.",
    owns: [
      "Agent generation loop and provider-valid execution history",
      "Queued input, pending tools, approvals, cancellation, and compaction",
      "Frozen prompt/context epochs, process activity, and run-scoped media",
    ],
    boundary: "A Process executes under a Kernel-issued identity. It does not grant itself capabilities or own the canonical user-facing conversation.",
    invariant: "Late output from a cancelled or superseded run cannot mutate the active run, and every pending tool call receives one structurally valid terminal result.",
    position: { x: 32, y: 62, height: 108 },
    components: [
      {
        id: "agent-loop",
        label: "AGENT LOOP",
        summary: "Assembles context, calls the model, handles tool calls, and advances one durable run to a terminal boundary.",
        mechanics: [
          "Human-facing runs may commit zero or more Messages and must eventually execute yield.",
          "Bounded IPC work returns an ordinary durable Process result independently of human delivery.",
        ],
        paths: ["gateway/src/process/do.ts", "docs/architecture/agent-loop.md"],
      },
      {
        id: "process-store",
        label: "HISTORY + STATE",
        summary: "Persists messages, tool state, queues, run metadata, traces, and lifecycle fences in Process SQLite.",
        mechanics: [
          "Work is registered durably before external dispatch so restart recovery has an authoritative baseline.",
          "Process history retains reasoning and tools for inspection but is not the canonical conversation.",
        ],
        paths: ["gateway/src/process/store.ts", "gateway/src/process/history.ts", "gateway/src/process/schema/"],
      },
      {
        id: "context-epoch",
        label: "CONTEXT EPOCH",
        summary: "Freezes the rendered system prompt and initial availability projection, then records meaningful changes as ordered events.",
        mechanics: [
          "Context providers project system policy, run-as account, home, owner, skills, targets, MCP, date, and responsibilities.",
          "Reset, replacement, compaction, or standing-context change closes and archives the exact epoch.",
        ],
        paths: [
          "gateway/src/process/context/",
          "gateway/src/process/context-pressure.ts",
          "docs/architecture/responsibilities-and-context-epochs.md",
        ],
      },
      {
        id: "tools-approvals",
        label: "TOOLS + APPROVALS",
        summary: "Owns CodeMode execution, pending tool/result consistency, human-in-the-loop decisions, and run-control commands.",
        mechanics: [
          "Approved calls cross the Kernel syscall boundary with the Process identity and active-run fence.",
          "Exact Process-owned message send and yield commands control durable human delivery.",
        ],
        paths: [
          "gateway/src/process/codemode.ts",
          "gateway/src/process/approval.ts",
          "gateway/src/process/tool-response.ts",
          "gateway/src/process/run-control-command.ts",
        ],
      },
      {
        id: "process-media",
        label: "PROCESS MEDIA",
        summary: "Stages model and tool media once, retains durable references, and resolves bytes only for explicit reads or model context.",
        mechanics: [
          "Temporary keys are scoped to the owning process and cleanup follows reset/kill ownership.",
          "History stores immutable references instead of duplicating potentially large bytes.",
        ],
        paths: ["gateway/src/process/media.ts", "gateway/src/process/tool-result-media.ts"],
      },
    ],
  },
  {
    id: "conversation",
    label: "CONVERSATION LEDGER",
    shortLabel: "MESSAGES",
    category: "record",
    sourceRoot: "gateway/src/conversation/",
    summary: "The stable user-visible record. Conversation Durable Objects retain only committed Messages and immutable resource references across Process reset, replacement, or deletion.",
    owns: [
      "Canonical Ship, Work, and adapter-group message histories",
      "Message idempotency receipts, resource references, and archive indexes",
      "Hot SQLite retention and immutable R2 archive segments",
    ],
    boundary: "Conversation history is intentionally smaller than Process activity: drafts, reasoning, tool calls, and uncommitted output stay with the Process.",
    invariant: "Only an explicit Process commit becomes a user-visible Message, and every referenced non-durable source is retained at an exact revision first.",
    position: { x: 67, y: 61, height: 92 },
    components: [
      {
        id: "conversation-do",
        label: "CONVERSATION DO",
        summary: "Serializes canonical Message commits, replay protection, reads, synchronization, and archival decisions.",
        mechanics: [
          "Each Message records the handling PID and run ID so raw execution remains inspectable.",
          "The stable Ship conversation survives replacement of its ordinary personal Process PID.",
        ],
        paths: ["gateway/src/conversation/do.ts", "gateway/src/conversation/schema/"],
      },
      {
        id: "message-store",
        label: "HOT + ARCHIVE STORE",
        summary: "Keeps recent canonical messages in SQLite and rolls immutable older segments into installation-scoped R2.",
        mechanics: [
          "The archive index remains in the owning Conversation so reads preserve ordering.",
          "Reset and kill cleanup do not confuse Process media with Conversation-owned references.",
        ],
        paths: ["gateway/src/conversation/store.ts", "docs/architecture/conversations.md"],
      },
      {
        id: "kernel-bridge",
        label: "KERNEL BRIDGE",
        summary: "Resolves conversation identity, commits Process messages, and distributes committed synchronization signals.",
        mechanics: [
          "The originating endpoint receives transient streaming through its run route.",
          "Other clients and adapters consume committed Messages without inheriting that endpoint's delivery behavior.",
        ],
        paths: ["gateway/src/kernel/conversations.ts", "gateway/src/kernel/conversation-handlers.ts"],
      },
      {
        id: "resource-references",
        label: "RESOURCE REFERENCES",
        summary: "Carries durable file/media identity in Message metadata while leaving large bytes in their owning store.",
        mechanics: [
          "Bytes are hydrated lazily for an explicit resource read or while building model context.",
          "One immutable revision can be referenced by many views without duplicating content.",
        ],
        paths: ["docs/architecture/resource-references.md", "packages/gsv/src/protocol/resource.ts"],
      },
    ],
  },
  {
    id: "protocol",
    label: "SYSCALL + FRAME BOUNDARY",
    shortLabel: "PROTOCOL",
    category: "contract",
    sourceRoot: "gateway/src/protocol/ + gateway/src/syscalls/",
    summary: "The primitive runtime language. Explicit request, response, signal, and body contracts are shared across browsers, native clients, machines, services, the Kernel, and Processes.",
    owns: [
      "Gateway frame decoding and Process-private frame contracts",
      "Target-routable syscall adapters and fixed model-facing tools",
      "Streaming-body ownership, cancellation, and run activity framing",
    ],
    boundary: "Presentation can differ between Shell, CodeMode, SDK, and apps, but the underlying syscall semantics cannot fork by caller or target.",
    invariant: "Every accepted body has one owner and one terminal outcome: consumed, forwarded, or cancelled.",
    position: { x: 25, y: 39, height: 74 },
    components: [
      {
        id: "wire-frames",
        label: "WIRE FRAMES",
        summary: "Decodes typed requests, responses, signals, binary descriptors, and cancellation without letting hostile wire data leak inward unvalidated.",
        mechanics: [
          "Structured metadata remains in frames while large or binary payloads use separately owned bodies.",
          "Process activity streaming has its own typed lifecycle frames.",
        ],
        paths: [
          "gateway/src/protocol/frames.ts",
          "gateway/src/protocol/decode-wire-frame.ts",
          "gateway/src/protocol/process-frames.ts",
          "gateway/src/protocol/process-run-stream.ts",
        ],
      },
      {
        id: "model-tools",
        label: "MODEL TOOL SURFACE",
        summary: "Maps the fixed Read, Write, Edit, Delete, Search, Shell, and CodeMode interface onto ordinary syscalls.",
        mechanics: [
          "New capabilities compose below the fixed surface through syscalls, targets, shell commands, or CodeMode.",
          "The target argument selects a capability environment without changing the tool contract.",
        ],
        paths: ["gateway/src/syscalls/constants.ts", "gateway/src/syscalls/index.ts", "gateway/src/syscalls/"],
      },
      {
        id: "process-frames",
        label: "PROCESS FRAMES",
        summary: "Carries private Kernel-to-Process control, Process-to-Kernel commits, activity, and terminal outcomes.",
        mechanics: [
          "Process-owned commands do not grow the model tool surface.",
          "Run IDs and process identity fence every state-changing result.",
        ],
        paths: ["gateway/src/protocol/process-frames.ts", "gateway/src/kernel/do.ts"],
      },
      {
        id: "syscall-reference",
        label: "PUBLIC SEMANTICS",
        summary: "Documents the stable behavior that every caller and target implementation must preserve.",
        mechanics: [
          "Authorization belongs to the Kernel boundary even when a UI hides unavailable actions.",
          "Remote cancellation cleans up the request route without recursively killing an already-created shell session.",
        ],
        paths: ["docs/reference/syscalls.md", "docs/reference/websocket-protocol.md", "docs/reference/routing.md"],
      },
    ],
  },
  {
    id: "native-target",
    label: "NATIVE GSV TARGET",
    shortLabel: "GSV TARGET",
    category: "target",
    sourceRoot: "gateway/src/drivers/native/ + gateway/src/fs/",
    summary: "The in-process Unix-shaped capability environment behind target `gsv`: a mounted filesystem, bounded shell, network access, commands, and CodeMode-compatible primitives.",
    owns: [
      "Native fs.*, shell.exec, and net.fetch implementations",
      "GsvFs mount routing across virtual state, R2, media, homes, and repositories",
      "Composable command environment and native session execution",
    ],
    boundary: "Unix-shaped means familiar paths, commands, streams, cancellation, and composition where real—it is not a POSIX compatibility claim.",
    invariant: "A target exposes one coherent subset of stable syscall semantics; it is an environment, not merely a physical machine or arbitrary provider RPC.",
    position: { x: 48, y: 82, height: 84 },
    components: [
      {
        id: "target-provider",
        label: "TARGET PROVIDER",
        summary: "Implements the native target dispatch table used when a syscall selects target `gsv`.",
        mechanics: [
          "The Kernel resolves target metadata before invoking this provider.",
          "Filesystem, shell, and network calls retain the same external contracts as device-backed targets.",
        ],
        paths: ["gateway/src/drivers/native/target.ts", "gateway/src/drivers/native/fs.ts"],
      },
      {
        id: "gsv-fs",
        label: "GSV FILESYSTEM",
        summary: "Routes Unix-like paths across control-plane projections, ordinary bytes, process media, homes, workspaces, and ripgit repositories.",
        mechanics: [
          "/proc, /sys, /dev, and selected /etc paths project Kernel state; /home and /src expose versioned repositories.",
          "Mount backends enforce their own storage and permission semantics behind one path API.",
        ],
        paths: ["gateway/src/fs/gsv-fs.ts", "gateway/src/fs/mount.ts", "gateway/src/fs/backends/"],
      },
      {
        id: "worker-shell",
        label: "WORKER SHELL",
        summary: "Runs bounded, composable commands over GsvFs and target-aware services inside the Worker runtime.",
        mechanics: [
          "Command discovery, streams, environment, sessions, and cancellation are owned below shell.exec.",
          "Built-ins expose GSV operations without giving callers a hidden alternate authority path.",
        ],
        paths: ["gateway/src/drivers/native/shell.ts", "gateway/src/drivers/native/shell/"],
      },
      {
        id: "codemode",
        label: "CODEMODE",
        summary: "Runs reusable JavaScript orchestration over the same syscall and shell primitives available elsewhere.",
        mechanics: [
          "It composes operations rather than introducing integration-specific model tools.",
          "MCP availability and request wrappers remain scoped to the Process identity and grant.",
        ],
        paths: ["gateway/src/codemode/", "gateway/src/process/codemode.ts"],
      },
    ],
  },
  {
    id: "inference",
    label: "INFERENCE GATEWAY",
    shortLabel: "INFERENCE",
    category: "provider",
    sourceRoot: "gateway/src/inference/",
    summary: "Normalizes model discovery, generation, streaming, timeouts, cancellation, transcription, and image input across managed and deployment-configured providers.",
    owns: [
      "Provider selection and normalized generation/streaming outcomes",
      "Model registry, capability detection, timeouts, and output normalization",
      "Provider-specific transports for managed GSV, Workers AI, Codex, and custom endpoints",
    ],
    boundary: "The Process owns the durable model loop and history; inference transports one generation request and its cancellation-safe result.",
    invariant: "Provider quirks are normalized here so Process history and syscall semantics do not fork by model vendor.",
    position: { x: 74, y: 39, height: 82 },
    components: [
      {
        id: "inference-service",
        label: "NORMALIZED SERVICE",
        summary: "Dispatches generation to the resolved provider and normalizes streaming, timeout, cancellation, and error behavior.",
        mechanics: [
          "One boundary converts provider events into Process-consumable output.",
          "Cancellation is propagated to the component that owns the active provider operation.",
        ],
        paths: ["gateway/src/inference/service.ts", "gateway/src/inference/provider.ts", "gateway/src/inference/timeout.ts"],
      },
      {
        id: "model-registry",
        label: "MODEL REGISTRY",
        summary: "Resolves model identities and capabilities without exposing provider configuration details to every caller.",
        mechanics: [
          "Kernel AI handlers combine global, owner, run-as account, and process settings.",
          "Available tools, targets, and MCP capabilities are filtered through the active grant.",
        ],
        paths: [
          "gateway/src/inference/model-registry.ts",
          "gateway/src/inference/capabilities.ts",
          "gateway/src/kernel/ai.ts",
        ],
      },
      {
        id: "providers",
        label: "PROVIDER TRANSPORTS",
        summary: "Implements the concrete managed, Workers AI, Codex, pi-ai, and compatible custom provider transports.",
        mechanics: [
          "Provider credentials are resolved for the Process runtime and are not forwarded to device targets.",
          "Each transport returns the same normalized output and error vocabulary.",
        ],
        paths: [
          "gateway/src/inference/gsv-provider.ts",
          "gateway/src/inference/workers-ai.ts",
          "gateway/src/inference/openai-codex.ts",
          "gateway/src/inference/custom-provider.ts",
          "gateway/src/inference/pi-ai.ts",
        ],
      },
      {
        id: "media-inference",
        label: "SPEECH + IMAGE",
        summary: "Owns gateway-side transcription, speech output, image validation, and model-readable media preparation.",
        mechanics: [
          "Media is validated and normalized before provider-specific request construction.",
          "Large content remains referenced until the inference boundary explicitly hydrates it.",
        ],
        paths: [
          "gateway/src/inference/transcription.ts",
          "gateway/src/inference/speech.ts",
          "gateway/src/inference/image-reading.ts",
        ],
      },
    ],
  },
  {
    id: "sdk",
    label: "PUBLIC SDK",
    shortLabel: "SDK",
    category: "contract",
    sourceRoot: "packages/gsv/src/",
    summary: "The shared TypeScript client and public protocol package. It gives clients, adapters, and services one typed wire language while leaving authority with the Gateway.",
    owns: [
      "Typed GSV client, reverse-call endpoint, and public exports",
      "Syscall argument/result catalog and wire-frame schemas",
      "Binary body, media, resource, cancellation, and stream contracts",
    ],
    boundary: "Types describe what a peer may ask or implement. They never grant that peer permission to call or receive it.",
    invariant: "The public syscall map is the shared contract; consumers must not create parallel request shapes for the same primitive.",
    position: { x: 26, y: 13, height: 72 },
    components: [
      {
        id: "typed-client",
        label: "GSV CLIENT",
        summary: "Connects, authenticates, sends typed syscalls, streams bodies, handles signals, cancellation, timeouts, and reverse calls.",
        mechanics: [
          "GSVClient is a caller; GSVEndpoint lets a peer expose implementations that the Kernel may route to.",
          "Connection setup advertises programs and implementations without claiming authority roles.",
        ],
        paths: ["packages/gsv/src/client.ts", "packages/gsv/src/index.ts"],
      },
      {
        id: "syscall-map",
        label: "SYSCALL CATALOG",
        summary: "Maps every public syscall name to its typed arguments, result, and optional body contract.",
        mechanics: [
          "Domains cover filesystem, shell, network, processes, conversations, repositories, schedules, responsibilities, AI, adapters, and signals.",
          "Generated namespaces keep callers aligned with the central catalog.",
        ],
        paths: ["packages/gsv/src/protocol/syscalls/map.ts", "packages/gsv/src/protocol/syscalls/"],
      },
      {
        id: "frame-bodies",
        label: "FRAMES + BODIES",
        summary: "Defines request/response/signal envelopes and the single-owner channel used for binary payloads.",
        mechanics: [
          "Body descriptors stay in structured frames while bytes move on a bounded binary channel.",
          "Cancellation and terminal ownership are explicit protocol events.",
        ],
        paths: [
          "packages/gsv/src/protocol/wire-frame.ts",
          "packages/gsv/src/protocol/binary-frame.ts",
          "packages/gsv/src/protocol/binary-body-channel.ts",
          "packages/gsv/src/protocol/request-cancel.ts",
        ],
      },
      {
        id: "media-resources",
        label: "MEDIA + RESOURCES",
        summary: "Carries immutable file identity, adapter media metadata, and managed inference stream events across typed boundaries.",
        mechanics: [
          "References preserve source identity without embedding private file bytes in histories.",
          "Media bodies share the same cancellation and ownership rules as other binary transfers.",
        ],
        paths: [
          "packages/gsv/src/protocol/resource.ts",
          "packages/gsv/src/protocol/adapter-media-body.ts",
          "packages/gsv/src/protocol/managed-inference-stream.ts",
        ],
      },
    ],
  },
  {
    id: "services",
    label: "MANAGED SERVICE CONTRACTS",
    shortLabel: "SERVICES",
    category: "service",
    sourceRoot: "packages/gsv/src/services/",
    summary: "Explicit interfaces for optional operator-owned installation lookup, onboarding, entitlements, funded inference, mail, and shared adapters. Implementations live outside this public repository.",
    owns: [
      "Public RPC contracts between a GSV deployment and its operator",
      "Installation-scoped capability interfaces and lifecycle result types",
      "The seam that keeps managed policy out of the open-source Kernel",
    ],
    boundary: "The repository defines these contracts, not the operator's private accounts, billing, provider, or fleet implementation.",
    invariant: "Managed capabilities enter through installation-scoped service bindings; standalone GSV remains useful without them.",
    position: { x: 51, y: 6, height: 68 },
    components: [
      {
        id: "directory",
        label: "INSTALLATION DIRECTORY",
        summary: "Resolves accepted hostnames and immutable installation IDs plus their active, restricted, retained, or provisioning state.",
        mechanics: [
          "The Gateway uses this trusted result before addressing a named Kernel.",
          "Inactive and unknown routes fail closed without allocating ordinary work.",
        ],
        paths: ["packages/gsv/src/services/directory.ts", "docs/architecture/services.md"],
      },
      {
        id: "onboarding-entitlements",
        label: "ONBOARDING + ENTITLEMENTS",
        summary: "Defines one-installation setup authorization/completion and versioned, expiring entitlement snapshots.",
        mechanics: [
          "Onboarding capabilities authorize first boot only and are consumed on successful setup.",
          "Entitlements describe operator-funded capability availability without replacing Kernel authorization.",
        ],
        paths: ["packages/gsv/src/services/onboarding.ts", "packages/gsv/src/services/entitlements.ts"],
      },
      {
        id: "managed-inference",
        label: "FUNDED INFERENCE",
        summary: "Produces an installation-scoped generation target with generate, stream, and abort operations.",
        mechanics: [
          "The service remains the provider boundary while the Process retains durable run ownership.",
          "Installation lifecycle is rechecked before managed work is admitted.",
        ],
        paths: ["packages/gsv/src/services/inference.ts"],
      },
      {
        id: "mail",
        label: "MANAGED MAIL",
        summary: "Defines exact intake, canonical draft claim, completion, and diagnostic operations for managed email.",
        mechanics: [
          "Gateway and mail service exchange durable references rather than trusting public sender fields.",
          "Uncertain provider outcomes remain inspectable and are not unsafely replayed.",
        ],
        paths: ["packages/gsv/src/services/mail.ts"],
      },
      {
        id: "adapter-service",
        label: "ADAPTER EXTENSION",
        summary: "Describes adapter lifecycle, pairing, status, delivery, activity, media, and optional target execution.",
        mechanics: [
          "Deployment-owned bindings select the adapter identity and attenuated grant.",
          "Messaging transport and an optional Unix-shaped target remain independent projections.",
        ],
        paths: ["packages/gsv/src/services/adapters.ts"],
      },
    ],
  },
  {
    id: "web",
    label: "WEB CONTROL ROOM",
    shortLabel: "WEB",
    category: "client",
    sourceRoot: "web/src/app/",
    summary: "The Preact desktop and system console. It visualizes durable Gateway state and lets the user operate conversations, processes, targets, integrations, files, repositories, and knowledge.",
    owns: [
      "Browser session presentation, desktop shell, navigation, and query state",
      "Chat, console, Files, Terminal, Repositories, Library, and setup surfaces",
      "Accessible interaction, visual design, drafts, and client-side view state",
    ],
    boundary: "The Web client presents and requests actions; the Kernel remains the authority for permissions, lifecycle, routing, and durable truth.",
    invariant: "UI state cannot grant authority, and private feature routes must not become alternate runtime contracts.",
    position: { x: 8, y: 55, height: 72 },
    components: [
      {
        id: "boot-session",
        label: "BOOT + SESSION",
        summary: "Mounts Preact, creates the browser peer, and owns setup, login, locking, and per-user provider/query generations.",
        mechanics: [
          "Session transitions isolate caches and gateway observers so one identity cannot inherit another's view state.",
          "Provisioning credentials remain tab-scoped and local passwords are created only by the Kernel.",
        ],
        paths: [
          "web/src/app/App.tsx",
          "web/src/app/providers/AppProviders.tsx",
          "web/src/app/services/session/SessionProvider.tsx",
          "web/src/app/services/gateway/GatewayProvider.tsx",
        ],
      },
      {
        id: "desktop-shell",
        label: "DESKTOP SHELL",
        summary: "Hosts the spatial desktop, system rail, console frame, status bar, browser routes, and persistent chat dock.",
        mechanics: [
          "Live desktop objects represent Machines, Messengers, and Integrations; system surfaces remain separate destinations.",
          "Navigation and unsaved-work guards own transitions without duplicating feature state.",
        ],
        paths: [
          "web/src/app/features/gsv-shell/GsvShell.tsx",
          "web/src/app/features/gsv-shell/domain/shellModel.ts",
          "web/src/app/features/gsv-shell/routing/shellRoutes.ts",
        ],
      },
      {
        id: "chat",
        label: "CHAT + WORK SESSIONS",
        summary: "Presents the canonical Ship and explicitly targeted Process work sessions, including activity, approvals, media, and interruption.",
        mechanics: [
          "Transient run activity and committed conversation history remain visibly distinct.",
          "Selecting another work process is explicit and does not redefine the personal conversation elsewhere.",
        ],
        paths: ["web/src/app/features/chat/components/ChatDock.tsx", "web/src/app/features/chat/backend/chatService.ts"],
      },
      {
        id: "system-console",
        label: "SYSTEM CONSOLE",
        summary: "Dispatches the built-in operational surfaces for processes, responsibilities, agents, machines, adapters, integrations, contacts, and configuration.",
        mechanics: [
          "Each surface keeps a clear job and maps decisions onto gateway syscalls instead of dumping raw records.",
          "The central console dispatcher supplies shared framing and breadcrumbs while features own their own presentation.",
        ],
        paths: ["web/src/app/features/gsv-console/components/GsvConsole.tsx", "web/src/app/features/gsv-console/"],
      },
      {
        id: "work-surfaces",
        label: "FILES + SHELL + KNOWLEDGE",
        summary: "Provides target filesystem browsing, shell execution, repository inspection, and ripgit-backed Markdown knowledge workspaces.",
        mechanics: [
          "Feature services call the same typed fs.*, shell.*, and repo.* primitives available to other clients.",
          "Gateway signals invalidate scoped queries before the surface refetches authoritative state.",
        ],
        paths: [
          "web/src/app/features/files/",
          "web/src/app/features/terminal/",
          "web/src/app/features/repositories/",
          "web/src/app/features/gsv-console/library/",
          "web/src/app/services/query/GatewaySignalInvalidator.tsx",
        ],
      },
      {
        id: "design-system",
        label: "DESIGN SYSTEM",
        summary: "Owns reusable controls, tokens, typography, stories, and operational desktop patterns shared by Web surfaces.",
        mechanics: [
          "Components remain presentation primitives rather than owning backend policy.",
          "The catalog and previews make visual contracts inspectable without signing into a live installation.",
        ],
        paths: ["web/src/app/components/ui/", "web/src/design-system/", "web/src/styles/"],
      },
    ],
  },
  {
    id: "host",
    label: "NATIVE HOST",
    shortLabel: "HOST",
    category: "client",
    sourceRoot: "host/",
    summary: "Three sibling Rust applications plus supervised helpers and narrow shared contracts: an operator CLI, a native human Desktop, and the gsvd physical-machine target provider.",
    owns: [
      "Native Desktop presentation and its fenced human interaction state",
      "CLI administration and same-user service control",
      "gsvd machine syscalls, transfers, subprocesses, reconnects, and cleanup",
      "Local transcription/gesture computation and bounded IPC contracts",
    ],
    boundary: "The applications share transport and configuration crates but do not embed or take ownership of one another's runtime state.",
    invariant: "Platform-native work stays with the process that owns it, and stale async output is fenced by connection, process, request, and helper-session identity.",
    position: { x: 18, y: 84, height: 88 },
    components: [
      {
        id: "cli",
        label: "GSV CLI",
        summary: "Administrative command deck for gateway operations, deployment, process/chat commands, and local Desktop or daemon control.",
        mechanics: [
          "Remote work uses the authenticated Gateway client; local status and lifecycle use narrow same-user protocols.",
          "Compatibility launchers hand off to the owning executable instead of embedding its runtime.",
        ],
        paths: ["host/apps/cli/src/main.rs", "host/apps/cli/src/commands/", "host/apps/cli/src/kernel_client.rs"],
      },
      {
        id: "desktop",
        label: "NATIVE DESKTOP",
        summary: "GPUI conversation cockpit owning the selected Process, visible conversation model, drafts, approvals, attachments, and local controls.",
        mechanics: [
          "A background client reconciles authoritative history and signals into presentation moments.",
          "PID, session, and operation fences prevent previous work from mutating the newly selected workspace.",
        ],
        paths: [
          "host/apps/desktop/src/app.rs",
          "host/apps/desktop/src/client.rs",
          "host/apps/desktop/src/model.rs",
          "host/apps/desktop/src/interaction.rs",
        ],
      },
      {
        id: "machine",
        label: "GSVD MACHINE",
        summary: "A persistent driver peer that exposes the local computer as a filesystem, shell, network, and transfer target.",
        mechanics: [
          "Owns request cancellation, subprocess/session lifetime, streaming bodies, reconnection, health, logs, and shutdown.",
          "The OS service manager owns background lifecycle; gsvd remains an unprivileged foreground daemon process.",
        ],
        paths: ["host/apps/machine/src/app.rs", "host/apps/machine/src/device/", "host/apps/machine/src/tools/"],
      },
      {
        id: "host-contracts",
        label: "SHARED HOST CONTRACTS",
        summary: "Provides Gateway transport, atomic host configuration, and bounded Desktop, daemon, and gesture IPC protocols.",
        mechanics: [
          "Contracts carry typed, redacted control information and deliberately exclude private conversation, credential, and media content.",
          "The host Cargo workspace owns their lockfile and build artifacts.",
        ],
        paths: [
          "host/crates/gateway-client/",
          "host/crates/config/",
          "host/crates/desktop-protocol/",
          "host/crates/daemon-protocol/",
          "host/crates/gesture-protocol/",
        ],
      },
      {
        id: "helpers",
        label: "LOCAL HELPERS",
        summary: "Separately supervised transcription and gesture processes own microphone, camera, native inference, and temporal interaction policy.",
        mechanics: [
          "Only bounded text, state, and fenced semantic intents cross to Desktop; raw audio/video never goes to the Gateway through these channels.",
          "Desktop remains the owner of the active voice request and user-visible action.",
        ],
        paths: ["host/helpers/transcriber/", "host/helpers/gestures/", "docs/architecture/rust-host-applications.md"],
      },
    ],
  },
  {
    id: "adapters",
    label: "MESSAGE ADAPTERS",
    shortLabel: "ADAPTERS",
    category: "transport",
    sourceRoot: "adapters/",
    summary: "Provider protocol translators with durable ingress and delivery state. Each adapter owns credentials, identities, formatting, retries, media, and provider-specific lifecycle.",
    owns: [
      "Provider sessions, authentication, identities, formatting, and delivery policy",
      "Durable inbound receipts and outbound idempotency/ambiguity ledgers",
      "Messaging transport plus any separately declared adapter-backed target",
    ],
    boundary: "Adapters normalize transport into generic actor and surface semantics. They do not choose installations, local UIDs, Process permissions, or Kernel policy.",
    invariant: "Provider payloads are durable before Gateway ingress, and an uncertain non-idempotent delivery is marked ambiguous instead of being replayed blindly.",
    position: { x: 90, y: 20, height: 94 },
    components: [
      {
        id: "shared",
        label: "SHARED DELIVERY CORE",
        summary: "Centralizes Gateway RPC, installation scoping, durable inbound retry, outbound delivery ledgers, media ownership, and compatibility.",
        mechanics: [
          "Only normalized adapter.inbound and adapter.state.update frames cross the Gateway seam.",
          "Delivery IDs are bound to exact content; reuse with different content fails closed.",
        ],
        paths: ["adapters/shared/src/gateway-rpc.ts", "adapters/shared/src/inbound-delivery.ts", "adapters/shared/src/delivery-ledger.ts"],
      },
      {
        id: "discord",
        label: "DISCORD",
        summary: "Owns a durable Discord Gateway session, heartbeats, normalized inbound events, and provider delivery.",
        mechanics: [
          "The account actor retains session and delivery state across Worker invocations.",
          "A deterministic provider nonce can strengthen safe outbound replay behavior.",
        ],
        paths: ["adapters/discord/src/index.ts", "adapters/discord/src/discord-gateway.ts", "adapters/discord/src/discord-delivery.ts"],
      },
      {
        id: "telegram-slack",
        label: "TELEGRAM + SLACK",
        summary: "Support standalone account actors and managed shared-service pairing with signed provider ingress and generation-fenced human routes.",
        mechanics: [
          "A pairing code never chooses an installation or uid; a signed-in GSV human confirms the link.",
          "Managed Slack may additionally expose a coherent shell target without merging that target with messaging identity.",
        ],
        paths: [
          "adapters/telegram/src/telegram-account.ts",
          "adapters/telegram/src/managed-peer.ts",
          "adapters/slack/src/slack-account.ts",
          "adapters/slack/src/managed-peer.ts",
          "adapters/slack/src/slack-target-shell.ts",
        ],
      },
      {
        id: "whatsapp",
        label: "WHATSAPP",
        summary: "Owns the linked-device socket, durable Baileys credentials, identity normalization, lifecycle, encrypted media, and account ledger.",
        mechanics: [
          "Complete provider event identity—including group participant context—feeds stable ingress receipts.",
          "Media decryption and provider protocol details remain inside the adapter.",
        ],
        paths: [
          "adapters/whatsapp/src/whatsapp-account.ts",
          "adapters/whatsapp/src/auth-store.ts",
          "adapters/whatsapp/src/identity.ts",
          "adapters/whatsapp/src/media.ts",
        ],
      },
      {
        id: "email",
        label: "MANAGED EMAIL",
        summary: "A mailbox intake and outbound delivery pipeline with exact raw-body staging, quotas, dedupe, claims, and uncertain-outcome handling.",
        mechanics: [
          "Trusted address resolution supplies installation scope before MIME or inference work is admitted.",
          "Canonical drafts are claimed from the Gateway before contacting the provider.",
        ],
        paths: ["adapters/email/src/index.ts", "adapters/email/src/mail-installation.ts", "adapters/email/src/outbound.ts"],
      },
      {
        id: "test-adapter",
        label: "TEST ADAPTER",
        summary: "Provider-free end-to-end fixture for the real adapter boundary and delivery semantics.",
        mechanics: [
          "Exercises normalized ingress and outbound behavior without external platform state.",
          "Keeps the production boundary testable as an ordinary deployable adapter.",
        ],
        paths: ["adapters/test/src/index.ts", "docs/architecture/adapter-model.md"],
      },
    ],
  },
  {
    id: "extension",
    label: "BROWSER TARGET",
    shortLabel: "BROWSER",
    category: "target",
    sourceRoot: "extension/src/",
    summary: "A browser profile projected as a Unix-shaped capability environment. Tabs, pages, browser state, network artifacts, and automation become filesystem and shell primitives.",
    owns: [
      "Browser-target WebSocket lifecycle, syscall dispatch, and teardown",
      "Browser filesystem, shell commands, page automation, and network/media capture",
      "Local popup, options, side panel, viewer, and persisted browser-target state",
    ],
    boundary: "The extension is a target provider—not the Web UI and not a messaging adapter. Chrome permissions and the Kernel grant are independent boundaries.",
    invariant: "A claimed browser peer ID or advertised implementation does not grant access; the Kernel still derives identity and callable routes.",
    position: { x: 91, y: 58, height: 78 },
    components: [
      {
        id: "supervisor-driver",
        label: "SUPERVISOR + DRIVER",
        summary: "Maintains the MV3 background connection, registers implementations, dispatches syscalls, and tears down stale work.",
        mechanics: [
          "Connection epochs and abort registries fence callbacks from a replaced endpoint.",
          "The service worker remains the target's transport owner across Chrome lifecycle events.",
        ],
        paths: [
          "extension/src/background/service-worker.ts",
          "extension/src/background/connection-supervisor.ts",
          "extension/src/background/driver.ts",
        ],
      },
      {
        id: "browser-fs-shell",
        label: "FILESYSTEM + SHELL",
        summary: "Exposes browser state through familiar paths and composable just-bash commands with persistent writable areas.",
        mechanics: [
          "IndexedDB backs writable /home/browser and /tmp while runtime paths project live browser resources.",
          "Commands operate on Chrome APIs without pretending arbitrary actions are POSIX syscalls.",
        ],
        paths: ["extension/src/target/fs.ts", "extension/src/target/runtime-fs.ts", "extension/src/target/shell.ts", "extension/src/target/commands/"],
      },
      {
        id: "page-automation",
        label: "PAGE AUTOMATION",
        summary: "Owns semantic page observation, input, JavaScript, actions, tab resources, and network recording.",
        mechanics: [
          "Page semantics turn volatile DOM state into inspectable, bounded command results.",
          "Network and media capture retain explicit stream and cancellation ownership.",
        ],
        paths: ["extension/src/target/page-semantics.ts", "extension/src/target/page-actions.ts", "extension/src/target/network-recorder.ts"],
      },
      {
        id: "browser-surfaces",
        label: "LOCAL SURFACES",
        summary: "Provides inspectable connection state, diagnostics, configuration, side-panel control, and artifact viewing.",
        mechanics: [
          "These views administer the extension target but do not replace Kernel authorization.",
          "Offscreen documents isolate media recording work required by MV3.",
        ],
        paths: ["extension/src/popup/", "extension/src/options/", "extension/src/sidepanel/", "extension/src/viewer/", "extension/src/offscreen/"],
      },
    ],
  },
  {
    id: "ripgit",
    label: "RIPGIT STORAGE",
    shortLabel: "RIPGIT",
    category: "storage",
    sourceRoot: "ripgit/src/",
    summary: "GSV's built-in, installation-scoped Git service. It stores homes, context, skills, wikis, workspaces, and repositories as inspectable version history.",
    owns: [
      "Git smart HTTP, refs, commits, trees, blobs, packs, deltas, and diffs",
      "Installation-scoped Repository Durable Objects and SQLite schema",
      "Kernel-facing atomic read, search, compare, apply, and import operations",
    ],
    boundary: "The Gateway authenticates callers and overwrites installation scope; ripgit owns repository mechanics and never derives user authority from public headers.",
    invariant: "Physical Repository Durable Object names include installation identity in managed hosting while the explicit singleton layout remains supported.",
    position: { x: 72, y: 84, height: 102 },
    components: [
      {
        id: "worker-repository-do",
        label: "WORKER + REPOSITORY DO",
        summary: "Routes Git or internal API paths to an installation-qualified serialized repository actor.",
        mechanics: [
          "The Gateway injects trusted installation identity before using the service binding.",
          "Each Repository actor initializes and owns its SQL-backed Git object store.",
        ],
        paths: ["ripgit/src/lib.rs", "gateway/src/installation/ripgit.ts"],
      },
      {
        id: "git-protocol",
        label: "GIT SMART HTTP",
        summary: "Implements ref advertisement, receive-pack, upload-pack, pack indexing, and delta resolution.",
        mechanics: [
          "Public clone/fetch/push use ordinary Git HTTP shapes through the Gateway proxy.",
          "Write access is projected by authenticated Gateway actor headers, not anonymous request claims.",
        ],
        paths: ["ripgit/src/git.rs", "ripgit/src/pack.rs", "gateway/src/git.ts"],
      },
      {
        id: "object-store",
        label: "GIT OBJECT STORE",
        summary: "Persists refs, commits, trees, blobs, versions, keyframes, and deltas in the repository's SQLite database.",
        mechanics: [
          "Periodic full keyframes bound worst-case reconstruction across stored deltas.",
          "The repository actor is the sole owner of schema and object consistency.",
        ],
        paths: ["ripgit/src/store.rs", "ripgit/src/schema.rs"],
      },
      {
        id: "hyperspace",
        label: "HYPERSPACE API",
        summary: "Gives the Kernel atomic higher-level read, search, compare, apply, and import operations over Git-backed trees.",
        mechanics: [
          "Internal calls use a bound service secret and installation-qualified routing.",
          "Filesystem and repo.* callers compose on this API without learning Git storage internals.",
        ],
        paths: ["ripgit/src/hyperspace.rs", "ripgit/src/api.rs", "ripgit/src/diff.rs"],
      },
    ],
  },
] as const satisfies readonly ArchitectureSubsystem[];

export const ARCHITECTURE_EDGES = [
  { id: "services-gateway", from: "services", to: "gateway", label: "trusted directory + managed bindings", kind: "control" },
  { id: "sdk-protocol", from: "sdk", to: "protocol", label: "public syscall + frame types", kind: "contract" },
  { id: "protocol-gateway", from: "protocol", to: "gateway", label: "validated frames", kind: "request" },
  { id: "gateway-kernel", from: "gateway", to: "kernel", label: "installation-scoped admission", kind: "control" },
  { id: "web-gateway", from: "web", to: "gateway", label: "user HTTPS + WebSocket", kind: "request" },
  { id: "host-gateway", from: "host", to: "gateway", label: "user + driver WebSockets", kind: "request" },
  { id: "adapters-gateway", from: "adapters", to: "gateway", label: "attenuated service frames", kind: "request" },
  { id: "extension-gateway", from: "extension", to: "gateway", label: "browser target peer", kind: "request" },
  { id: "kernel-process", from: "kernel", to: "process", label: "process control + signals", kind: "control" },
  { id: "process-inference", from: "process", to: "inference", label: "normalized generation", kind: "request" },
  { id: "process-kernel", from: "process", to: "kernel", label: "syscalls + message commits", kind: "request" },
  { id: "kernel-conversation", from: "kernel", to: "conversation", label: "canonical message operations", kind: "data" },
  { id: "kernel-native", from: "kernel", to: "native-target", label: "target:gsv dispatch", kind: "request" },
  { id: "kernel-host", from: "kernel", to: "host", label: "machine target calls", kind: "request" },
  { id: "kernel-extension", from: "kernel", to: "extension", label: "browser target calls", kind: "request" },
  { id: "kernel-adapters", from: "kernel", to: "adapters", label: "message delivery + adapter targets", kind: "request" },
  { id: "kernel-ripgit", from: "kernel", to: "ripgit", label: "installation-scoped repo operations", kind: "data" },
  { id: "native-ripgit", from: "native-target", to: "ripgit", label: "versioned filesystem mounts", kind: "data" },
] as const satisfies readonly ArchitectureEdge[];

export const ARCHITECTURE_FLOWS = [
  {
    id: "human-turn",
    label: "HUMAN → AGENT → MESSAGE",
    summary: "A human input becomes a durable Process run and only explicit Process commits enter the stable conversation shared by clients.",
    steps: [
      { subsystemId: "web", componentId: "chat", label: "Human input", detail: "Web, native Desktop, CLI, or a linked private adapter submits a conversation action through its ordinary client boundary." },
      { subsystemId: "gateway", componentId: "edge-router", label: "Installation admission", detail: "The edge resolves the trusted installation route before any installation-owned Durable Object is addressed." },
      { subsystemId: "kernel", componentId: "identity-policy", label: "Authenticate + authorize", detail: "The Kernel derives the principal and grant, then applies conversation and Process ownership policy." },
      { subsystemId: "conversation", componentId: "conversation-do", label: "Commit user Message", detail: "The canonical user-visible input is persisted before the Process run is admitted." },
      { subsystemId: "process", componentId: "agent-loop", label: "Run the Process", detail: "The Process assembles its frozen context, queues or supersedes input according to run policy, and starts one serialized loop." },
      { subsystemId: "inference", componentId: "inference-service", label: "Generate", detail: "The normalized inference boundary streams provider output and propagates timeout or cancellation to the active operation." },
      { subsystemId: "process", componentId: "tools-approvals", label: "Commit + yield", detail: "Exact message send commands create user-visible updates; yield closes the human-facing run." },
      { subsystemId: "kernel", componentId: "delivery-coordination", label: "Route + synchronize", detail: "The Kernel directs transient output to the run origin and committed-message signals to synchronized clients and linked adapters." },
      { subsystemId: "conversation", componentId: "message-store", label: "Stable history", detail: "The committed Message remains in the canonical ledger even if the handling Process is later reset or replaced." },
    ],
  },
  {
    id: "target-syscall",
    label: "TARGET-ROUTED SYSCALL",
    summary: "The same fs.*, shell.*, or net.* contract runs on the native cloud target, a physical machine, or a browser profile.",
    steps: [
      { subsystemId: "process", componentId: "tools-approvals", label: "Issue tool call", detail: "A model tool or CodeMode operation resolves to an ordinary typed syscall and target argument." },
      { subsystemId: "kernel", componentId: "dispatch-routing", label: "Resolve target", detail: "The Kernel strips target metadata, checks authority, visibility, online state, and advertised implementation, then chooses the owner." },
      { subsystemId: "native-target", componentId: "target-provider", label: "Native option", detail: "target:gsv executes inside the Worker over GsvFs, the bounded shell, or native network implementation." },
      { subsystemId: "host", componentId: "machine", label: "Machine option", detail: "A gsvd peer owns local filesystem, subprocess, transfer, body, cancellation, and cleanup behavior." },
      { subsystemId: "extension", componentId: "supervisor-driver", label: "Browser option", detail: "The extension dispatches into its Unix-shaped browser filesystem and Chrome-backed command environment." },
      { subsystemId: "kernel", componentId: "dispatch-routing", label: "Fenced response", detail: "The exact route returns one response/body outcome and is removed on completion, cancellation, disconnect, or timeout." },
      { subsystemId: "process", componentId: "process-store", label: "Persist result", detail: "The Process records the terminal tool result before continuing the provider-valid model history." },
    ],
  },
  {
    id: "adapter-ingress",
    label: "ADAPTER INGRESS + REPLY",
    summary: "A provider event is made durable before it crosses the attenuated adapter boundary; replies return through an idempotency-aware delivery ledger.",
    steps: [
      { subsystemId: "adapters", componentId: "shared", label: "Durable provider event", detail: "The account or peer actor stores the complete provider event and a stable delivery receipt before Gateway side effects." },
      { subsystemId: "gateway", componentId: "service-entrypoints", label: "Attenuated ingress", detail: "A deployment-owned binding fixes adapter identity and allowed calls; the frame supplies neither authority nor installation." },
      { subsystemId: "kernel", componentId: "delivery-coordination", label: "Resolve actor + surface", detail: "The Kernel claims the ingress receipt, normalizes the linked human peer, intersects capabilities, and chooses the conversation and Process." },
      { subsystemId: "conversation", componentId: "conversation-do", label: "Canonical input", detail: "The normalized inbound message is committed once with its immutable resources and handling provenance." },
      { subsystemId: "process", componentId: "agent-loop", label: "Agent run", detail: "The Process handles the message using the same durable run model as other human surfaces." },
      { subsystemId: "kernel", componentId: "delivery-coordination", label: "Committed reply", detail: "Only committed Messages are formatted for adapter delivery; raw Process drafts and reasoning never leave this boundary." },
      { subsystemId: "adapters", componentId: "shared", label: "Provider delivery", detail: "A content-bound delivery ID reaches the provider once, retries only known-safe failures, and records ambiguous outcomes without unsafe replay." },
    ],
  },
  {
    id: "managed-routing",
    label: "MANAGED INSTALLATION ROUTING",
    summary: "A public hostname becomes an immutable installation identity through a private directory and lifecycle gate before ordinary work is admitted.",
    steps: [
      { subsystemId: "services", componentId: "directory", label: "Resolve hostname", detail: "The trusted installation directory returns a validated immutable identity and lifecycle state—or a not-found boundary." },
      { subsystemId: "gateway", componentId: "installation-routing", label: "Derive identity", detail: "The Gateway accepts only the directory result; URL handles and origins remain mutable routing metadata." },
      { subsystemId: "gateway", componentId: "installation-storage", label: "Scope physical owners", detail: "R2, Process, Conversation, ripgit, and adapter addresses retain installation scope before multi-installation work." },
      { subsystemId: "kernel", componentId: "kernel-do", label: "Address Kernel", detail: "The immutable installation ID names the serialized Kernel Durable Object." },
      { subsystemId: "kernel", componentId: "identity-policy", label: "Lifecycle gate", detail: "Only active installations admit ordinary HTTP, WebSocket, adapter, inference, Process-tick, and scheduler work." },
    ],
  },
  {
    id: "versioned-files",
    label: "VERSIONED FILESYSTEM WRITE",
    summary: "Stable Unix-shaped file operations reach ripgit-backed homes, workspaces, knowledge, and source without exposing Git storage mechanics to the caller.",
    steps: [
      { subsystemId: "web", componentId: "work-surfaces", label: "Read or edit a path", detail: "A Files, Library, Shell, SDK, or agent action issues the same fs.* or repo.* primitive." },
      { subsystemId: "kernel", componentId: "identity-policy", label: "Check identity + mode", detail: "The Kernel combines capabilities with account, workspace, repository, and filesystem ownership rules." },
      { subsystemId: "native-target", componentId: "gsv-fs", label: "Resolve the mount", detail: "GsvFs maps /home, /workspaces, /src, or knowledge paths to their coherent backing environment." },
      { subsystemId: "kernel", componentId: "dispatch-routing", label: "Inject installation scope", detail: "The Gateway-side ripgit client overwrites physical routing metadata with the trusted installation identity." },
      { subsystemId: "ripgit", componentId: "hyperspace", label: "Apply atomically", detail: "The internal API updates the Git tree and creates inspectable history inside the installation-scoped Repository actor." },
      { subsystemId: "web", componentId: "work-surfaces", label: "Refresh the view", detail: "Signals invalidate the affected client query and the surface reads the new authoritative revision." },
    ],
  },
  {
    id: "native-client",
    label: "NATIVE DESKTOP + MACHINE",
    summary: "The human Desktop, machine daemon, CLI, and local helpers remain separate owners connected by intentionally narrow channels.",
    steps: [
      { subsystemId: "host", componentId: "desktop", label: "Human cockpit", detail: "Desktop owns the selected Process, visible conversation state, drafts, approvals, attachments, and local interaction state." },
      { subsystemId: "gateway", componentId: "edge-router", label: "User connection", detail: "Desktop talks directly to the Gateway as a user peer; it does not need the machine daemon to chat." },
      { subsystemId: "host", componentId: "machine", label: "Machine data plane", detail: "gsvd maintains a separate driver connection and executes only the target syscalls it advertises." },
      { subsystemId: "host", componentId: "host-contracts", label: "Local control plane", detail: "CLI/Desktop use same-user Desktop and daemon protocols for bounded lifecycle/status operations, never as a hidden data plane." },
      { subsystemId: "host", componentId: "helpers", label: "Isolated native compute", detail: "Transcription and gesture helpers retain raw audio/video locally and return only bounded text, state, or fenced semantic intents." },
    ],
  },
] as const satisfies readonly ArchitectureFlow[];

const subsystemById = new Map<ArchitectureSubsystemId, ArchitectureSubsystem>(
  ARCHITECTURE_SUBSYSTEMS.map((subsystem) => [subsystem.id, subsystem]),
);

export function architectureSubsystem(id: ArchitectureSubsystemId): ArchitectureSubsystem {
  const subsystem = subsystemById.get(id);
  if (!subsystem) {
    throw new Error(`Unknown architecture subsystem: ${id}`);
  }
  return subsystem;
}

export function architectureComponent(
  subsystemId: ArchitectureSubsystemId,
  componentId: string | null | undefined,
): ArchitectureComponent | null {
  if (!componentId) {
    return null;
  }
  return architectureSubsystem(subsystemId).components.find((component) => component.id === componentId) ?? null;
}

function queryScore(haystack: string, terms: readonly string[], label: string, paths: readonly string[]): number {
  if (!terms.every((term) => haystack.includes(term))) {
    return -1;
  }
  const normalizedLabel = label.toLowerCase();
  return terms.reduce((score, term) => {
    if (normalizedLabel === term) return score + 12;
    if (normalizedLabel.startsWith(term)) return score + 8;
    if (normalizedLabel.includes(term)) return score + 5;
    if (paths.some((path) => path.toLowerCase().includes(term))) return score + 3;
    return score + 1;
  }, 0);
}

export function searchArchitecture(query: string): ArchitectureSearchResult[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return [];
  }

  const results: ArchitectureSearchResult[] = [];
  for (const subsystem of ARCHITECTURE_SUBSYSTEMS) {
    const subsystemText = [
      subsystem.label,
      subsystem.shortLabel,
      subsystem.category,
      subsystem.sourceRoot,
      subsystem.summary,
      subsystem.boundary,
      subsystem.invariant,
      ...subsystem.owns,
    ].join(" ").toLowerCase();
    const subsystemScore = queryScore(subsystemText, terms, subsystem.label, [subsystem.sourceRoot]);
    if (subsystemScore >= 0) {
      results.push({
        subsystemId: subsystem.id,
        label: subsystem.label,
        path: subsystem.sourceRoot,
        summary: subsystem.summary,
        score: subsystemScore,
      });
    }

    for (const component of subsystem.components) {
      const componentText = [
        component.label,
        component.summary,
        ...component.mechanics,
        ...component.paths,
      ].join(" ").toLowerCase();
      const componentScore = queryScore(componentText, terms, component.label, component.paths);
      if (componentScore >= 0) {
        results.push({
          subsystemId: subsystem.id,
          componentId: component.id,
          label: component.label,
          path: component.paths[0],
          summary: component.summary,
          score: componentScore + 1,
        });
      }
    }
  }

  return results
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, 18);
}

export function connectedSubsystems(id: ArchitectureSubsystemId): ArchitectureSubsystemId[] {
  const connected = new Set<ArchitectureSubsystemId>();
  for (const edge of ARCHITECTURE_EDGES) {
    if (edge.from === id) connected.add(edge.to);
    if (edge.to === id) connected.add(edge.from);
  }
  return [...connected];
}

export const ARCHITECTURE_SOURCE_GUIDES = [
  "AGENTS.md",
  "docs/architecture/index.md",
  "docs/architecture/agent-loop.md",
  "docs/architecture/conversations.md",
  "docs/architecture/targets.md",
  "docs/architecture/unified-protocol-peers.md",
  "docs/architecture/security-model.md",
  "docs/architecture/services.md",
  "docs/architecture/adapter-model.md",
  "docs/architecture/rust-host-applications.md",
  "docs/reference/syscalls.md",
  "docs/reference/websocket-protocol.md",
] as const;
