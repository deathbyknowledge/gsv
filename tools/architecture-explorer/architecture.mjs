// Curated architecture evidence. Runtime ownership comes from the owning code
// and tests; directory shape is never treated as an actor by itself.
const ARCHITECTURE_SUBSYSTEMS = [
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
      "Installation lifecycle admission and physical storage scoping"
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
          "Exports the Kernel, Process, and Conversation Durable Object classes used by the deployment."
        ],
        paths: ["gateway/src/index.ts", "gateway/src/public-assets.ts", "gateway/src/git.ts"]
      },
      {
        id: "installation-routing",
        label: "INSTALLATION ROUTING",
        summary: "Converts trusted host routing into the immutable identity used to address every installation-owned resource.",
        mechanics: [
          "Managed hosts resolve through the installation directory before a named Kernel is addressed.",
          "Standalone deployments preserve the explicit singleton projection for supported upgrades."
        ],
        paths: [
          "gateway/src/installation/identity.ts",
          "gateway/src/installation/routing.ts",
          "gateway/src/installation/lifecycle.ts",
          "gateway/src/installation/routing.test.ts",
          "gateway/src/installation/lifecycle.test.ts",
          "gateway/test-integration/managed-routing.test.ts"
        ]
      },
      {
        id: "installation-storage",
        label: "PHYSICAL SCOPING",
        summary: "Injects installation scope into R2 and ripgit addresses while retaining the supported standalone layout.",
        mechanics: [
          "Creates installation-qualified storage views instead of trusting paths supplied by callers.",
          "Keeps the physical isolation rule below stable filesystem and repository contracts."
        ],
        paths: ["gateway/src/installation/storage.ts", "gateway/src/installation/ripgit.ts"]
      },
      {
        id: "service-entrypoints",
        label: "SERVICE ENTRYPOINTS",
        summary: "Admits first-party adapters and managed mail through deployment-owned, attenuated service identities.",
        mechanics: [
          "Binding props choose adapter identity and callable grants; an incoming frame cannot self-declare either.",
          "Body ownership is cancelled on failed handoff so binary streams cannot be orphaned."
        ],
        paths: ["gateway/src/index.ts", "gateway/src/adapter-interface.ts"]
      }
    ]
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
      "Adapter links, run routes, MCP connections, responsibilities, and user connections"
    ],
    boundary: "The Kernel coordinates work but does not own model-loop history, provider quirks, UI presentation, or platform-native execution.",
    invariant: "Authority is derived from an authenticated principal and Kernel grant\u2014never from transport, claimed peer ID, or advertised implementations.",
    position: { x: 50, y: 43, height: 128 },
    components: [
      {
        id: "kernel-do",
        label: "KERNEL DURABLE OBJECT",
        summary: "The serialized, installation-scoped control-plane actor and composition root for Kernel stores and handlers.",
        mechanics: [
          "Kernel SQLite stores the directories and registries required for policy, routing, and recovery.",
          "A narrow context object supplies dependencies to handlers instead of hiding ownership in globals."
        ],
        paths: ["gateway/src/kernel/do.ts", "gateway/src/kernel/context.ts", "gateway/src/kernel/schema/"]
      },
      {
        id: "identity-policy",
        label: "IDENTITY + POLICY",
        summary: "Authenticates humans, machines, and services, then intersects group capabilities with resource ownership rules.",
        mechanics: [
          "Connection metadata describes a peer; credentials determine its principal and grant.",
          "Capabilities are necessary but handlers still enforce account, process, target, filesystem, and repository ownership."
        ],
        paths: [
          "gateway/src/kernel/connect.ts",
          "gateway/src/kernel/peer.ts",
          "gateway/src/kernel/capabilities.ts",
          "gateway/src/kernel/account-access.ts"
        ]
      },
      {
        id: "dispatch-routing",
        label: "DISPATCH + ROUTING",
        summary: "Resolves syscall ownership and target selection at one central boundary.",
        mechanics: [
          "Native calls stay in-process; remote calls create a fenced route to a visible, online peer that implements the syscall.",
          "Timeouts, disconnects, cancellation, responses, and body streams clean up the same owned route."
        ],
        paths: [
          "gateway/src/kernel/dispatch.ts",
          "gateway/src/kernel/routing.ts",
          "gateway/src/kernel/targets.ts",
          "gateway/src/kernel/shell-sessions.ts"
        ]
      },
      {
        id: "process-control",
        label: "PROCESS CONTROL",
        summary: "Owns the process registry, admission policy, IPC routing, schedules, and terminal lifecycle decisions.",
        mechanics: [
          "Spawn, fork, send, abort, reset, and kill remain distinct operations with explicit ownership checks.",
          "A killed PID is terminal and cannot silently name a replacement after Durable Object eviction."
        ],
        paths: [
          "gateway/src/kernel/processes.ts",
          "gateway/src/kernel/proc-handlers.ts",
          "gateway/src/kernel/ipc-calls.ts",
          "gateway/src/kernel/scheduler.ts"
        ]
      },
      {
        id: "delivery-coordination",
        label: "DELIVERY + COORDINATION",
        summary: "Bridges processes to canonical conversations, endpoint routes, adapters, responsibilities, and durable follow-up work.",
        mechanics: [
          "Connection run routes receive transient message deltas; adapter routes receive activity state and committed replies instead of draft text.",
          "The Kernel appends authorized input and Process output to the canonical Conversation, while a run route never owns that history.",
          "The responsibility ledger survives individual runs and remains visible according to the process's role."
        ],
        paths: [
          "gateway/src/kernel/do.ts",
          "gateway/src/kernel/conversation-handlers.ts",
          "gateway/src/kernel/run-routes.ts",
          "gateway/src/kernel/adapter-handlers.ts",
          "gateway/src/kernel/responsibilities.ts",
          "gateway/src/kernel/conversation-handlers.test.ts",
          "gateway/src/kernel/run-routes.test.ts"
        ]
      },
      {
        id: "schema",
        label: "KERNEL SCHEMA",
        summary: "Evolves relational control-plane state through ordered, immutable SQLite migrations.",
        mechanics: [
          "Migrations run before stores use the schema and are checksummed by the shared runner.",
          "Relational state is never created ad hoc from store constructors."
        ],
        paths: ["gateway/src/kernel/schema/", "gateway/src/schema/runner.ts"]
      }
    ]
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
      "Queued input, Process-local CodeMode, pending tools, approvals, cancellation, and compaction",
      "Frozen prompt/context epochs, process activity, and run-scoped media"
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
          "Bounded IPC work returns an ordinary durable Process result independently of human delivery."
        ],
        paths: ["gateway/src/process/do.ts", "docs/architecture/agent-loop.md"]
      },
      {
        id: "process-store",
        label: "HISTORY + STATE",
        summary: "Persists messages, tool state, queues, run metadata, traces, and lifecycle fences in Process SQLite.",
        mechanics: [
          "Work is registered durably before external dispatch so restart recovery has an authoritative baseline.",
          "Process history retains reasoning and tools for inspection but is not the canonical conversation."
        ],
        paths: ["gateway/src/process/store.ts", "gateway/src/process/history.ts", "gateway/src/process/schema/"]
      },
      {
        id: "context-epoch",
        label: "CONTEXT EPOCH",
        summary: "Freezes the rendered system prompt and initial availability projection, then records meaningful changes as ordered events.",
        mechanics: [
          "Context providers project system policy, run-as account, home, owner, skills, targets, MCP, date, and responsibilities.",
          "Reset, replacement, compaction, or standing-context change closes and archives the exact epoch.",
          "Protected prompt sources supply read-only content; runtime context selection and projection remain Process-owned behavior."
        ],
        paths: [
          "gateway/src/process/context/",
          "gateway/src/process/context-pressure.ts",
          "gateway/src/prompts/",
          "docs/architecture/responsibilities-and-context-epochs.md"
        ]
      },
      {
        id: "tools-approvals",
        label: "TOOLS + APPROVALS",
        summary: "Owns pending tool/result consistency, human-in-the-loop decisions, and exact run-control commands.",
        mechanics: [
          "Approved calls cross the Kernel syscall boundary with the Process identity and active-run fence.",
          "Exact Process-owned message send and yield commands control durable human delivery."
        ],
        paths: [
          "gateway/src/process/approval.ts",
          "gateway/src/process/tool-response.ts",
          "gateway/src/process/run-control-command.ts"
        ]
      },
      {
        id: "codemode",
        label: "PROCESS CODEMODE",
        summary: "Runs bounded JavaScript orchestration inside the Process while preserving the same approval and syscall boundaries as ordinary tools.",
        mechanics: [
          "The Process intercepts codemode.exec and owns the isolated executor lifecycle; target `gsv` does not implement CodeMode.",
          "Nested filesystem, shell, mail, and MCP operations cross the normal approval and Kernel syscall paths under the Process identity."
        ],
        paths: [
          "gateway/src/process/codemode.ts",
          "gateway/src/codemode/",
          "gateway/src/process/codemode.test.ts"
        ]
      },
      {
        id: "process-media",
        label: "PROCESS MEDIA",
        summary: "Stages model and tool media once, retains durable references, and resolves bytes only for explicit reads or model context.",
        mechanics: [
          "Temporary keys are scoped to the owning process and cleanup follows reset/kill ownership.",
          "History stores immutable references instead of duplicating potentially large bytes."
        ],
        paths: ["gateway/src/process/media.ts", "gateway/src/process/tool-result-media.ts"]
      }
    ]
  },
  {
    id: "conversation",
    label: "CONVERSATION LEDGER",
    shortLabel: "MESSAGES",
    category: "record",
    sourceRoot: "gateway/src/conversation/",
    summary: "The stable user-visible record. Conversation Durable Objects retain only committed Messages and immutable resource references across Process reset, replacement, or deletion.",
    owns: [
      "Canonical ship, work, group, and contact message histories",
      "Message idempotency receipts, resource references, and archive indexes",
      "Hot SQLite retention and immutable R2 archive segments"
    ],
    boundary: "Conversation history is intentionally smaller than Process activity: drafts, reasoning, tool calls, and uncommitted output stay with the Process.",
    invariant: "Authorized Kernel handlers append user and contact input, while explicit Process commits append Process output; every non-durable resource is retained at an exact revision before either path commits.",
    position: { x: 67, y: 61, height: 92 },
    components: [
      {
        id: "conversation-do",
        label: "CONVERSATION DO",
        summary: "Serializes canonical Message appends, replay protection, reads, resource validation, and archival decisions.",
        mechanics: [
          "Process-handled Messages may record a handling PID and run ID; authorized user and contact input can omit both.",
          "The stable Ship conversation survives replacement of its ordinary personal Process PID."
        ],
        paths: [
          "gateway/src/conversation/do.ts",
          "gateway/src/conversation/schema/",
          "packages/gsv/src/protocol/syscalls/conversation.ts",
          "gateway/src/conversation/do.test.ts"
        ]
      },
      {
        id: "message-store",
        label: "HOT MESSAGE STORE",
        summary: "Keeps recent canonical messages, receipts, archive indexes, and sequence state in Conversation SQLite.",
        mechanics: [
          "Idempotency receipts and monotonic sequence state make changed replays fail without duplicating visible history.",
          "Reset and kill cleanup do not confuse Process media with Conversation-owned references."
        ],
        paths: ["gateway/src/conversation/store.ts", "docs/architecture/conversations.md"]
      },
      {
        id: "archive-retention",
        label: "IMMUTABLE ARCHIVE",
        summary: "Moves bounded, checksum-verified Message segments from the hot store into installation-scoped R2 without changing their order.",
        mechanics: [
          "The archive transition verifies the stored object before committing its index and deleting corresponding hot rows.",
          "Reads merge immutable archive segments with hot SQLite messages while preserving the canonical sequence."
        ],
        paths: [
          "gateway/src/conversation/do.ts",
          "gateway/src/conversation/store.ts",
          "gateway/src/conversation/do.test.ts"
        ]
      },
      {
        id: "resource-references",
        label: "RESOURCE REFERENCES",
        summary: "Carries durable file/media identity in Message metadata while leaving large bytes in their owning store.",
        mechanics: [
          "Bytes are hydrated lazily for an explicit resource read or while building model context.",
          "One immutable revision can be referenced by many views without duplicating content."
        ],
        paths: ["docs/architecture/resource-references.md", "packages/gsv/src/protocol/resource.ts"]
      }
    ]
  },
  {
    id: "protocol",
    label: "SYSCALL + FRAME BOUNDARY",
    shortLabel: "PROTOCOL",
    category: "contract",
    sourceRoot: "gateway/src/protocol/",
    summary: "The primitive runtime language. Explicit request, response, signal, and body contracts are shared across browsers, native clients, machines, services, the Kernel, and Processes.",
    owns: [
      "Gateway frame decoding and Process-private frame contracts",
      "Target-routable syscall adapters and fixed model-facing tools",
      "Streaming-body ownership, cancellation, and run activity framing"
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
          "Process activity streaming has its own typed lifecycle frames."
        ],
        paths: [
          "gateway/src/protocol/frames.ts",
          "gateway/src/protocol/decode-wire-frame.ts",
          "gateway/src/protocol/process-frames.ts",
          "gateway/src/protocol/process-run-stream.ts",
          "gateway/src/protocol/decode-wire-frame.test.ts",
          "gateway/src/protocol/process-run-stream.test.ts"
        ]
      },
      {
        id: "model-tools",
        label: "MODEL TOOL SURFACE",
        summary: "Maps the fixed Read, Write, Edit, Delete, Search, Shell, and CodeMode interface onto ordinary syscalls.",
        mechanics: [
          "New capabilities compose below the fixed surface through syscalls, targets, shell commands, or CodeMode.",
          "Filesystem and shell tools can select capability targets; CodeMode itself stays Process-local and its nested syscalls use their ordinary target contracts."
        ],
        paths: ["gateway/src/syscalls/constants.ts", "gateway/src/syscalls/index.ts", "gateway/src/syscalls/"]
      },
      {
        id: "process-frames",
        label: "PROCESS FRAMES",
        summary: "Carries private Kernel-to-Process control, Process-to-Kernel commits, activity, and terminal outcomes.",
        mechanics: [
          "Process-owned commands do not grow the model tool surface.",
          "Run IDs and process identity fence every state-changing result."
        ],
        paths: ["gateway/src/protocol/process-frames.ts", "gateway/src/kernel/do.ts"]
      },
      {
        id: "syscall-reference",
        label: "PUBLIC SEMANTICS",
        summary: "Documents the stable behavior that every caller and target implementation must preserve.",
        mechanics: [
          "Authorization belongs to the Kernel boundary even when a UI hides unavailable actions.",
          "Remote cancellation cleans up the request route without recursively killing an already-created shell session."
        ],
        paths: ["docs/reference/syscalls.md", "docs/reference/websocket-protocol.md", "docs/reference/routing.md"]
      }
    ]
  },
  {
    id: "native-target",
    label: "NATIVE GSV TARGET",
    shortLabel: "GSV TARGET",
    category: "target",
    sourceRoot: "gateway/src/drivers/native/",
    summary: "The in-process Unix-shaped capability environment behind target `gsv`, implementing fs.*, shell.exec, and net.fetch over a mounted filesystem and bounded one-shot shell.",
    owns: [
      "Native fs.*, shell.exec, and net.fetch implementations",
      "GsvFs mount routing across virtual state, R2, media, homes, and repositories",
      "Composable one-shot command execution, network bodies, cancellation, and cleanup"
    ],
    boundary: "Unix-shaped means familiar paths, commands, streams, cancellation, and composition where real\u2014it is not a POSIX compatibility claim.",
    invariant: "A target exposes one coherent subset of stable syscall semantics; it is an environment, not merely a physical machine or arbitrary provider RPC.",
    position: { x: 48, y: 82, height: 84 },
    components: [
      {
        id: "target-provider",
        label: "TARGET PROVIDER",
        summary: "Implements the native target dispatch table used when a syscall selects target `gsv`.",
        mechanics: [
          "The Kernel resolves target metadata before invoking this provider.",
          "Filesystem, shell, and network calls retain the same external contracts as device-backed targets."
        ],
        paths: [
          "gateway/src/drivers/native/target.ts",
          "gateway/src/drivers/native/fs.ts",
          "gateway/src/kernel/dispatch.test.ts"
        ]
      },
      {
        id: "gsv-fs",
        label: "GSV FILESYSTEM",
        summary: "Routes Unix-like paths across Kernel projections, ordinary R2 bytes, Process media, account homes, and `/src/repos` repositories.",
        mechanics: [
          "/proc, /sys, /dev, and selected /etc paths project Kernel state; account-home and `/src/repos` routes use dedicated ripgit-aware backends.",
          "`/workspaces` has no special mount and falls through to ordinary R2; each mounted backend enforces its own storage and permission semantics."
        ],
        paths: [
          "gateway/src/fs/gsv-fs.ts",
          "gateway/src/fs/mount.ts",
          "gateway/src/fs/backends/",
          "gateway/src/fs/fs.test.ts"
        ]
      },
      {
        id: "worker-shell",
        label: "WORKER SHELL",
        summary: "Runs bounded, composable commands over GsvFs and target-aware services inside the Worker runtime.",
        mechanics: [
          "The native shell owns one-shot command discovery, streams, environment, limits, and cancellation below shell.exec.",
          "A supplied sessionId fails explicitly because native shell session continuation is not implemented.",
          "Built-ins expose GSV operations without giving callers a hidden alternate authority path."
        ],
        paths: [
          "gateway/src/drivers/native/shell.ts",
          "gateway/src/drivers/native/shell/",
          "gateway/src/drivers/native/shell.test.ts"
        ]
      },
      {
        id: "native-network",
        label: "NETWORK EXIT",
        summary: "Implements native net.fetch from the Gateway Worker network position with explicit request and response body ownership.",
        mechanics: [
          "The target provider accepts the request body, applies bounded fetch policy, and returns a streamed response through the stable net.fetch contract.",
          "Abort, timeout, and body cleanup remain owned by the active network operation."
        ],
        paths: [
          "gateway/src/drivers/native/target.ts",
          "gateway/src/kernel/net.ts",
          "gateway/src/kernel/net.test.ts"
        ]
      }
    ]
  },
  {
    id: "inference",
    label: "INFERENCE GATEWAY",
    shortLabel: "INFERENCE",
    category: "provider",
    sourceRoot: "gateway/src/inference/",
    summary: "Normalizes model discovery, generation, streaming, timeouts, cancellation, transcription, and image input across managed and deployment-configured providers.",
    owns: [
      "Normalized provider dispatch for the effective layered configuration",
      "Model registry, capability detection, timeouts, and output normalization",
      "Provider-specific transports for managed GSV, Workers AI, Codex, and custom endpoints"
    ],
    boundary: "Kernel/account defaults and Process-local overrides select the request; the Process owns the durable loop and history while inference owns one cancellation-safe provider operation.",
    invariant: "Provider quirks are normalized here so Process history and syscall semantics do not fork by model vendor.",
    position: { x: 74, y: 39, height: 82 },
    components: [
      {
        id: "inference-service",
        label: "NORMALIZED SERVICE",
        summary: "Dispatches generation to the resolved provider and normalizes streaming, timeout, cancellation, and error behavior.",
        mechanics: [
          "One boundary converts provider events into Process-consumable output.",
          "Cancellation is propagated to the component that owns the active provider operation."
        ],
        paths: ["gateway/src/inference/service.ts", "gateway/src/inference/provider.ts", "gateway/src/inference/timeout.ts"]
      },
      {
        id: "model-registry",
        label: "CONFIG + MODEL REGISTRY",
        summary: "Resolves model identities and capabilities after Kernel/account defaults are layered with Process-local configuration.",
        mechanics: [
          "Kernel AI handlers combine global, owner, and run-as account defaults with overrides persisted in Process SQLite.",
          "Available tools, targets, and MCP capabilities are filtered through the active grant."
        ],
        paths: [
          "gateway/src/inference/model-registry.ts",
          "gateway/src/inference/capabilities.ts",
          "gateway/src/kernel/ai.ts",
          "gateway/src/process/ai-config.ts",
          "gateway/src/process/store.ts",
          "gateway/src/kernel/ai.test.ts",
          "gateway/src/process/ai-config.test.ts",
          "gateway/src/inference/model-registry.test.ts"
        ]
      },
      {
        id: "providers",
        label: "PROVIDER TRANSPORTS",
        summary: "Implements the concrete managed, Workers AI, Codex, pi-ai, and compatible custom provider transports.",
        mechanics: [
          "Provider credentials are resolved for the Process runtime and are not forwarded to device targets.",
          "Each transport returns the same normalized output and error vocabulary."
        ],
        paths: [
          "gateway/src/inference/gsv-provider.ts",
          "gateway/src/inference/workers-ai.ts",
          "gateway/src/inference/openai-codex.ts",
          "gateway/src/inference/custom-provider.ts",
          "gateway/src/inference/pi-ai.ts"
        ]
      },
      {
        id: "media-inference",
        label: "SPEECH + IMAGE",
        summary: "Owns gateway-side transcription, speech output, image validation, and model-readable media preparation.",
        mechanics: [
          "Media is validated and normalized before provider-specific request construction.",
          "Large content remains referenced until the inference boundary explicitly hydrates it."
        ],
        paths: [
          "gateway/src/inference/transcription.ts",
          "gateway/src/inference/speech.ts",
          "gateway/src/inference/image-reading.ts"
        ]
      }
    ]
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
      "Binary body, media, resource, cancellation, and stream contracts"
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
          "ConnectArgs carries peer metadata and an optional implements list; neither the transport nor that advertisement grants authority."
        ],
        paths: ["packages/gsv/src/client.ts", "packages/gsv/src/index.ts"]
      },
      {
        id: "syscall-map",
        label: "SYSCALL CATALOG",
        summary: "Maps every public syscall name to its typed ArgsOf and ResultOf contract.",
        mechanics: [
          "Domains cover filesystem, shell, network, processes, conversations, repositories, schedules, responsibilities, AI, adapters, and signals.",
          "Generated namespaces keep callers aligned with the central catalog; body ownership remains in the frame and binary-body channels."
        ],
        paths: ["packages/gsv/src/protocol/syscalls/map.ts", "packages/gsv/src/protocol/syscalls/"]
      },
      {
        id: "frame-bodies",
        label: "FRAMES + BODIES",
        summary: "Defines request/response/signal envelopes and the single-owner channel used for binary payloads.",
        mechanics: [
          "Body descriptors stay in structured frames while bytes move on a bounded binary channel.",
          "Cancellation and terminal ownership are explicit protocol events."
        ],
        paths: [
          "packages/gsv/src/protocol/wire-frame.ts",
          "packages/gsv/src/protocol/binary-frame.ts",
          "packages/gsv/src/protocol/binary-body-channel.ts",
          "packages/gsv/src/protocol/request-cancel.ts"
        ]
      },
      {
        id: "media-resources",
        label: "MEDIA + RESOURCES",
        summary: "Carries immutable file identity, adapter media metadata, and managed inference stream events across typed boundaries.",
        mechanics: [
          "References preserve source identity without embedding private file bytes in histories.",
          "Media bodies share the same cancellation and ownership rules as other binary transfers."
        ],
        paths: [
          "packages/gsv/src/protocol/resource.ts",
          "packages/gsv/src/protocol/adapter-media-body.ts",
          "packages/gsv/src/protocol/managed-inference-stream.ts"
        ]
      }
    ]
  },
  {
    id: "services",
    label: "SERVICE CONTRACTS",
    shortLabel: "SERVICES",
    category: "service",
    sourceRoot: "packages/gsv/src/services/",
    summary: "Public Worker RPC interfaces for installation lookup, onboarding, entitlements, funded inference, mail, and adapters. Accounts and funded inference stay operator-owned; bundled channel and managed-mail implementations live here.",
    owns: [
      "Public RPC contracts between GSV runtime components and service implementations",
      "Installation-scoped capability interfaces and lifecycle result types",
      "The seam that keeps provider and operator policy out of the Kernel"
    ],
    boundary: "Contracts live in the public SDK; each implementation remains with its provider, bundled adapter, mail service, or deployment operator.",
    invariant: "Service capabilities enter through installation-scoped bindings, and bundled adapters implement the same AdapterService contract used by external deployments.",
    position: { x: 51, y: 6, height: 68 },
    components: [
      {
        id: "directory",
        label: "INSTALLATION DIRECTORY",
        summary: "Resolves accepted hostnames and immutable installation IDs plus their active, restricted, retained, or provisioning state.",
        mechanics: [
          "The Gateway uses this trusted result before addressing a named Kernel.",
          "Inactive and unknown routes fail closed without allocating ordinary work."
        ],
        paths: ["packages/gsv/src/services/directory.ts", "docs/architecture/services.md"]
      },
      {
        id: "onboarding-entitlements",
        label: "ONBOARDING + ENTITLEMENTS",
        summary: "Defines one-installation setup authorization/completion and versioned, expiring entitlement snapshots.",
        mechanics: [
          "Onboarding capabilities authorize first boot only and are consumed on successful setup.",
          "Entitlements describe operator-funded capability availability without replacing Kernel authorization."
        ],
        paths: ["packages/gsv/src/services/onboarding.ts", "packages/gsv/src/services/entitlements.ts"]
      },
      {
        id: "managed-inference",
        label: "FUNDED INFERENCE",
        summary: "Produces an installation-scoped generation target with generate, stream, and abort operations.",
        mechanics: [
          "The service remains the provider boundary while the Process retains durable run ownership.",
          "Installation lifecycle is rechecked before managed work is admitted."
        ],
        paths: ["packages/gsv/src/services/inference.ts"]
      },
      {
        id: "mail",
        label: "MANAGED MAIL",
        summary: "Defines exact intake, canonical draft claim, completion, and diagnostic operations for managed email.",
        mechanics: [
          "Gateway and mail service exchange durable references rather than trusting public sender fields.",
          "MailService is a mail-specific contract, not a messaging AdapterService or adapter-catalog entry; uncertain outcomes remain inspectable."
        ],
        paths: ["packages/gsv/src/services/mail.ts"]
      },
      {
        id: "adapter-service",
        label: "ADAPTER EXTENSION",
        summary: "Describes adapter lifecycle, pairing, status, delivery, activity, media, and optional target execution.",
        mechanics: [
          "Deployment-owned bindings select the adapter identity and attenuated grant.",
          "Messaging transport and an optional Unix-shaped target remain independent projections."
        ],
        paths: ["packages/gsv/src/services/adapters.ts"]
      }
    ]
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
      "Accessible interaction, visual design, drafts, and client-side view state"
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
          "Provisioning credentials remain tab-scoped and local passwords are created only by the Kernel."
        ],
        paths: [
          "web/src/app/App.tsx",
          "web/src/app/providers/AppProviders.tsx",
          "web/src/app/services/session/SessionProvider.tsx",
          "web/src/app/services/gateway/GatewayProvider.tsx"
        ]
      },
      {
        id: "desktop-shell",
        label: "DESKTOP SHELL",
        summary: "Hosts the spatial desktop, system rail, console frame, status bar, browser routes, and persistent chat dock.",
        mechanics: [
          "Live desktop objects represent Machines, Messengers, and Integrations; system surfaces remain separate destinations.",
          "Navigation and unsaved-work guards own transitions without duplicating feature state."
        ],
        paths: [
          "web/src/app/features/gsv-shell/GsvShell.tsx",
          "web/src/app/features/gsv-shell/domain/shellModel.ts",
          "web/src/app/features/gsv-shell/routing/shellRoutes.ts"
        ]
      },
      {
        id: "chat",
        label: "CHAT + WORK SESSIONS",
        summary: "Presents the canonical Ship and explicitly targeted Process work sessions, including activity, approvals, media, and interruption.",
        mechanics: [
          "Transient run activity and committed conversation history remain visibly distinct.",
          "Selecting another work process is explicit and does not redefine the personal conversation elsewhere."
        ],
        paths: ["web/src/app/features/chat/components/ChatDock.tsx", "web/src/app/features/chat/backend/chatService.ts"]
      },
      {
        id: "system-console",
        label: "SYSTEM CONSOLE",
        summary: "Dispatches the built-in operational surfaces for processes, responsibilities, agents, machines, adapters, integrations, contacts, and configuration.",
        mechanics: [
          "Each surface keeps a clear job and maps decisions onto gateway syscalls instead of dumping raw records.",
          "The central console dispatcher supplies shared framing and breadcrumbs while features own their own presentation."
        ],
        paths: ["web/src/app/features/gsv-console/components/GsvConsole.tsx", "web/src/app/features/gsv-console/"]
      },
      {
        id: "work-surfaces",
        label: "FILES + SHELL + KNOWLEDGE",
        summary: "Provides target filesystem browsing, shell execution, repository inspection, and ripgit-backed Markdown knowledge workspaces.",
        mechanics: [
          "Feature services call the same typed fs.*, shell.*, and repo.* primitives available to other clients.",
          "Gateway signals invalidate scoped queries before the surface refetches authoritative state."
        ],
        paths: [
          "web/src/app/features/files/",
          "web/src/app/features/terminal/",
          "web/src/app/features/repositories/",
          "web/src/app/features/gsv-console/library/",
          "web/src/app/services/query/GatewaySignalInvalidator.tsx"
        ]
      },
      {
        id: "design-system",
        label: "DESIGN SYSTEM",
        summary: "Owns reusable controls, tokens, typography, stories, and operational desktop patterns shared by Web surfaces.",
        mechanics: [
          "Components remain presentation primitives rather than owning backend policy.",
          "The catalog and previews make visual contracts inspectable without signing into a live installation."
        ],
        paths: ["web/src/app/components/ui/", "web/src/design-system/", "web/src/styles/"]
      }
    ]
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
      "Local transcription/gesture computation and bounded IPC contracts"
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
          "Compatibility launchers hand off to the owning executable instead of embedding its runtime."
        ],
        paths: ["host/apps/cli/src/main.rs", "host/apps/cli/src/commands/", "host/apps/cli/src/kernel_client.rs"]
      },
      {
        id: "desktop",
        label: "NATIVE DESKTOP",
        summary: "GPUI conversation cockpit owning the selected Process, visible conversation model, drafts, approvals, attachments, and local controls.",
        mechanics: [
          "A background client reconciles authoritative history and signals into presentation moments.",
          "PID, session, and operation fences prevent previous work from mutating the newly selected workspace."
        ],
        paths: [
          "host/apps/desktop/src/app.rs",
          "host/apps/desktop/src/client.rs",
          "host/apps/desktop/src/model.rs",
          "host/apps/desktop/src/interaction.rs"
        ]
      },
      {
        id: "machine",
        label: "GSVD MACHINE",
        summary: "A persistent driver peer that exposes the local computer as a filesystem, shell, network, and transfer target.",
        mechanics: [
          "Owns request cancellation, subprocess/session lifetime, streaming bodies, reconnection, health, logs, and shutdown.",
          "The OS service manager owns background lifecycle; gsvd remains an unprivileged foreground daemon process."
        ],
        paths: ["host/apps/machine/src/app.rs", "host/apps/machine/src/device/", "host/apps/machine/src/tools/"]
      },
      {
        id: "host-contracts",
        label: "SHARED HOST CONTRACTS",
        summary: "Provides Gateway transport, atomic host configuration, and bounded Desktop, daemon, and gesture IPC protocols.",
        mechanics: [
          "Contracts carry typed, redacted control information and deliberately exclude private conversation, credential, and media content.",
          "The host Cargo workspace owns their lockfile and build artifacts."
        ],
        paths: [
          "host/crates/gateway-client/",
          "host/crates/config/",
          "host/crates/desktop-protocol/",
          "host/crates/daemon-protocol/",
          "host/crates/gesture-protocol/"
        ]
      },
      {
        id: "helpers",
        label: "LOCAL HELPERS",
        summary: "Separately supervised transcription and gesture processes own microphone, camera, native inference, and temporal interaction policy.",
        mechanics: [
          "Only bounded text, state, and fenced semantic intents cross to Desktop; raw audio/video never goes to the Gateway through these channels.",
          "Desktop remains the owner of the active voice request and user-visible action."
        ],
        paths: ["host/helpers/transcriber/", "host/helpers/gestures/", "docs/architecture/rust-host-applications.md"]
      }
    ]
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
      "Messaging transport plus any separately declared adapter-backed target"
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
          "Delivery IDs are bound to exact content; reuse with different content fails closed."
        ],
        paths: ["adapters/shared/src/gateway-rpc.ts", "adapters/shared/src/inbound-delivery.ts", "adapters/shared/src/delivery-ledger.ts"]
      },
      {
        id: "discord",
        label: "DISCORD",
        summary: "Owns a durable Discord Gateway session, heartbeats, normalized inbound events, and provider delivery.",
        mechanics: [
          "The account actor retains session and delivery state across Worker invocations.",
          "A deterministic provider nonce can strengthen safe outbound replay behavior."
        ],
        paths: ["adapters/discord/adapter.json", "adapters/discord/src/index.ts", "adapters/discord/src/discord-gateway.ts", "adapters/discord/src/discord-delivery.ts"]
      },
      {
        id: "telegram",
        label: "TELEGRAM",
        summary: "Owns standalone bot webhooks and managed shared-bot pairing through signed provider ingress and one generation-fenced human route.",
        mechanics: [
          "Standalone mode encodes an account-owned webhook route and retains bot delivery state in its account actor.",
          "Managed mode accepts provider-authenticated identity, but only a signed-in GSV human confirmation activates installation routing."
        ],
        paths: [
          "adapters/telegram/adapter.json",
          "adapters/telegram/src/telegram-account.ts",
          "adapters/telegram/src/managed-http.ts",
          "adapters/telegram/src/managed-peer.ts",
          "adapters/telegram/src/managed-pairing.ts"
        ]
      },
      {
        id: "slack",
        label: "SLACK",
        summary: "Owns standalone Socket Mode sessions and managed workspace installation, per-human routes, signed interactions, delivery, and an optional Slack target.",
        mechanics: [
          "Workspace credentials and route generations stay in adapter-owned Durable Objects rather than Kernel configuration.",
          "The managed slack command target is a separate capability projection and does not merge provider identity with messaging transport."
        ],
        paths: [
          "adapters/slack/adapter.json",
          "adapters/slack/src/slack-account.ts",
          "adapters/slack/src/managed-workspace.ts",
          "adapters/slack/src/managed-peer.ts",
          "adapters/slack/src/slack-target-shell.ts"
        ]
      },
      {
        id: "whatsapp",
        label: "WHATSAPP",
        summary: "Owns the linked-device socket, durable Baileys credentials, identity normalization, lifecycle, encrypted media, and account ledger.",
        mechanics: [
          "Complete provider event identity\u2014including group participant context\u2014feeds stable ingress receipts.",
          "Media decryption and provider protocol details remain inside the adapter."
        ],
        paths: [
          "adapters/whatsapp/adapter.json",
          "adapters/whatsapp/src/whatsapp-account.ts",
          "adapters/whatsapp/src/auth-store.ts",
          "adapters/whatsapp/src/identity.ts",
          "adapters/whatsapp/src/media.ts"
        ]
      },
      {
        id: "email",
        label: "MANAGED MAIL SERVICE",
        summary: "A mail-specific intake and outbound delivery pipeline with exact raw-body staging, quotas, dedupe, claims, and uncertain-outcome handling.",
        mechanics: [
          "Trusted address resolution supplies installation scope before MIME or inference work is admitted.",
          "It implements MailService/MailGatewayService rather than AdapterService and is not part of the channel adapter catalog."
        ],
        paths: ["adapters/email/src/index.ts", "adapters/email/src/mail-installation.ts", "adapters/email/src/outbound.ts"]
      },
      {
        id: "test-adapter",
        label: "TEST ADAPTER",
        summary: "Provider-free end-to-end fixture for the real adapter boundary and delivery semantics.",
        mechanics: [
          "Exercises normalized ingress and outbound behavior without external platform state.",
          "It has no adapter.json and remains a development/E2E fixture rather than an ordinary cataloged deployment unit."
        ],
        paths: ["adapters/test/src/index.ts", "docs/architecture/adapter-model.md"]
      }
    ]
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
      "Local popup, options, side panel, viewer, and persisted browser-target state"
    ],
    boundary: "The extension is a target provider\u2014not the Web UI and not a messaging adapter. Chrome permissions and the Kernel grant are independent boundaries.",
    invariant: "A claimed browser peer ID or advertised implementation does not grant access; the Kernel still derives identity and callable routes.",
    position: { x: 91, y: 58, height: 78 },
    components: [
      {
        id: "supervisor-driver",
        label: "SUPERVISOR + DRIVER",
        summary: "Maintains the MV3 background connection, registers implementations, dispatches syscalls, and tears down stale work.",
        mechanics: [
          "Connection epochs and abort registries fence callbacks from a replaced endpoint.",
          "The service worker remains the target's transport owner across Chrome lifecycle events."
        ],
        paths: [
          "extension/src/background/service-worker.ts",
          "extension/src/background/connection-supervisor.ts",
          "extension/src/background/driver.ts"
        ]
      },
      {
        id: "browser-fs-shell",
        label: "FILESYSTEM + SHELL",
        summary: "Exposes browser state through familiar paths and composable just-bash commands with persistent writable areas.",
        mechanics: [
          "IndexedDB backs writable /home/browser and /tmp while runtime paths project live browser resources.",
          "Commands operate on Chrome APIs without pretending arbitrary actions are POSIX syscalls."
        ],
        paths: ["extension/src/target/fs.ts", "extension/src/target/runtime-fs.ts", "extension/src/target/shell.ts", "extension/src/target/commands/"]
      },
      {
        id: "page-automation",
        label: "PAGE AUTOMATION",
        summary: "Owns semantic page observation, input, JavaScript, actions, tab resources, and network recording.",
        mechanics: [
          "Page semantics turn volatile DOM state into inspectable, bounded command results.",
          "Network and media capture retain explicit stream and cancellation ownership."
        ],
        paths: ["extension/src/target/page-semantics.ts", "extension/src/target/page-actions.ts", "extension/src/target/network-recorder.ts"]
      },
      {
        id: "browser-surfaces",
        label: "LOCAL SURFACES",
        summary: "Provides inspectable connection state, diagnostics, configuration, side-panel control, and artifact viewing.",
        mechanics: [
          "These views administer the extension target but do not replace Kernel authorization.",
          "Offscreen documents isolate media recording work required by MV3."
        ],
        paths: ["extension/src/popup/", "extension/src/options/", "extension/src/sidepanel/", "extension/src/viewer/", "extension/src/offscreen/"]
      }
    ]
  },
  {
    id: "ripgit",
    label: "RIPGIT STORAGE",
    shortLabel: "RIPGIT",
    category: "storage",
    sourceRoot: "ripgit/src/",
    summary: "GSV's built-in, installation-scoped Git service. It stores account homes, context, skills, wikis, and repositories as inspectable version history; `/workspaces` remains ordinary R2.",
    owns: [
      "Git smart HTTP, refs, commits, trees, blobs, packs, deltas, and diffs",
      "Installation-scoped Repository Durable Objects and SQLite schema",
      "Kernel-facing atomic read, search, compare, apply, and import operations"
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
          "Each Repository actor initializes and owns its SQL-backed Git object store."
        ],
        paths: ["ripgit/src/lib.rs", "gateway/src/installation/ripgit.ts"]
      },
      {
        id: "git-protocol",
        label: "GIT SMART HTTP",
        summary: "Implements ref advertisement, receive-pack, upload-pack, pack indexing, and delta resolution.",
        mechanics: [
          "Public clone/fetch/push use ordinary Git HTTP shapes through the Gateway proxy.",
          "Write access is projected by authenticated Gateway actor headers, not anonymous request claims."
        ],
        paths: ["ripgit/src/git.rs", "ripgit/src/pack.rs", "gateway/src/git.ts"]
      },
      {
        id: "object-store",
        label: "GIT OBJECT STORE",
        summary: "Persists refs, commits, trees, blobs, versions, keyframes, and deltas in the repository's SQLite database.",
        mechanics: [
          "Periodic full keyframes bound worst-case reconstruction across stored deltas.",
          "The repository actor is the sole owner of schema and object consistency."
        ],
        paths: ["ripgit/src/store.rs", "ripgit/src/schema.rs"]
      },
      {
        id: "hyperspace",
        label: "HYPERSPACE API",
        summary: "Gives the Kernel atomic higher-level read, search, compare, apply, and import operations over Git-backed trees.",
        mechanics: [
          "Internal calls rely on service-binding reachability plus the Gateway-injected installation header; Hyperspace currently performs no separate shared-secret check.",
          "Filesystem and repo.* callers compose on this API without learning Git storage internals."
        ],
        paths: ["ripgit/src/hyperspace.rs", "ripgit/src/api.rs", "ripgit/src/diff.rs"]
      }
    ]
  },
  {
    id: "deployment",
    label: "DEPLOYMENT ASSEMBLY",
    shortLabel: "DEPLOY",
    category: "service",
    sourceRoot: "deployment/",
    summary: "The catalog-driven build and provisioning plane. Its checked-in Alchemy entrypoint assembles the standalone Gateway, ripgit, cataloged channels, and bindings; reusable primitives support an external managed composition.",
    owns: [
      "The checked-in standalone Alchemy composition and reusable managed-binding primitives",
      "Adapter catalog validation, generated CHANNEL_* bindings, bundle checksums, and release metadata",
      "Local development stacks and managed-deployment compatibility checks"
    ],
    boundary: "Deployment code chooses and wires runtime components; once deployed, authentication and authorization belong to those components rather than the provisioning scripts.",
    invariant: "Each deployable component is declared once and assembled through validated catalogs and explicit bindings instead of source-level runtime registries.",
    position: { x: 58, y: 1, height: 64 },
    components: [
      {
        id: "runtime-manifest",
        label: "RUNTIME MANIFEST",
        summary: "Defines deployable component metadata, compatibility modes, package inputs, and the release shape consumed by provisioning.",
        mechanics: [
          "The checked-in runtime catalog names the artifacts that belong to one compatible GSV release.",
          "Typed manifest parsing rejects malformed assembly inputs before resources are changed."
        ],
        paths: ["deployment/runtime.json", "deployment/src/manifest.ts"]
      },
      {
        id: "runtime-composition",
        label: "RUNTIME COMPOSITION",
        summary: "Builds the standalone Gateway, ripgit, storage, Durable Object, route, and binding graph from the validated manifest.",
        mechanics: [
          "The checked-in alchemy.run.ts invokes StandaloneGsvDeployment; an operator-owned managed entrypoint composes the reusable GsvRuntime separately.",
          "Standalone composition preserves explicit singleton upgrade projections where the runtime still supports them.",
        ],
        paths: ["alchemy.run.ts", "deployment/src/runtime.ts", "deployment/src/standalone.ts"]
      },
      {
        id: "adapter-catalog",
        label: "ADAPTER CATALOG",
        summary: "Discovers cataloged channel manifests once and derives validated Worker, entrypoint, secret, Durable Object, and CHANNEL_* binding metadata.",
        mechanics: [
          "WhatsApp, Discord, Telegram, and Slack declare deployment facts in adapter.json instead of a Gateway source registry.",
          "Email and the test fixture are intentionally outside this catalog; the same catalog drives channel development, bundles, and provisioning."
        ],
        paths: [
          "scripts/adapter-catalog.mjs",
          "adapters/discord/adapter.json",
          "adapters/slack/adapter.json",
          "adapters/telegram/adapter.json",
          "adapters/whatsapp/adapter.json",
          "deployment/src/adapter.ts"
        ]
      },
      {
        id: "release-bundles",
        label: "RELEASE BUNDLES",
        summary: "Builds component artifacts and records checksums so the deployer can assemble a coherent, inspectable release.",
        mechanics: [
          "Gateway, ripgit, and cataloged standalone channel bundles remain separate deployment units; managed variants, email, and the test fixture are not folded into that set.",
          "Generated release metadata binds manifest entries to exact bundle content."
        ],
        paths: ["scripts/build-cloudflare-bundles.sh", "scripts/build-deployment-manifest.mjs"]
      },
      {
        id: "development-stacks",
        label: "DEVELOPMENT STACKS",
        summary: "Starts local standalone or managed-compatible workers and verifies operator-service contract wiring.",
        mechanics: [
          "The managed stack accepts an external services root because operator implementations are not public-runtime source.",
          "Validation checks binding and manifest compatibility without moving service implementation into GSV."
        ],
        paths: ["scripts/dev-stack.sh", "scripts/dev-managed-stack.sh", "scripts/check-managed-deployment.sh"]
      }
    ]
  }
];
const ARCHITECTURE_EDGES = [
  { id: "deployment-services", from: "deployment", to: "services", label: "managed binding primitives", kind: "contract" },
  { id: "deployment-gateway", from: "deployment", to: "gateway", label: "build-time routes + service bindings", kind: "provision", security: true },
  { id: "deployment-adapters", from: "deployment", to: "adapters", label: "cataloged channel assembly", kind: "provision", security: true },
  { id: "deployment-ripgit", from: "deployment", to: "ripgit", label: "storage Worker assembly", kind: "provision", security: true },
  { id: "services-gateway", from: "services", to: "gateway", label: "trusted installation directory + lifecycle admission", kind: "control", security: true },
  { id: "services-inference", from: "services", to: "inference", label: "funded inference RPC contract", kind: "contract" },
  { id: "services-adapters", from: "services", to: "adapters", label: "adapter + managed mail RPC contracts", kind: "contract" },
  { id: "sdk-protocol", from: "sdk", to: "protocol", label: "public syscall + frame types", kind: "contract" },
  { id: "sdk-gateway", from: "sdk", to: "gateway", label: "typed client contract", kind: "contract" },
  { id: "web-sdk", from: "web", to: "sdk", label: "JavaScript client package", kind: "contract" },
  { id: "extension-sdk", from: "extension", to: "sdk", label: "JavaScript client + protocol package", kind: "contract" },
  { id: "host-protocol", from: "host", to: "protocol", label: "Rust gateway wire contract", kind: "contract" },
  { id: "protocol-gateway", from: "protocol", to: "gateway", label: "validated frame contract", kind: "contract" },
  { id: "gateway-kernel", from: "gateway", to: "kernel", label: "installation-scoped admission", kind: "control", security: true },
  { id: "web-gateway", from: "web", to: "gateway", label: "user HTTPS + WebSocket", kind: "request", security: true },
  { id: "host-gateway-human", from: "host", to: "gateway", label: "Desktop + CLI user connections", kind: "request", security: true },
  { id: "host-gateway-machine", from: "host", to: "gateway", label: "gsvd machine-target peer", kind: "request", security: true },
  { id: "adapters-gateway", from: "adapters", to: "gateway", label: "attenuated service frames", kind: "request", security: true },
  { id: "extension-gateway", from: "extension", to: "gateway", label: "browser target peer", kind: "request", security: true },
  { id: "kernel-process", from: "kernel", to: "process", label: "process control + signals", kind: "control", security: true },
  { id: "process-inference", from: "process", to: "inference", label: "normalized generation boundary", kind: "request", security: true },
  { id: "process-kernel", from: "process", to: "kernel", label: "syscalls + message commits", kind: "request", security: true },
  { id: "kernel-conversation", from: "kernel", to: "conversation", label: "authorized canonical message operations", kind: "data", security: true },
  { id: "kernel-native", from: "kernel", to: "native-target", label: "target:gsv dispatch", kind: "request", security: true },
  { id: "kernel-host", from: "kernel", to: "host", label: "machine target calls", kind: "request", security: true },
  { id: "kernel-extension", from: "kernel", to: "extension", label: "browser target calls", kind: "request", security: true },
  { id: "kernel-adapters", from: "kernel", to: "adapters", label: "message delivery + adapter targets", kind: "request", security: true },
  { id: "kernel-ripgit", from: "kernel", to: "ripgit", label: "installation-scoped repo operations", kind: "data", security: true },
  { id: "native-ripgit", from: "native-target", to: "ripgit", label: "account-home + /src/repos mounts", kind: "data", security: true }
];
const ARCHITECTURE_FLOWS = [
  {
    id: "human-turn",
    label: "HUMAN \u2192 AGENT \u2192 MESSAGE",
    summary: "A signed-in Web or native client input is appended by an authorized Kernel handler; only Process-produced output requires an explicit commit into stable history.",
    steps: [
      { subsystemId: "web", componentId: "chat", label: "Signed-in Web option", detail: "The Web client submits conversation.send over its authenticated user connection." },
      { subsystemId: "host", componentId: "desktop", label: "Signed-in native option", detail: "Native Desktop uses its own authenticated Gateway client; adapter input follows the separate adapter-ingress trace." },
      { subsystemId: "gateway", componentId: "edge-router", label: "Installation admission", detail: "The edge resolves the trusted installation route before any installation-owned Durable Object is addressed." },
      { subsystemId: "kernel", componentId: "identity-policy", label: "Authenticate + authorize", detail: "The Kernel derives the principal and grant, then applies conversation and Process ownership policy." },
      { subsystemId: "conversation", componentId: "conversation-do", label: "Commit user Message", detail: "The canonical user-visible input is persisted before the Process run is admitted." },
      { subsystemId: "process", componentId: "agent-loop", label: "Run the Process", detail: "The Process assembles its frozen context, queues or supersedes input according to run policy, and starts one serialized loop." },
      { subsystemId: "inference", componentId: "inference-service", label: "Generate", detail: "The normalized inference boundary streams provider output and propagates timeout or cancellation to the active operation." },
      { subsystemId: "process", componentId: "tools-approvals", label: "Commit + yield", detail: "Exact message send commands create user-visible updates; yield closes the human-facing run." },
      { subsystemId: "kernel", componentId: "delivery-coordination", label: "Route + synchronize", detail: "The connection run route receives transient message activity; committed-message signals synchronize signed-in clients independently of that route." },
      { subsystemId: "conversation", componentId: "message-store", label: "Stable history", detail: "The committed Message remains in the canonical ledger even if the handling Process is later reset or replaced." }
    ]
  },
  {
    id: "target-syscall",
    label: "TARGET-ROUTED SYSCALL",
    summary: "A targetable fs.*, shell.exec, or net.fetch syscall keeps one contract when implemented by the native cloud target, a physical machine, or a browser profile.",
    steps: [
      { subsystemId: "process", componentId: "tools-approvals", label: "Issue tool call", detail: "A model tool, or a nested operation issued by Process-local CodeMode, resolves to an ordinary typed syscall and target argument." },
      { subsystemId: "kernel", componentId: "dispatch-routing", label: "Resolve target", detail: "The Kernel strips target metadata, checks authority, visibility, online state, and advertised implementation, then chooses the owner." },
      { subsystemId: "native-target", componentId: "target-provider", label: "Native option", detail: "target:gsv executes inside the Worker over GsvFs, the bounded shell, or native network implementation." },
      { subsystemId: "host", componentId: "machine", label: "Machine option", detail: "A gsvd peer owns local filesystem, subprocess, transfer, body, cancellation, and cleanup behavior." },
      { subsystemId: "extension", componentId: "supervisor-driver", label: "Browser option", detail: "The extension dispatches into its Unix-shaped browser filesystem and Chrome-backed command environment." },
      { subsystemId: "kernel", componentId: "dispatch-routing", label: "Fenced response", detail: "The exact route returns one response/body outcome and is removed on completion, cancellation, disconnect, or timeout." },
      { subsystemId: "process", componentId: "process-store", label: "Persist result", detail: "The Process records the terminal tool result before continuing the provider-valid model history." }
    ]
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
      { subsystemId: "adapters", componentId: "shared", label: "Provider delivery", detail: "A content-bound delivery ID reaches the provider once, retries only known-safe failures, and records ambiguous outcomes without unsafe replay." }
    ]
  },
  {
    id: "managed-routing",
    label: "MANAGED INSTALLATION ROUTING",
    summary: "A public hostname becomes an immutable installation identity through a private directory and lifecycle gate before ordinary work is admitted.",
    steps: [
      { subsystemId: "services", componentId: "directory", label: "Resolve hostname", detail: "The trusted installation directory returns a validated immutable identity and lifecycle state\u2014or a not-found boundary." },
      { subsystemId: "gateway", componentId: "installation-routing", label: "Admit lifecycle", detail: "The Gateway accepts the trusted identity only for an active ordinary route, with narrowly allowed provisioning surfaces; unknown or restricted routes fail before Kernel addressing." },
      { subsystemId: "gateway", componentId: "installation-storage", label: "Scope physical owners", detail: "R2, Process, Conversation, ripgit, and adapter addresses retain installation scope before multi-installation work." },
      { subsystemId: "kernel", componentId: "kernel-do", label: "Address Kernel", detail: "The immutable installation ID names the serialized Kernel Durable Object." },
      { subsystemId: "process", componentId: "agent-loop", label: "Recheck Process ticks", detail: "An already-addressed Process rechecks managed lifecycle before a paused durable tick resumes." },
      { subsystemId: "kernel", componentId: "kernel-do", label: "Recheck background work", detail: "Kernel inference, scheduler, and other background admissions recheck managed lifecycle at their own durable boundary." }
    ]
  },
  {
    id: "versioned-files",
    label: "VERSIONED FILE + REPOSITORY WRITE",
    summary: "fs.* reaches ripgit-aware account homes and `/src/repos` through GsvFs, while repo.* goes directly from the Kernel to installation-scoped ripgit; `/workspaces` remains ordinary R2.",
    steps: [
      { subsystemId: "web", componentId: "work-surfaces", label: "Choose a stable primitive", detail: "Files, Library, Shell, SDK, or agent code issues fs.* for a path or repo.* for an explicit repository operation; these are separate routes." },
      { subsystemId: "kernel", componentId: "identity-policy", label: "Check identity + mode", detail: "The Kernel combines capabilities with account, repository, and filesystem ownership rules." },
      { subsystemId: "native-target", componentId: "gsv-fs", label: "Filesystem branch", detail: "For fs.*, GsvFs routes account homes and `/src/repos` through ripgit-aware backends; `/workspaces` has no special mount and uses ordinary R2." },
      { subsystemId: "kernel", componentId: "dispatch-routing", label: "Repository branch", detail: "For repo.*, Kernel dispatch bypasses GsvFs and calls the installation-scoped ripgit client directly, overwriting physical routing metadata with the trusted installation identity." },
      { subsystemId: "ripgit", componentId: "hyperspace", label: "Apply atomically", detail: "The internal API updates the Git tree and creates inspectable history inside the installation-scoped Repository actor." },
      { subsystemId: "web", componentId: "work-surfaces", label: "Refresh the view", detail: "Signals invalidate the affected client query and the surface reads the new authoritative revision." }
    ]
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
      { subsystemId: "host", componentId: "helpers", label: "Isolated native compute", detail: "Transcription and gesture helpers retain raw audio/video locally and return only bounded text, state, or fenced semantic intents." }
    ]
  },
  {
    id: "deployment-assembly",
    label: "STANDALONE CATALOG → RUNNING SYSTEM",
    summary: "The checked-in standalone entrypoint turns a release manifest and channel catalog into separately deployed Gateway, ripgit, and adapter Workers with explicit bindings.",
    steps: [
      { subsystemId: "deployment", componentId: "runtime-manifest", label: "Read release intent", detail: "The typed runtime manifest selects compatible Gateway, web, ripgit, and channel artifacts before provisioning begins." },
      { subsystemId: "deployment", componentId: "adapter-catalog", label: "Discover cataloged channels", detail: "WhatsApp, Discord, Telegram, and Slack manifests supply Worker, entrypoint, Durable Object, secret, and generated binding facts once." },
      { subsystemId: "deployment", componentId: "release-bundles", label: "Build exact artifacts", detail: "Gateway, ripgit, and each cataloged standalone channel are bundled separately and recorded with content checksums." },
      { subsystemId: "deployment", componentId: "runtime-composition", label: "Provision standalone", detail: "The checked-in Alchemy program composes Gateway routes, R2 storage, Durable Objects, ripgit, and channel service bindings." },
      { subsystemId: "ripgit", componentId: "worker-repository-do", label: "Provision versioned storage", detail: "ripgit remains a separately deployed Worker whose Repository Durable Objects own Git state." },
      { subsystemId: "gateway", componentId: "service-entrypoints", label: "Admit bound channels", detail: "Deployment-owned binding props fix each cataloged adapter identity and attenuated grant; frames cannot redefine either." }
    ]
  }
];
const subsystemById = new Map(
  ARCHITECTURE_SUBSYSTEMS.map((subsystem) => [subsystem.id, subsystem])
);
function architectureSubsystem(id) {
  const subsystem = subsystemById.get(id);
  if (!subsystem) {
    throw new Error(`Unknown architecture subsystem: ${id}`);
  }
  return subsystem;
}
function architectureComponent(subsystemId, componentId) {
  if (!componentId) {
    return null;
  }
  return architectureSubsystem(subsystemId).components.find((component) => component.id === componentId) ?? null;
}
function queryScore(haystack, terms, label, paths) {
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
function searchArchitecture(query) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return [];
  }
  const results = [];
  for (const subsystem of ARCHITECTURE_SUBSYSTEMS) {
    const subsystemText = [
      subsystem.label,
      subsystem.shortLabel,
      subsystem.sourceRoot,
      subsystem.summary,
      subsystem.boundary,
      subsystem.invariant,
      ...subsystem.owns
    ].join(" ").toLowerCase();
    const subsystemScore = queryScore(subsystemText, terms, subsystem.label, [subsystem.sourceRoot]);
    if (subsystemScore >= 0) {
      results.push({
        subsystemId: subsystem.id,
        label: subsystem.label,
        path: subsystem.sourceRoot,
        summary: subsystem.summary,
        score: subsystemScore
      });
    }
    for (const component of subsystem.components) {
      const componentText = [
        component.label,
        component.summary,
        ...component.mechanics,
        ...component.paths
      ].join(" ").toLowerCase();
      const componentScore = queryScore(componentText, terms, component.label, component.paths);
      if (componentScore >= 0) {
        results.push({
          subsystemId: subsystem.id,
          componentId: component.id,
          label: component.label,
          path: component.paths[0],
          summary: component.summary,
          score: componentScore + 1
        });
      }
    }
  }
  return results.sort((left, right) => right.score - left.score || left.label.localeCompare(right.label)).slice(0, 18);
}
function connectedSubsystems(id) {
  const connected = /* @__PURE__ */ new Set();
  for (const edge of ARCHITECTURE_EDGES) {
    if (edge.from === id) connected.add(edge.to);
    if (edge.to === id) connected.add(edge.from);
  }
  return [...connected];
}
const ARCHITECTURE_SOURCE_GUIDES = [
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
  "docs/how-to/deploy-with-alchemy.md",
  "docs/reference/syscalls.md",
  "docs/reference/websocket-protocol.md"
];
export {
  ARCHITECTURE_EDGES,
  ARCHITECTURE_FLOWS,
  ARCHITECTURE_SOURCE_GUIDES,
  ARCHITECTURE_SUBSYSTEMS,
  architectureComponent,
  architectureSubsystem,
  connectedSubsystems,
  searchArchitecture
};
