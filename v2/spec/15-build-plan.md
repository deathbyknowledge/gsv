# 15 · Build plan

The spike is the whole decided design, not a slice: it runs locally under
`gsv dev` on workerd and deploys as a new Cloudflare deployment the founder
tests `[D 11-12]`. This file sets the repository layout, the order of
construction, what each milestone proves, the latency budgets in one place,
the test plan, and what the test deployment needs.

## Repository layout `[NEW]`

```text
v2/
  spec/                 this specification
  runtime/              the space runtime: one Worker exporting every DO class and the edge
    src/edge/           host routing, token check, upload route, SSE and hook forwarding
    src/directory/      Directory DO
    src/space/          Space DO: people, teams, grants, sign-in, mount table, lifecycle
    src/owner/          owner DO: event log, due work, processes, rules, ledger, deliveries, connections
    src/process/        Process DO: loop on Lifecycle, records, epochs, renderers, compaction
    src/gate/           authorization map, rules projection, tickets, ledger outbox
    src/volume/         Volume DO: rows, index, change feed, bin, small-file cache
    src/target/         Target DO: machine protocol, sessions, TTYs, screens, transfers
    src/shell/          the gsv shell as a Dynamic Worker
    src/codemode/       CodeMode loader and the typed .d.ts
    src/blob/           BlobStore with R2 and S3 backends
    content/            runtime context.d, tasks, skills
    test/
  catalog/              zod catalog, codegen (SDK methods, JSON Schema, Rust types, .d.ts, docs)
  sdk/                  the client SDK (socket, gate stub, Workers RPC transports)
  inference/            the Inference Worker, built on 1.0's packages/inference provider code
  ship/                 profile.ts, agents/, skills/, manual/, responsibilities/, web/
  config/               gsv.config.ts for local and for the test deployment
  tools/                gsv dev, gsv deploy, the config compiler
```

What 2.0 reuses from 1.0, to confirm `[NEW]`:

- `packages/inference` provider integration (pi-ai) inside the new Inference
  Worker.
- gsvd (`host/apps/machine`) evolved in place for the 2.0 machine protocol:
  keys, the new URL, the signed hello, PTYs. Desktop and the CLI get the
  device-code login and machine-bound keys.
- Web components from `web/` where they fit; the Ship web UI's data layer is new
  and talks only through the 2.0 SDK.
- The 1.0 invariant tests and golden provider-context snapshots, ported.

## Milestones

Each milestone ends with its tests passing under `gsv dev` and a deploy to the
test deployment `[NEW]`.

| # | Milestone | Proves |
| --- | --- | --- |
| M0 | Skeleton: layout, `gsv.config.ts` compiling to wrangler and workerd configs, `gsv dev` booting every DO class, BlobStore on R2 and MinIO, catalog codegen, SDK socket transport, CI | One build runs in both places; the setup link works |
| M1 | Identity: directory, Space DO, email code, passkeys, Google, session tokens, owner socket connect and resume, grants, rules, tickets, members team, agent accounts | A person signs in on both environments; tickets and revocation hold |
| M2 | Volumes: rows, small-file cache, change feed, bin, indexed folders, uploads, Range downloads, Public links | Files work end to end from the web UI and the SDK |
| M3 | Owner event log: append gate, subscribers, due work, retries, sealing, ledger, Activity | Events survive crash injection at every step |
| M4 | Process: Lifecycle loop, records, epochs, renderers, Inference Worker, CodeMode/Send/Edit/Write, gate, approvals, abort/reset/kill, compaction, SSE output, safety limits | Ported invariant tests and golden snapshots pass; a run survives resets |
| M5 | Conversations and the Ship profile: chat folders, delivery choice, reconcile, onboarding, memory review, Crew delegation and IPC, Ship web UI chat | Sign up, meet the Ship, it works with files and delegates to Crew |
| M6 | Targets: Target DO, gsvd on the 2.0 protocol, commands and long sessions, transfers, TTYs with xterm.js, screens through Desktop, the extension | A laptop enrolls; the Ship runs commands and TTYs on it |
| M7 | Channels: own Telegram bot, the operator's messenger adapters, pairing, contacts between owners, mail M1–M6 | Messages to and from Telegram, a contact and mail |
| M8 | Inference policy and quotas: stacks, own keys, meters, slices, pause on exhaustion, Usage screen | Limits hold under concurrency; usage is visible |
| M9 | Data lifecycle: deletion, retention jobs, export, import, restricted spaces | An export imports into a fresh deployment; erasure is complete |
| M10 | Observability and debugging: OTLP export, metrics, run inspector, live watch, replay, debug bundles, fake model in `gsv dev` | A run is inspectable and replayable from its trace id |
| M11 | Platform hardening: N-1/N skew tests, kill-at-every-step during updates, gradual rollout, self-host guide | Two versions run together; updates lose nothing |
| M12 | Cloud computers and browsers (C1–C3) | A cloud computer starts as a target with a lease |

