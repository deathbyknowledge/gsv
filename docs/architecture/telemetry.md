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
- the installation identity needed by a deployment-owned consumer to derive a
  pseudonym; and
- a random event id and occurrence time for idempotent export.

Records must never contain prompts, messages, file paths, URLs, tool arguments,
media, credentials, contact or channel identifiers, raw exception text, or
other user content. Invalid records are rejected without affecting user work.
Managed telemetry does not export Process traces or conversation activity.

Managed inference reports every admitted logical request at its terminal owner
boundary. Failed and abandoned requests include a provider-neutral failure kind
and stage rather than exception text. The provider HTTP status is included when
one was observed; network, timeout, policy, admission, protocol, and settlement
failures remain distinguishable when no response existed. Workload classes let
operators separate interactive, background, delegated IPC, compaction, Kernel,
and mail-intake reliability without exposing a process or request identifier.
Retryable provider attempts that fail before a fallback route takes over are
reported separately, so a recovered outage or rate limit remains observable
without turning the logical request into a failure.

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
discard every surrounding log, request, header, exception, and trace field.
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

The component allowlist includes Gateway, Accounts, Inference, Search and Mail.
Event ownership is validated as well as the producing Worker: a mail producer
cannot emit an inference or activation event. The deployment must wire both the
producer switch and tail consumer; schema support alone does not export anything.

- Gateway: terminal runs, compaction completion and failure stage, delegation,
  committed messages, target/adapter connection and adapter transport outcomes.
- Accounts: activation. This is not a full signup funnel; anonymous invite/email
  steps intentionally do not invent an installation identity or export addresses.
- Inference: logical terminal outcomes, cost/tokens, provider attempt failures,
  workload and failure stage, plus entitlement-refresh health.
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

This pipeline is best effort. It is not a durable event bus, quota counter or
billing ledger. Services persist their own usage before invoking providers and
settle it independently of telemetry availability. Runtime crashes before a
terminal event, exporter outages, and anonymous signup progress require separate
platform monitoring or an explicitly designed additional event contract; they
must not be "fixed" by forwarding raw exceptions or arbitrary logs.
