# Generic Gateway Service Forwarding Refactor

## Why this exists

Gateway currently has per-method hand-written routing logic (`rpc-handlers/*`) and ad-hoc pending maps (`pendingToolCalls`, `pendingLogCalls`, etc.). As async req/res patterns grow (e.g. native window rendering), this creates duplicated control flow:

- Method-by-method connection/routing validation
- Method-specific correlation maps
- Method-specific alarm re-arm logic
- Method-specific timeout/cleanup behavior

The result is hard-to-compose behavior when adding new async methods.

This refactor keeps wire compatibility while reducing duplication via:

1. explicit service boundary mapping (frame -> service call), and
2. generic async correlation primitives + scheduler participation.

---

## Target shape (post-refactor)

### 1) Service-forwarding handlers

For each protocol method, define one handler descriptor with:

- Method metadata from `protocol/methods.ts`
- Allowed origin role (`client` / `node` / `channel` / `internal`)
- Input adapter (`RequestFrame` -> service input DTO)
- Destination service call (`Gateway`, `Session`, `Node socket`, `Channel`)
- Output mapper (`service result -> protocol response`)
- Error policy (e.g., map service-level not-found/timeout/errors to frame errors)

This allows the core frame dispatcher to be mostly declarative:
- parse + authenticate mode/connection preconditions
- invoke descriptor
- return result or convert to deferred/error handling

### 2) Generic async operation registry

Replace method-specific pending maps with a shared registry for async operations:

- `kind` (e.g. `tool`, `log`, `asyncExecDelivery`, `nodeProbe`)
- `origin` (client/session/node)
- `target` (session key / client frame / node id / channel)
- `state` (created/acked/failed), `deadlineMs`, `attempts`, `retryPolicy`

Keep thin compatibility shims while migrating:
- `pendingToolCalls`/`pendingLogCalls` keep using legacy wrappers initially
- New flows can adopt `pendingOps` first

### 3) Generic alarm participant model

Convert gateway alarm work into participants:

- participant = `{ name, nextDueAtMs(gw), run(gw, now) }`
- `scheduleGatewayAlarm()` gathers all `nextDueAtMs`, sets the minimum
- `alarm()` iterates participants and runs due handlers

Current participants: heartbeat, cron, skill probe timeout/gc, async exec session expiry/delivery/gc.

This makes new timed workflows (e.g. render polling, window close waits, async window events) additive rather than invasive.

---

## Proposed rollout (batched, A/B-testable)

### Batch 1: Documentation + stable abstractions
- Add ADR-style doc (this file)
- Add `GatewayServiceDescriptor` types and `invoke` wrapper helper
- Keep existing behavior unchanged by wrapping current handlers
- Add unit tests for descriptor validation and wrapper error behavior

### Batch 2: Generic dispatch and tracing
- Replace current direct `getMethodHandler` usage with descriptor-driven dispatch
- Add per-method metadata (`allowedModes`, `needsConnected`, `deferrable`, `category`)
- Keep existing `rpc-handlers` bodies untouched
- Behavior should remain identical

### Batch 3: Async correlation abstraction
- Introduce `pendingOps` store
- Port `tool.invoke/tool.result` flow first
- Leave `pendingToolCalls` in place as compatibility mapping
- Add one-to-one parity tests (existing tool workflows) and compare old/new flows in staging

### Batch 4: Logs flow migration
- Port `logs.get/logs.result` into shared pending operation path
- Keep timeout cleanup semantics same as existing
- Keep `resolveInternalNodeLogResult` compatibility for internal calls

### Batch 5: Scheduler participants
- Introduce participant registry for `alarm()` tasks
- Keep current helpers (heartbeat/cron/probes/async-exec) unchanged but invoked through participants
- Verify alarm schedule logging stays equivalent

### Batch 6+: New async protocol features
- Add window/open/render methods by defining:
  - request handler descriptor
  - async operation registration
  - completion/resolution handler
  - participant for polling/retry/expiry if needed

---

## Invariants to preserve

- WS frame shape remains unchanged (protocol v1 compatibility)
- `chat.send` still:
  - parses commands/directives
  - updates session registry
  - returns queued/start statuses for the client immediately
- Session loop semantics unchanged
- Gateway remains singleton and authoritative
- Existing behavior for node disconnect during in-flight requests unchanged

---

## A/B test plan

- Gate by branch/instance:
  - **control**: current behavior
  - **candidate**: feature-flagged descriptor route + migrated `tool`/`log`
- Capture:
  - tool+log async completion success rate
  - deferred request latency p50/p95
  - alarm wakeups/min and schedule churn
  - timeout/cleanup behavior under node disconnect

- Acceptance criteria:
  - identical response/error envelopes for all migrated methods
  - no new pending-operation leaks under repeated connect/disconnect
  - no alarm churn regressions

---

## Risks / open questions

- Keeping compatibility with internal caller calls (`tool.result`, `logs.result` from node) while moving to service descriptors
- How much to include in one shared `PendingOperation` schema before we lose method-specific clarity
- How to expose per-method observability without reintroducing per-method branches