M5 is the first point the founder can use the Ship on the test deployment.

## Latency budgets

Collected from the topic files; all `[NEW]` and all become alerts (see
[14](14-observability-and-debugging.md)).

| Path | p50 | p99 |
| --- | --- | --- |
| Connect with resume | 120 ms | 400 ms |
| Trivial request → response, warm socket | 25 ms | 100 ms |
| Person sends → message committed and acked | 30 ms | 120 ms |
| Append → run started (generation request sent) | 40 ms | 150 ms |
| Wake → generation request (warm Process) | 15 ms | 60 ms |
| Process → Inference Worker → provider request sent | 15 ms | 60 ms |
| Gate check with a cached ticket | 1 ms | 5 ms |
| Ticket miss | 30 ms | 120 ms |
| Tool result → next generation request | 10 ms | 40 ms |
| Agent reply committed → visible on the chosen client | 40 ms | 150 ms |
| Short machine command overhead | 60 ms | 250 ms |
| Small Volume write / read inside the DO | 5 / 2 ms | 25 / 10 ms |
| Search over 4,000 pages | 2 ms | 15 ms |

1.0 references measured after PR #664: echo 81 ms, connect 142 ms, pre-model
264 ms, warm chat send-to-run 116–128 ms.

## Measurements the spike owes

Named in the decisions as things to measure, not assume `[D 11-09]`
`[D 11-10]` `[D 11-11]`:

- DO-to-DO latency in production (about 30 ms per hop on 1.0's preview).
- Inference Worker reattach after a caller restart.
- Ticket verification cost.
- Append-to-run latency against 1.0's warm chat median.
- Alarms and CPU per message.
- Owner-DO relay against a direct ticketed fetch for small reads.
- File operations from the gsv shell Worker, each a trip to a Volume DO.
- workerd tail-Worker support for telemetry export.

## Test plan

| Layer | What | Where |
| --- | --- | --- |
| Unit | Authorization map, renderers, key templates, catalog schemas, retry policy | Node, fast |
| DO | Each DO class against its invariants | workerd test pool |
| Multi-DO | Flows across classes: sign-in, message to reply, team machine with two approvals, transfers | workerd test pool |
| Fault injection | Kill-at-every-step for runs, appends, deliveries, uploads, erasure, reconcile; SDK socket faults | workerd test pool with Lifecycle reset hooks |
| Property | Child grants never exceed the parent's; feed resume; quota overshoot bound | Node |
| Ported 1.0 | No shell replay; stale runs can't mutate; one body owner; approvals follow the destination; provider history validity; queued input; pending-call consistency; killed pid terminal; compaction fences; golden provider context | DO and multi-DO |
| Skew | N-1 and N for every DO class, both directions | CI |
| End to end | Browser smoke against `gsv dev` and against the test deployment: signup, chat, files, a machine, Telegram, mail | Playwright |
| Scenarios | The Ship benchmark on 2.0, one validated run before any paid matrix | bench harness |

A local Gateway-style unit plus integration pass is enough to merge a
milestone; the deployed smoke runs after each deploy.

## The test deployment

What the founder needs to provide `[NEW]`:

1. A Cloudflare account (or the existing one) and a fresh zone for the test
   deployment, with wildcard DNS (`*.<domain>`) on the Workers Paid plan.
2. An R2 bucket in that account.
3. Model provider keys for the included model, for the Inference Worker.
4. A Google OAuth client with the deployment's callback URL, for Google
   sign-in (passkeys and email code work without it).
5. Mail: Email Routing and Sending on the test zone, or `mail: "none"` at
   first.
6. A Telegram bot token for testing own-bot messaging.

`gsv deploy` prints the one-time setup link for the first space.
