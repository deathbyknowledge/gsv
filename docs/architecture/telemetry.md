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
After a user cancels or supersedes a generation, a retryable RPC failure while
aborting the old executor is recorded with outcome `cancelled`, including its
diagnostics. An unexpected cleanup error or an active generation failure still
records a failure.

Retryable provider attempts that fail before a fallback route takes over are
reported separately, so a recovered outage or rate limit remains observable
without turning the logical request into a failure.

`inference.metadata.finished` measures configuration lookup separately from
generation: each participating component emits its own elapsed time and outcome.
Gateway distinguishes cache hits, misses and deadline expiry, and records a
failed or expired lookup even though the run continues without it; Accounts can also
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
profiles. Product funnel measurements are taken inside the Gateway and Accounts
and exported only as durations, booleans and closed categories; they carry no
Process, run, message or conversation identifier, so a backend can relate them
to each other only through the product pseudonym and time, never to an
operational record.

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
an allowed error type, and duration. When Accounts can't prepare a self-service
signup, it emits the same event at the `activation` stage and keeps the cause in
that signup's provisioning record; the person sees the diagnostic ID as the
reference. A setup step that fails after the request is
accepted, such as a filesystem write while the home is laid out, emits the same event
with the `setup` stage and the step's name. Either way, the response includes the
diagnostic ID. The person can retry a failed step with the same credentials: a step
before the account is written runs again, and once the account exists the retry
provisions the personal agent and machine token again and sign-in lays out the home.
A refused request, such as an invalid username, is answered with its reason and
records nothing. The latest cause is retained only in the Kernel's private
`managed_setup_failure` KV record, bounded to 8,192 characters for operator
inspection; exception text never enters the response or telemetry.

ripgit answers an error that escapes its Worker or a Repository object with
`500` and a JSON body that names the failure kind, a fresh diagnostic ID and the
cause, bounded to 1,024 bytes. It logs the whole cause as an error, and the same
ID on the line after it, so a consumer's error fingerprint groups failures with
the same cause. When telemetry is enabled, it also emits `ripgit.request.failed` with the ID, a closed
route class such as `apply` or `git-upload-pack`, the kind and the duration. The
record never includes the cause, a path or a repository name. Each failure is
reported once, where it happened: the Worker passes on a Repository object's
answer instead of reporting it again. Requests that carry no installation, such
as the operator's deletion and discovery calls, record nothing until they reach
the installation's repository index. The Gateway's ripgit client keeps the
cause, kind and ID in the error it raises, so a setup step that fails in ripgit
leaves all three in `managed_setup_failure`. Anything that leaves the
installation gets only the kind and ID: the public `/git/` proxy answers any
`5xx` with `Repository request failed (<kind> error, reference <id>)`, or
without the parentheses when ripgit did not diagnose it, and deletion errors
add them after the status.

The component allowlist includes Gateway, Accounts, Inference, Search, Mail and
ripgit.
Event ownership is validated as well as the producing Worker: a mail producer
cannot emit an inference or activation event. The deployment must wire both the
producer switch and tail consumer; schema support alone does not export anything.

`GsvRuntime` attaches an enabled tail consumer to Gateway and ripgit, sets
`GSV_TELEMETRY_ENABLED` on both and keeps their logs unpersisted.
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
  `adapter.quote.resolved` reports whether a quoted reply's lookup resolved, was
  unmapped, was unavailable, failed or timed out, with its duration and never its text.
  A committed Ship reply also carries a closed `platform` class for the surface
  that receives it: `web`, `phone`, `tablet`, `desktop`, `cli`, `telegram`,
  `discord`, `slack`, `background`, or `other`. The Kernel derives it from the
  reply route pinned for that message, so it names the client or messenger the
  reply was delivered to; the reported peer platform string and adapter name
  never leave the Gateway.
  The onboarding funnel adds the person's side of the conversation.
  `ship.message.received` reports an owner's own message to Ship when the
  Conversation accepts it, with its source (`client` or `adapter`), the same
  closed platform class, and whether it carried text or media; a direct
  `proc.send` and replayed adapter receipts are not reported. The first message
  a run commits after such a message carries `replyMs`, measured from the moment
  the Process received the message to that commit, so it includes queueing,
  media handling and retries but not the messenger's own delivery to the
  Gateway. `conversation.reply.failed` reports a run a person's message started
  that ended in `error` or `aborted`, in any Ship or Work conversation, with a
  closed failure category (`generation`, `context`, `media`, `no_send`,
  `command`, `delivery`, `runtime`, `superseded`, `cancelled`, `killed` or
  `other`), whether it had already replied, and its duration; the reason and
  cause stay in Process history. `onboarding.welcome.activated` marks the
  transition that opens the welcome responsibility for an owner, and
  `onboarding.welcome.delivered` reports the first Ship message accepted after
  it, once per owner, with the time between them; the Kernel keeps both marks in
  its private `initial-onboarding` record, so an owner whose welcome predates
  the record is never reported. `responsibility.created` reports a record
  entering the owner's ledger through the ordinary create syscall, as `process`
  when Ship or a helper created it and `account` when the person did, with
  whether it has a parent; records the Kernel seeds itself (the welcome,
  release briefs, memory reviews, lifecycle checks, scheduled runs, mail and
  contact intake) never pass that path and are not reported. "First
  responsibility" and "first delegation" are backend computations over those
  events; GSV keeps no one-time marker for either.
- Accounts: activation and attribution. `installation.attributed` is reported
  once when onboarding completes, with `origin: "website"` and a closed
  placement class (`hero`, `final-call`, `example` or `other`) and, for example
  cards, a closed example id, or `origin: "direct"` when there were none. The
  signup page reads the website's slugs from the signup link's fragment in the
  browser and keeps them in its own signup state until the space request; the
  owner API bounds their shape and classifies them into the allowlist before
  they are stored with the reservation, so an unknown slug becomes `other` and
  the raw string never enters storage or a record. Nothing in it is a visitor
  identity. This is not a full signup funnel;
  anonymous invite/email steps intentionally do not invent an installation
  identity or export addresses.
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
- ripgit: unexpected request failures by route class and failure kind, joined to
  the caller's error by diagnostic ID.

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
