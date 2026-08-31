export const ATLAS_SCHEMA_VERSION = 1;

export const ATLAS_LENSES = [
  {
    id: "runtime",
    label: "RUNTIME",
    summary: "See actors and the contracts that carry live work between them.",
  },
  {
    id: "ownership",
    label: "OWNERSHIP",
    summary: "See which component owns policy, state, completion, and cleanup.",
  },
  {
    id: "security",
    label: "SECURITY",
    summary: "See trust scopes and the gates crossed before authority exists.",
  },
  {
    id: "durability",
    label: "DURABILITY",
    summary: "See the persistent foundations beneath transient routes and runs.",
  },
];

export const ATLAS_ZONES = [
  {
    id: "installation",
    label: "INSTALLATION INTERIOR",
    summary: "One immutable installation identity and its durable owners.",
    radius: 144,
  },
  {
    id: "boundary",
    label: "INSTALLATION GATE",
    summary: "Trusted routing and lifecycle admission before the Kernel is addressed.",
    radius: 164,
  },
  {
    id: "outer",
    label: "OUTER EXPANSE",
    summary: "Clients, providers, services, and targets that do not gain authority merely by connecting.",
    radius: 233,
  },
];

export const ATLAS_CONCEPTS = [
  "handle ≠ installationId",
  "peer ≠ target",
  "transport ≠ grant",
  "implements ≠ authority",
  "run route ≠ conversation",
  "Process history ≠ canonical Messages",
  "adapter transport ≠ adapter target",
];

