# Telemetry

GSV exposes an optional, provider-neutral telemetry seam for deployment
operators. The open-source runtime does not select an analytics vendor and
emits no telemetry unless the deployment explicitly enables and consumes it.

Telemetry records describe committed outcomes at the subsystem that owns the
operation. For example, the Process reports a finished run after its terminal
state is durable, the Kernel reports a Message after the Conversation accepts
it, and managed inference reports a request after its reservation settles.
Callers must not synthesize success events before those boundaries.

## Privacy contract

The public schema in `@humansandmachines/gsv/telemetry` is the complete
allowlist. Each event has a closed property schema; there is no arbitrary
metadata field. Records may contain:

- event names, bounded categories, timings, outcomes, and aggregate counts;
- content-free inference failure categories, lifecycle stages, retryability,
  HTTP status codes, and workload classes;
- bounded, redacted exception names, messages, stacks, immediate causes, provider
  codes and request IDs on supported operational failure events;
- the installation identity needed by a deployment-owned consumer to derive a
  pseudonym; and
- a random event id and occurrence time for idempotent export.

Model-metadata lookups also carry a fresh random lookup id solely to correlate
the Gateway, Inference and Accounts timings for that lookup. It is not a Process,
run, message or inference-generation identifier.

Inference clients similarly create a fresh diagnostic id, independent of durable
request and Process identities. The same id follows Gateway → execution → funded
inference, appears in retained failure details, and joins client outcomes to
managed request and provider-attempt telemetry. It is optional across RPC for
rolling upgrades; invalid diagnostic input never prevents inference.

Records must never contain prompts, conversation messages, tool arguments,
media, credentials, contact or channel identifiers, request/response bodies or
arbitrary SDK error objects. The shared diagnostic extractor selects error fields
and scrubs common credential formats, URL credentials/query values/fragments,
email addresses and user home paths. Message/cause text is limited to 2,048
characters and stacks to 8,192; JSON response messages retain only their selected
error message. The exporter repeats this scrubbing. This is best-effort redaction,
not a guarantee that arbitrary application text is safe: producers must never
put user content into exceptions intended for export. Invalid records are rejected without affecting user work.
Managed telemetry does not export Process traces or conversation activity.

Managed inference reports every admitted logical request at its terminal owner
boundary. Failed and abandoned requests include a provider-neutral failure kind
and stage alongside available redacted exception diagnostics. The provider HTTP status is included when
one was observed; network, timeout, policy, admission, protocol, and settlement
failures remain distinguishable when no response existed. Workload classes let
operators separate interactive, background, delegated IPC, compaction, Kernel,
and mail-intake reliability without exposing a durable process or request identifier.
Retryable provider attempts that fail before a fallback route takes over are
reported separately, so a recovered outage or rate limit remains observable
without turning the logical request into a failure.

`inference.metadata.finished` measures configuration lookup separately from
generation: each participating component emits its own elapsed time and outcome.
Gateway distinguishes cache hits, misses and deadline expiry; Accounts can also
report D1 SQL execution time and automatic retry attempts when provided by D1.
The difference between these timings helps locate waiting between components;
it does not by itself prove a platform fault. No provider/model names or error
text are included. Lookup correlation is optional on the RPC contract so older
clients and services remain compatible during rolling deployments. Missing or
invalid diagnostic context never prevents metadata resolution.

Operational telemetry and product analytics are separate purposes. A managed
consumer derives unrelated pseudonyms for the two streams with different HMAC
keys. This makes an operational installation series useful for reliability
without giving the backend a shared installation join key for the product-usage
series. Product events are personless: they do not create or update user
profiles.

## Deployment boundary

Producers emit one structured record only when `GSV_TELEMETRY_ENABLED` is set by
their deployment. A deployment-owned log consumer may accept those records and
export them to a backend. It must validate the shared schema,
verify that the producing Worker is allowed to emit the claimed component, and
discard surrounding application logs, request bodies, headers and traces.
A consumer may also extract platform failure categories, timings, keyed exception
fingerprints and the same selected, redacted exception fields from invocation
exceptions or platform-provided console Error metadata. Free-form console context
is not exported.
Because the transport record carries an installation ID until the consumer
pseudonymizes it, a telemetry-enabled deployment must not persist producer
console or invocation logs. `GsvRuntime` applies that non-persistent
observability policy when the telemetry seam is enabled unless the deployment
explicitly supplies a different policy.

