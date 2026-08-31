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
- the installation identity needed by a deployment-owned consumer to derive a
  pseudonym; and
- a random event id and occurrence time for idempotent export.

Records must never contain prompts, messages, file paths, URLs, tool arguments,
media, credentials, contact or channel identifiers, raw exception text, or
other user content. Invalid records are rejected without affecting user work.
Managed telemetry does not export Process traces or conversation activity.

Operational telemetry and product analytics are separate purposes. A managed
consumer derives unrelated pseudonyms for the two streams with different HMAC
keys. This makes an operational installation series useful for reliability
without giving the backend a shared installation join key for the product-usage
series. Product events are personless: they do not create or update user
profiles.

## Deployment boundary

Producers emit one structured record only when `GSV_TELEMETRY_ENABLED` is set by
their deployment. A Tail Worker or another deployment-owned consumer may accept
those records and export them to a backend. It must validate the shared schema,
verify that the producing Worker is allowed to emit the claimed component, and
discard every surrounding log, request, header, exception, and trace field.
Because the transport record carries an installation ID until the consumer
pseudonymizes it, a telemetry-enabled deployment must not persist producer
console or invocation logs. `GsvRuntime` applies that non-persistent
observability policy when the telemetry seam is enabled unless the deployment
explicitly supplies a different policy.

The managed deployment uses a Tail Worker to translate operational records to
PostHog Logs and product records to PostHog Capture. PostHog knowledge and
credentials stay in that deployment repository. Self-hosters can leave the seam
disabled or attach a consumer for their own backend without changing GSV core.
