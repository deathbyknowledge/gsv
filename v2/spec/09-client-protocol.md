# 09 · Client protocol and SDK

One envelope, one catalog, one error channel and one SDK for every caller
`[D 11-11]`.

## Transport by shape

Tickets are independent of transport. What ends soon and flows one way goes over
HTTP; what stays open or flows both ways is a WebSocket `[D 11-11]`.

| Use | Transport |
| --- | --- |
| Control: calls, events, hints | WebSocket to the owner DO; hibernates; pings auto-answered every 30 s |
| A run's live output | SSE from the Process DO with `Last-Event-ID` and a ticket in a header (fetch reader, not `EventSource`) |
| File bytes | HTTP Range GETs and 32 MiB part PUTs with a ticket |
| TTYs, screens, long session output | WebSocket to the Target DO with a ticket |
| Between our own Workers | Typed Workers RPC; no frames over service bindings |

JSON on the wire everywhere; bytes travel raw `[D 11-11]`. No binary IDL; JSON
Schema is the neutral export `[D 11-11]`. One-shot HTTP calls are not part of
2.0 until a real caller needs them `[D 11-11]`.

## Frames

1.0's three frame kinds, on every socket, protocol 5 `[D 11-11]`:

```ts
type Req = { t: "req"; id: OpId; op: CatalogName; args: unknown; traceparent?: string };
type Res =
  | { t: "res"; id: OpId; ok: true; result: unknown }
  | { t: "res"; id: OpId; ok: false; error: GsvError };
type Sig =
  | { t: "sig"; feed: Feed; seq: number; event: Event }   // an event: stored, replayable
  | { t: "sig"; feed: Feed; head: string };               // a hint: ephemeral, no data
```

- A `sig` with `seq` is an event; without, a hint. Hints are only
  `{feed, head}` and the client's own activity `[D 11-11]`.
- The owner socket carries at most 64 KiB of file bytes in one frame; larger
  content is a ticket URL `[D 11-11]`. Binary body frames exist only on target
  sockets.
- Feed names `[NEW]`: `events`, `ledger`, `fs:<volume>:<folder>`, `proc:<pid>`,
  `debug:<object>`.

## Connect and resume

```ts
// The first request on a control socket. [D 11-11] for the content, names [NEW].
type Connect = {
  op: "connect";
  args: {
    protocol: 5;
    client: { name: string; version: string; platform: string };
    since?: { events?: number; ledger?: number };
    watches?: Feed[];
  };
};
type ConnectResult = {
  owner: OwnerId; person: OwnerId;
  resumed: true | "reset";
  minVersion: Record<string, string>;      // per client name
  deprecations: { op: string; until: string }[];
};
```

- Replay comes from the hot window or the result says `reset` and the client
  refetches. The SDK re-declares its watches. Process records resume from
  `(generation, rev)` `[D 11-11]`.
- In-flight effectful calls are re-sent with the same op id; outcomes are kept
  by op id for 1 hour and a repeat gets the stored outcome or `outcome_unknown`
  `[D 11-11]`.

## Watching

- Long-lived watches ride the hibernating owner socket; short-lived ones are
  SSE from the producer; everything else is pulled `[D 11-11]`.
- Process and Volume DOs report coalesced heads to their owner DO, which hints
  only the sockets watching that feed `[D 11-11]`.
- A client opens one socket per owner it shows `[D 11-11]`.
- Debug watches on any DO the person can read use the same frames
  (see [14](14-observability-and-debugging.md)) `[D 11-12]`.

## Authentication

- The session token travels in `Sec-WebSocket-Protocol`; browsers, the Desktop
  webview and Rust can all set it. Never in a URL `[D 11-11]`.
- Machine-bound logins sign the upgrade `[D 11-11]`.
- The socket closes at token expiry and on revocation; the SDK refreshes and
  reconnects `[D 11-11]`.

## The catalog

One catalog in TypeScript with zod `[D 11-11]`:

```ts
// One entry per operation. Field set [D 11-11]; this exact shape [NEW].
const fsRead = op({
  name: "fs.read",
  kind: "files",                 // or "machine": the target picks
  verb: "read",
  effect: "read",                // read | effect | start (never replayed)
  args: z.object({ target: TargetRef.optional(), path: z.string(), range: Range.optional() }),
  result: z.object({ rev: z.number(), size: z.number(), text: z.string().optional(), url: z.string().optional() }),
  errors: ["not_found", "forbidden", "too_large", "target_offline"],
  timeoutMs: 30_000,
  secretFields: [],
  doc: "Read a file from a folder or a machine.",
});
```

