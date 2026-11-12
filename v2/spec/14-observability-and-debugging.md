# 14 · Observability and debugging

Two separate surfaces `[D 11-12]`:

- **Telemetry** is content-free: traces, metrics and logs for operators and
  for us, carrying ids, timings, sizes and outcomes only.
- **Debugging** shows content, stays in the owner's DOs, and is visible only to
  people with read on it.

## Telemetry

### Traces

- One trace id per run, carried on every frame and RPC `[D 11-12]`.
- OpenTelemetry with W3C trace context end to end: every event row, due-work
  row, frame and RPC carries `traceparent`. Async hops (append → delivery,
  retries, alarms, machine frames, inference requests, mail sends) start a span
  linked to the producer `[D 11-12]`.
- Our own spans are the source of truth, because Cloudflare's automatic spans
  can't set parents or links and don't exist on workerd. Cloudflare automatic
  tracing may stay on for managed deployments, tagged with our trace id
  `[D 11-12]`.
- The Process DO buffers a run's spans and exports them at run end when the
  run is sampled, failed or slow: tail sampling per run `[D 11-12]`. Sampling
  rate `[NEW]`: 10% of ordinary runs; every failed run; every run slower than
  its budget's p99.
- Spans of the last 32 runs stay in the Process DO for `proc.trace`
  `[D 11-12]`.

### Metrics

Histograms and counters `[D 11-12]`; names `[NEW]`:

| Metric | Type | Labels |
| --- | --- | --- |
| `gsv.append_to_run` | histogram, ms | event family |
| `gsv.queue_wait` | histogram, ms | subscriber kind |
| `gsv.first_token` | histogram, ms | stack purpose, provider |
| `gsv.run.duration` | histogram, ms | trigger family, outcome |
| `gsv.tool.duration` | histogram, ms | catalog op, target kind, outcome |
| `gsv.delivery.attempts` | counter | surface, outcome |
| `gsv.errors` | counter | code, op |
| `gsv.responsibility.first_message` | histogram, ms | responsibility kind |

The latency budgets in this spec become alerting rules on these metrics
`[D 11-12]`.

### Logs

Structured logs carry trace and span ids `[D 11-12]`.

### Export

Through a tail Worker to any OTLP endpoint set in `gsv.config.ts`; none means
local only `[D 11-12]`. The spike checks workerd's tail-Worker support.

### The allowlist

Attributes are enforced by schema: ids, timings, sizes, outcomes. Never
prompts, arguments, file contents or message text. A build check fails if an
allowlisted event has no emitter `[D 11-12]`.

### References for people

Every visible failure shows a reference: the trace id when a run exists, else
the stored diagnostic id. Operators keep a metadata-only view `[D 11-12]`.

## Activity

Activity is the syscall ledger per actor owner (see
[04](04-owner-event-log.md)): 90 days, arguments up to 16 KB, catalog-marked
secret fields never stored `[D 11-12]`.

Who sees it `[D 11-12]`:

- Activity is the owner's data, like files.
- A space admin sees per-owner usage totals, members and machines.
- Reading a person's Activity takes the explicit self-grant, recorded in that
  person's Activity and notified to them.
- Team admins see the team's Activity.
- A call touching another owner's resource writes its row in the actor's owner
  and a copy in the resource's owner, after the call.
- Operators see metadata only.

## Debugging

`[D 11-12]`

### Run inspector

Keyed by the trace id. It joins what is already stored: the trigger event, the
epoch (exact prompt and manifest), records, model calls, tool calls with
arguments and results, gate decisions (grant, the rule that asked, the
approval), deliveries and spans. Each model request is rebuilt exactly from the
epoch, the records and the tool schema hash; the hash of the bytes actually sent
is stored to prove the rebuild, so there is no second copy of 100k-token
requests.

### Live watch and state views

A live debug watch on any DO the person can read (a Process, an owner's log,
deliveries, due work and gate decisions, a Target's frames) through the same
client protocol, plus read-only state views per DO kind: cursors, due work, run
state, pending calls, epochs.

```ts
// Shapes [NEW].
gsv.debug.watch({ object: { process: pid } });            // sig frames on feed debug:<object>
gsv.debug.state({ object: { owner: ownerId }, view: "due_work" });
```

### Replay

Fork a run at any point with a changed prompt, model or profile content. Tools
answer from recorded results and never re-execute. Live tools only by explicit
choice, in a scratch owner.

### `gsv dev`

The runtime on local workerd with the profile hot-reloaded, a recorded or fake
model provider for deterministic runs, the inspector, and scenario runs (the
benchmark harness).

### Debug bundles

One trace exported as a file with secrets removed, shared by an ordinary grant
(for support) and replayable locally.

Permissions: no new verb. Views need `read`; replays spend inference quota.
Operators still see metadata only.

## Invariants

- **OBS-1** No telemetry attribute holds content; the schema rejects unknown attributes.
- **OBS-2** Every async hop has a span linked to its producer.
- **OBS-3** A replay never executes a recorded tool call against the world.
- **OBS-4** A rebuilt model request hashes to the stored hash of what was sent.
- **OBS-5** Debug views and bundles respect `read` on every object they show.

## Tests

- Trace continuity: a message through append, delivery, run, inference, tool, reply and messenger delivery yields one trace with linked async spans.
- Schema: emitting a disallowed attribute fails the test build.
- Rebuild: for recorded runs, the rebuilt request hash equals the stored hash.
- Replay with a changed prompt: no tool call reaches a Target or Volume DO.
- Activity access: an admin without the self-grant can't read a person's Activity; with it, the person is notified.