export const ATLAS_SYSTEM_DETAIL = {
  gateway: {
    scene: { x: 0, z: -154, width: 42, depth: 20, height: 62 },
    scope: "installation gate",
    runtime: "Cloudflare Gateway Worker",
    owner: "Gateway edge routing",
    persistence: "Routing metadata only; durable installation truth belongs to Accounts and the Kernel.",
    admission: "Resolve a trusted hostname, derive the immutable installation ID, then enforce lifecycle state.",
    completion: "The edge forwards or rejects each request and cancels any body it accepted but cannot hand off.",
    security: [
      "A wildcard hostname cannot allocate a Kernel Durable Object.",
      "Public callers never supply installationId.",
      "Standalone singleton routing remains an explicit upgrade projection, not ambient trust.",
    ],
    docs: ["docs/architecture/security-model.md", "docs/architecture/services.md"],
    tests: [
      "gateway/test-integration/managed-routing.test.ts",
      "gateway/src/installation/routing.test.ts",
      "gateway/src/installation/lifecycle.test.ts",
    ],
  },
  kernel: {
    scene: { x: 0, z: -22, width: 50, depth: 44, height: 104 },
    scope: "installation interior",
    runtime: "Kernel Durable Object",
    owner: "Installation control plane and policy authority",
    persistence: "Kernel SQLite: identities, grants, config, registries, schedules, routes, links, and responsibilities.",
    admission: "Authenticate the caller, derive its principal, intersect capabilities, then enforce resource ownership.",
    completion: "Own request routes through response, timeout, disconnect, or cancellation; coordinate durable owners without absorbing their state.",
    security: [
      "Transport and claimed peer identity do not grant authority.",
      "Capability checks live here, even when a UI already hides an action.",
      "The Kernel coordinates native and remote execution; it is not the heavy compute host.",
    ],
    docs: [
      "docs/architecture/unified-protocol-peers.md",
      "docs/architecture/security-model.md",
      "docs/reference/routing.md",
    ],
    tests: [
      "gateway/src/kernel/dispatch.test.ts",
      "gateway/src/kernel/routing.test.ts",
      "gateway/src/kernel/capabilities.test.ts",
      "gateway/src/kernel/run-routes.test.ts",
    ],
  },
  process: {
    scene: { x: -72, z: 55, width: 34, depth: 34, height: 86 },
    scope: "process enclave",
    runtime: "Process Durable Object",
    owner: "One durable agent process and its serialized model loop",
    persistence: "Process SQLite plus process-scoped media: history, queue, pending tools, approvals, epochs, and run state.",
    admission: "Kernel-private process frames carry an already-derived identity and bounded operation into the Process owner.",
    completion: "Fence every run; reject late generations; settle every pending tool; distinguish abort, reset, and kill.",
    security: [
      "A Process executes under Kernel-issued authority and cannot grant itself more.",
      "A killed PID remains terminal across eviction.",
      "Protected prompt sources are inputs to context assembly, not runtime policy owners.",
    ],
    docs: [
      "docs/architecture/agent-loop.md",
      "docs/architecture/process-ipc-and-scheduler.md",
      "docs/architecture/responsibilities-and-context-epochs.md",
    ],
    tests: [
      "gateway/src/process/do.test.ts",
      "gateway/src/process/store.test.ts",
      "gateway/test-integration/process-controls.test.ts",
    ],
  },
  conversation: {
    scene: { x: 72, z: 52, width: 36, depth: 32, height: 68 },
    scope: "conversation enclave",
    runtime: "Conversation Durable Object",
    owner: "Canonical user-visible Message ledger",
    persistence: "Hot Conversation SQLite with immutable R2 archive segments and durable resource references.",
    admission: "Kernel-authorized appends identify the conversation and sender; Process-handled Messages may also carry handling PID, run, and idempotency metadata.",
    completion: "Commit each canonical Message once and archive safely; the Kernel independently owns client synchronization and adapter delivery.",
    security: [
      "Canonical Messages are separate from private Process history.",
      "A run route controls transient delivery; it does not own the conversation.",
      "Adapters consume committed Messages rather than model reasoning or drafts.",
    ],
    docs: ["docs/architecture/conversations.md", "docs/architecture/resource-references.md"],
    tests: [
      "gateway/src/conversation/do.test.ts",
      "gateway/src/kernel/conversation-handlers.test.ts",
      "gateway/src/kernel/run-routes.test.ts",
    ],
  },
  protocol: {
    scene: { x: -84, z: -55, width: 27, depth: 25, height: 50 },
    scope: "contract plane",
    runtime: "Shared TypeScript contracts and frame codecs",
    owner: "Syscall names, wire frames, Process frames, signals, and body lifecycle semantics",
    persistence: "None. Protocol metadata describes work; bytes remain owned by a single body channel or durable resource.",
    admission: "Decoders validate hostile frames; owning runtimes still authenticate principals and authorize operations.",
    completion: "Each request and body reaches one terminal outcome: response, error, cancellation, or consumed/forwarded body.",
    security: [
      "Frame metadata is not authority.",
      "Principal, callable grant, receivable signals, implementations, transport, and provenance are independent axes.",
      "Large or binary payloads travel as owned bodies rather than oversized metadata.",
    ],
    docs: ["docs/reference/syscalls.md", "docs/reference/websocket-protocol.md", "docs/reference/routing.md"],
    tests: [
      "gateway/src/protocol/decode-wire-frame.test.ts",
      "gateway/src/protocol/process-run-stream.test.ts",
      "packages/gsv/test/client-body.test.mjs",
    ],
  },
  "native-target": {
    scene: { x: 0, z: 102, width: 40, depth: 36, height: 62 },
    scope: "installation target",
    runtime: "In-process Worker target provider",
    owner: "The target named gsv and its Unix-shaped filesystem, one-shot shell, and network implementation",
    persistence: "Kernel control paths, process media, ordinary R2 bytes, and ripgit-backed account homes and /src/repos trees.",
    admission: "Kernel target dispatch preserves the same fs.*, shell.exec, and net.fetch contracts used by remote targets.",
    completion: "The native handler owns its command, streams, temporary resources, and cancellation until a terminal syscall response.",
    security: [
      "Target selection stays below stable syscall names.",
      "Unix-shaped means composable paths and streams, not a promise of POSIX compatibility.",
      "Storage backends remain implementation details behind GsvFs.",
    ],
    docs: ["docs/architecture/targets.md", "docs/architecture/context-and-knowledge.md"],
    tests: ["gateway/src/drivers/native/shell.test.ts", "gateway/src/fs/fs.test.ts"],
  },
  inference: {
    scene: { x: 169, z: -10, width: 31, depth: 29, height: 58 },
    scope: "provider orbit",
    runtime: "Gateway inference coordinator plus configured external provider",
    owner: "Model selection, provider transport, streaming generation, abort, and media inference",
    persistence: "Kernel state holds global/account defaults; Process SQLite may hold provider, model, base-URL, key, and media overrides. Active streams remain transient.",
    admission: "Kernel policy resolves an allowed model/provider and exposes only the capabilities available to that Process.",
    completion: "The inference service closes or aborts provider streams and reports a single terminal outcome back to the Process.",
    security: [
      "Configured model access is policy, not a capability inferred from provider reachability.",
      "The provider necessarily receives only the inference data routed to it.",
      "Funded managed inference remains an explicit operator service contract.",
    ],
    docs: ["docs/architecture/agent-loop.md", "docs/architecture/services.md"],
    tests: ["gateway/src/inference/service.test.ts", "gateway/src/inference/model-registry.test.ts"],
  },
  sdk: {
    scene: { x: -171, z: -72, width: 30, depth: 27, height: 50 },
    scope: "contract orbit",
    runtime: "Public JavaScript/TypeScript client package",
    owner: "Typed client requests, reverse-call endpoints, signals, cancellation, timeouts, and binary body channels",
    persistence: "No authoritative state; a client retains only connection-local requests, callbacks, and body ownership.",
    admission: "sys.connect establishes the authenticated peer; generated namespaces expose contracts but never bypass Kernel checks.",
    completion: "The client settles pending calls on response, timeout, abort, or disconnect and tears down unclaimed bodies.",
    security: [
      "Typed convenience does not make the client a policy authority.",
      "Reverse-call implementations advertise behavior, not permission.",
      "The SDK and Gateway share one wire language rather than parallel RPC shapes.",
    ],
    docs: ["docs/architecture/unified-protocol-peers.md", "docs/reference/websocket-protocol.md"],
    tests: ["packages/gsv/test/client-body.test.mjs", "packages/gsv/test/adapter-protocol.test.mjs"],
  },
  services: {
    scene: { x: 114, z: -139, width: 34, depth: 26, height: 54 },
    scope: "service contract orbit",
    runtime: "Public Worker RPC contracts with operator-owned or bundled implementations",
    owner: "Public RPC contracts for directory, onboarding, entitlements, funded inference, mail, and adapters",
    persistence: "Implementation-defined. Managed services own their records; bundled standalone channel adapters own their own Durable Object state.",
    admission: "Service bindings and one-time onboarding capabilities attenuate access; public callers cannot choose installation identity.",
    completion: "Each contract assigns claim, retry, completion, and diagnostic ownership to its implementing service.",
    security: [
      "Accounts and funded-inference implementations remain operator-owned; bundled standalone channels implement AdapterService directly.",
      "Only active installations admit ordinary work.",
      "Onboarding capability authorizes first boot for one installation, not general administration.",
    ],
    docs: ["docs/architecture/services.md", "docs/architecture/security-model.md"],
    tests: ["gateway/test-integration/managed-routing.test.ts", "packages/gsv/test/managed-inference-stream.test.mjs"],
  },
  web: {
    scene: { x: -169, z: -146, width: 28, depth: 25, height: 46 },
    scope: "human client orbit",
    runtime: "Browser application",
    owner: "Presentation, setup/login, direct manipulation, drafts, and browser-side Gateway synchronization",
    persistence: "Local UI/session state and query caches only; durable system truth remains behind Gateway syscalls.",
    admission: "The browser connects as an authenticated peer and receives only surfaces and actions allowed by Kernel policy.",
    completion: "Feature services own browser requests and cancellation; signal invalidation refreshes authoritative state after commits.",
    security: [
      "Hidden or disabled UI is product feedback, not authorization.",
      "Opening an explicit work Process does not replace Ship elsewhere.",
      "The Web shell is a client of the architecture, not the home of this atlas.",
    ],
    docs: ["docs/architecture/conversations.md", "engineering/builtin-app-design.md"],
    tests: ["web/src/app/services/gateway/frameBody.test.ts", "web/src/app/services/session/sessionService.test.ts"],
  },
  host: {
    scene: { x: -184, z: 72, width: 38, depth: 30, height: 62 },
    scope: "native peer orbit",
    runtime: "Separate Rust CLI, Desktop, gsvd, and helper processes",
    owner: "Native presentation, operator commands, physical-machine target execution, and isolated local media compute",
    persistence: "Locked host config, Desktop interaction state, daemon transfer/session state, and helper-local model assets.",
    admission: "Desktop and CLI authenticate as users; gsvd authenticates as a device provider; local control protocols remain bounded and same-user.",
    completion: "Each executable owns its subprocesses, reconnect loop, local IPC, streams, and shutdown independently.",
    security: [
      "Desktop and gsvd are siblings; there is no hidden Desktop-to-daemon data plane.",
      "A machine is one target provider, not the definition of target-ness.",
      "Raw microphone and camera data stay inside supervised helpers.",
    ],
    docs: ["docs/architecture/rust-host-applications.md", "docs/architecture/targets.md"],
    tests: ["host/apps/machine/tests/tools_test.rs", "host/crates/desktop-protocol/tests/unix_end_to_end.rs"],
  },
  adapters: {
    scene: { x: 181, z: -117, width: 40, depth: 32, height: 72 },
    scope: "provider transport orbit",
    runtime: "Platform-specific Workers and Durable Objects",
    owner: "Credentials, provider sessions, identity normalization, retries, formatting, delivery ledgers, and transport policy",
    persistence: "Installation/account-scoped receipts, pairing generations, provider credentials, session state, and delivery outcomes.",
    admission: "Deployment bindings attenuate adapter identity/grants; linked humans activate managed routes through signed-in confirmation.",
    completion: "Inbound payloads become durable before ingress; outbound attempts resolve to sent, retryable, failed, or ambiguous.",
    security: [
      "A public webhook or pairing code never selects an installation or local uid.",
      "Provider identity does not itself grant ordinary GSV syscalls.",
      "Messaging transport and an optional adapter-backed target are separate projections.",
    ],
    docs: ["docs/architecture/adapter-model.md", "docs/architecture/interaction-surface-bindings.md"],
    tests: ["adapters/shared/test/inbound-delivery.test.ts", "adapters/shared/test/delivery-ledger.test.ts"],
  },
  extension: {
    scene: { x: 184, z: 82, width: 32, depth: 27, height: 54 },
    scope: "browser target orbit",
    runtime: "Manifest V3 extension service worker and offscreen helpers",
    owner: "One browser profile projected as a Unix-shaped target with tabs, pages, network artifacts, and commands",
    persistence: "IndexedDB-backed /home/browser and /tmp plus extension connection and capture state.",
    admission: "The extension connects as a target provider and may receive only routed syscalls it advertises and is granted.",
    completion: "The service worker owns reconnect, request cancellation, Chrome API work, capture streams, and teardown.",
    security: [
      "The extension is a target provider, not the Web UI or a messaging adapter.",
      "Its implements list says what it can execute, not who may call it.",
      "Browser-profile power remains visible and separately authorized.",
    ],
    docs: ["docs/architecture/targets.md", "docs/architecture/unified-protocol-peers.md"],
    tests: ["extension/src/background/connection-supervisor.test.ts", "extension/src/target/shell.test.ts"],
  },
  ripgit: {
    scene: { x: 89, z: 122, width: 38, depth: 32, height: 76 },
    scope: "installation storage enclave",
    runtime: "Rust Worker and Repository Durable Objects",
    owner: "Git smart HTTP, objects, refs, pack handling, diffs, search, and atomic repository operations",
    persistence: "Installation-scoped repository SQLite/object data with real Git commits, trees, blobs, refs, and schema migrations.",
    admission: "The Gateway authenticates callers, overwrites installation scope, and addresses the correct Repository owner.",
    completion: "Repository operations own pack/object processing and atomic tree updates through a committed response.",
    security: [
      "Repository slugs are installation-local; physical addresses include installation scope.",
      "Public Git paths never choose the backing installation identity.",
      "The supported standalone object-name projection remains explicit.",
    ],
    docs: ["docs/reference/r2-storage.md", "docs/architecture/context-and-knowledge.md"],
    tests: ["ripgit/tests/installation-isolation.spec.mjs", "gateway/src/installation/ripgit.test.ts"],
  },
  deployment: {
    scene: { x: 67, z: -221, width: 37, depth: 27, height: 54 },
    scope: "build and provisioning plane",
    runtime: "Node.js release scripts and the checked-in standalone Alchemy deployment program",
    owner: "Artifact catalogs, compatibility manifests, standalone Worker resources, routes, and service-binding assembly",
    persistence: "Checked-in runtime and adapter manifests plus generated, checksummed release bundle metadata.",
    admission: "Operator credentials and validated catalogs authorize provisioning; deploy inputs never become end-user runtime grants.",
    completion: "A deployment completes only after each separately owned artifact is built, bound, and recorded coherently.",
    security: [
      "Provisioning chooses bindings; runtime components still authenticate and authorize every admitted operation.",
      "Adapter identity and attenuated grants come from deployment-owned binding properties, not frames.",
      "Reusable managed-binding primitives exist here, while the operator's managed composition remains external.",
    ],
    docs: ["docs/how-to/deploy-with-alchemy.md", "docs/reference/cli-commands.md"],
    tests: ["deployment/test/manifest.test.ts", "scripts/check-managed-deployment.sh"],
  },
};