From the catalog the build generates: SDK methods, gate validation at every
entry, JSON Schema, Rust types (typify), the CodeMode `.d.ts`, reference docs,
and the one version constant `[D 11-11]`. The operation list is
[10](10-syscall-catalog.md).

## Errors and retries

```ts
type GsvError = {
  code: ErrorCode;               // closed list
  message: string;               // for people; never parsed
  retryable: boolean;            // set by the server from the catalog, always
  retryAfterMs?: number;
  ref?: string;                  // stored diagnostic reference (the trace id when a run exists)
  details?: Record<string, unknown>;
};
```

- Closed string codes; no `{ok: false}` inside a successful result
  `[D 11-11]`.
- The server always sets `retryable` from the catalog; clients never guess
  from codes or read `message` `[D 11-11]`.
- The SDK owns the one retry loop: jittered backoff, `retryAfterMs`, a per-call
  budget, the same op id `[D 11-11]`.
- Agents' tool calls retry transient errors inside the call deadline; the model
  sees the final error with `retryable` `[D 11-11]`.

Error codes `[NEW]`:

| Code | Retryable | Meaning |
| --- | --- | --- |
| `bad_request` | no | Arguments failed the catalog schema |
| `unauthorized` | no | Missing or expired token; the SDK refreshes |
| `forbidden` | no | No grant, or a rule denied |
| `approval_denied` | no | An approval was answered no |
| `not_found` | no | No such resource |
| `conflict` | no | Base revision or source changed |
| `moved` | yes | The owner moved spaces; re-resolve |
| `target_offline` | no | The machine is offline |
| `outcome_unknown` | no | An effect may or may not have happened |
| `quota_exhausted` | no | Meter and `resetsAt` in details |
| `rate_limited` | yes | With `retryAfterMs` |
| `storage_full` | no | Volume or quota full |
| `too_large` | no | Over a size limit |
| `timeout` | per catalog | The call's deadline passed |
| `cancelled` | no | Cancelled by its owner |
| `unavailable` | yes | A dependency is down |
| `upgrade_required` | no | Client below the minimum version |
| `internal` | no | A bug; `ref` points at the stored diagnostic |

## Versioning

Operations are added, never changed. Unknown fields are ignored. A breaking
change is a new name. Deprecations and their window are listed at connect; old
clients get `upgrade_required` with the minimum version `[D 11-11]`.

## The SDK

One SDK with the same names as CodeMode and three transports: the socket, the
gate stub (CodeMode and scripts), and typed Workers RPC between our Workers
`[D 11-11]`. Reconnect with jitter, pings, tokens, op ids, cursors, tickets and
SSE all live inside it.

```ts
const gsv = await connect({ host: "alice.ship.space", token });
const page = await gsv.fs.read({ path: "~/notes/plan.md" });
for await (const ev of gsv.watch("events")) { /* ... */ }
```

## Invariants

- **PROTO-1** No frame on an owner socket carries more than 64 KiB of file bytes.
- **PROTO-2** Every error has a code from the closed list and a server-set `retryable`.
- **PROTO-3** An effectful call retried with the same op id executes at most once.
- **PROTO-4** Tokens and tickets never appear in URLs.
- **PROTO-5** A client resuming from a cursor gets every event after it, or `reset`.
- **PROTO-6** Every entry point validates arguments against the catalog.
- **PROTO-7** No client code reads `error.message` to decide anything (lint).

## Latency budget `[NEW]`

| Path | p50 | p99 |
| --- | --- | --- |
| Connect with resume | 120 ms | 400 ms |
| Trivial request → response on a warm socket | 25 ms | 100 ms |
| Event appended → `sig` on a watching socket | 10 ms | 50 ms |

1.0 measured 142 ms connect and 81 ms echo after PR #664.

## Tests

- Catalog: every code reachable from some operation is listed in its `errors`; every operation has a schema, timeout and verb.
- Lint: no reads of `error.message` in client code.
- SDK fault injection: dropped sockets, duplicated and reordered frames, retried effects with the same op id.
- Resume from every cursor in the hot window, and past it (`reset`).
- Version skew: an N-1 client against an N runtime and the reverse.