A deployment can attach a log-forwarding consumer that translates operational
records and product records for its own observability backend. Backend
knowledge and credentials stay in that deployment, not in GSV core. Self-hosters
can leave the seam disabled or attach a consumer for their own backend.

## Coverage and failure boundaries

If an Accounts call fails during setup authorization, activation, or recovery,
Gateway emits `installation.setup.failed` with a diagnostic ID, the stage,
an allowed error type, and duration. The response includes that ID. The latest
cause is retained only in the Kernel's private `managed_setup_failure` KV record, bounded to
8,192 characters for operator inspection; exception text never enters the response or
telemetry.

The component allowlist includes Gateway, Accounts, Inference, Search and Mail.
Event ownership is validated as well as the producing Worker: a mail producer
cannot emit an inference or activation event. The deployment must wire both the
producer switch and tail consumer; schema support alone does not export anything.

`GsvRuntime` attaches an enabled tail consumer to Gateway and ripgit.
`GsvAdapterWorker.tailConsumers` lets operators include adapter platform failures
without granting those adapters ownership of another component's application events.

- Gateway: terminal runs, compaction completion and failure stage, delegation,
  committed messages, target/adapter connection and adapter transport outcomes.
  `delegation.finished` distinguishes `aborted` child runs from `failed` work,
  including when completion delivery is recovered after a Kernel restart.
  Terminal adapter delivery failures report the route/media/adapter stage,
  redacted error detail and available provider codes/status/request ID. The
  adapter owns provider interpretation; diagnostics survive its durable delivery
  receipt and the canonical `adapter.send` result, including ambiguous outcomes.
  A committed Ship reply also carries a closed `platform` class for the surface
  that receives it: `web`, `phone`, `tablet`, `desktop`, `cli`, `telegram`,
  `discord`, `slack`, `background`, or `other`. The Kernel derives it from the
  reply route pinned for that message, so it names the client or messenger the
  reply was delivered to; the reported peer platform string and adapter name
  never leave the Gateway.
- Accounts: activation. This is not a full signup funnel; anonymous invite/email
  steps intentionally do not invent an installation identity or export addresses.
- Inference: logical terminal outcomes, cost/tokens, provider attempt failures,
  workload and failure stage, plus entitlement-refresh health.
- Gateway, Inference and Accounts: correlated model-metadata lookup outcomes and
  timings, including failed lookups before generation admission.
- Gateway and Inference: `inference.client.finished` records service acquisition,
  request dispatch and stream completion, including pre-admission exceptions,
  cancellation, deadlines and failed abort RPCs. Error names and Cloudflare RPC
  flags accompany the selected redacted error fields. Full causes stay in the
  owning Process history, correlated by the diagnostic ID. Returned generation
  errors are recorded as `generation.error`, separately from empty model output.
- Search: admission rejection, cancellation, provider/settlement failure and
  completion, latency, result count and whether the provider confirmed cost.
- Mail: accepted, duplicate and rejected intake; terminal outbound acceptance,
  failure or unknown delivery; deferred processing; entitlement-refresh health.

A provider accepting outgoing mail does not prove recipient delivery. Unknown
outcomes stay unknown. A successful intake does not mean summarization has
completed; mail summary generation also uses Inference's `mail-intake` workload.
Ordinary callback retries do not emit another terminal outbound event.

The managed consumer bounds export batches and HTTP deadlines, and reports
invalid telemetry counts without including the rejected record. Its own export
errors remain in its operator logs. Producer console/invocation logs are not
persisted. Public records remain vendor-neutral; backend credentials and export
translation remain wholly in infrastructure.

The managed consumer also records `runtime.invocation.failed` for failed platform
invocations and uncaught exceptions from configured producer Workers, even when
no application record was emitted. These service-level records contain the
platform outcome, exception type/count, timings, Worker version and a keyed error
fingerprint, plus selected redacted exception details when the platform supplies
them. They contain no installation identity, request data or headers. Pure
cancellation and response-stream disconnects remain informational; accompanying
exceptions, logged errors or HTTP 5xx responses make the invocation an error.
Production log alerts should filter the production environment, GSV services and
error/fatal severity; they must not exclude all `runtime.invocation.failed` events. Export failures retain their HTTP status in the
consumer's own operator logs.

This pipeline is best effort. It is not a durable event bus, quota counter or
billing ledger. Services persist their own usage before invoking providers and
settle it independently of telemetry availability. Exporter outages and anonymous
signup progress still require separate monitoring; forwarding arbitrary logs or
whole exception objects would violate the privacy contract.