export const ATLAS_TOUR_NOTES = {
  "human-turn": {
    thesis: "A conversation and a Process are coupled by explicit commits, never collapsed into one chat record.",
    warning: "Connection routes can receive transient message deltas; adapters receive activity state and committed Messages, not raw deltas.",
  },
  "target-syscall": {
    thesis: "One syscall contract can run in several capability environments without changing its meaning.",
    warning: "A peer's transport and implements list do not authorize a caller or make the peer itself a target.",
  },
  "adapter-ingress": {
    thesis: "Adapters translate and durably deliver provider interactions while the Kernel retains identity and routing authority.",
    warning: "Never draw provider ingress directly into a Process or expose private Process activity to an adapter.",
  },
  "managed-routing": {
    thesis: "No trusted installation route means no world: identity is resolved before a Kernel is addressed.",
    warning: "Handles and origins are routing metadata; installationId is the immutable security identity.",
  },
  "versioned-files": {
    thesis: "GsvFs hides the split between virtual state, ordinary R2 bytes, and selected ripgit-backed trees; repo.* is a separate direct Kernel branch.",
    warning: "/workspaces is ordinary R2 today, and repo.* must not be described as passing through the fs.* mount router.",
  },
  "native-client": {
    thesis: "CLI, Desktop, gsvd, and helpers are separate processes with narrow contracts and independent lifecycle owners.",
    warning: "Do not model the Desktop as a shell around gsvd or helpers as alternate Gateway paths.",
  },
  "deployment-assembly": {
    thesis: "The checked-in standalone composition turns cataloged artifacts into independently owned Workers with explicit bindings.",
    warning: "Provisioning topology is not runtime authority, and a Gateway deploy does not silently update host or extension software.",
  },
};

export function atlasDetail(id) {
  const detail = ATLAS_SYSTEM_DETAIL[id];
  if (!detail) {
    throw new Error(`Missing atlas detail for subsystem: ${id}`);
  }
  return detail;
}
