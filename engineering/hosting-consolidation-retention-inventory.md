# Hosting consolidation: retained copies

This is the W2b inventory for copies outside the application tables and object
prefixes. It distinguishes a configured retention policy from evidence that a
particular space's copies have actually expired. It is not a deletion receipt.

## Application owners

Gateway owns its Kernel, Processes, Conversations, installation R2 prefix and
repository cleanup. Accounts owns directory and ownership rows. Inference owns
request state and, where attached, commercial policy and detailed usage. Mail
and messenger owners erase their own state and reject late work for the retired
identity. Their live-data receipts remain separate from final erasure.

The current SQLite Durable Object owners retain a content-free retirement
record and report a 30-day backup window plus a one-minute boundary buffer after
their last user-data deletion. Accounts similarly reports its D1 backup window.
An operator must inventory exported backups independently: deleting the live
database or exhausting platform Time Travel does not delete an export.

## Operator-controlled copies

| Store | Owning service and evidence | Current adoption checkpoint |
| --- | --- | --- |
| Historical unfinished R2 uploads | Gateway aborts tracked uploads. Operator inventory must enumerate and abort older untracked uploads, or verify an applicable expiration policy and its completion. | Staging lifecycle read succeeded with no custom rules. Cloudflare documents a default seven-day abort policy. No authenticated S3 multipart inventory/abort proof has been captured. This remains unresolved. |
| Outbound mail queue and dead-letter queue | Mail fences delivery and settlement. The operator declares both queues and their retention; a message forwarded to the dead-letter queue may start another retention interval. | Authenticated staging settings on September 11 show 345,600 seconds for each queue. Payloads contain immutable delivery references, not mail bodies. Queue expiry is not yet represented by a verified per-space owner receipt. |
| Workers logs | Operator records enabled producers, persistence, export destinations, retention and erasure verification. | Staging Gateway, Accounts and Inference report log persistence disabled; their telemetry tail remains enabled. Email and the telemetry Worker report persistent logs enabled. Disabled persistence today does not account for historical logs. |
| Telemetry exports | The telemetry service owns the operational and product pseudonyms derived from the immutable installation ID, plus each destination's deletion/retention proof. | H&M exports allowlisted events to PostHog. The authenticated project metadata read on September 11 reports `event_retention_months: 12` and `events_retention_enforced: false`; it does not establish a Logs retention period. The retained destination records have not yet been verified or purged for the deletion fixture. Pseudonymization does not itself establish erasure. |
| AI Gateway and upstream provider copies | The operator/provider declares request logging, response caching, retention and the evidence for deletion or expiry. | Existing Cloudflare credentials do not grant AI Gateway configuration read access. No verified time-bound policy has been captured. Capacity-based automatic log eviction is not a time-bound retention guarantee. |
| Other caches, exports and previously enabled services | Each remains an explicit owner until its historical data is accounted for. | Absence from today's enabled adapter list or active registry does not prove absence of stored data. |

Cloudflare documents [R2 upload expiration](https://developers.cloudflare.com/r2/objects/upload-objects/),
[queue retention](https://developers.cloudflare.com/queues/platform/limits/),
[Durable Object storage and Time Travel](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
and [AI Gateway logging](https://developers.cloudflare.com/ai-gateway/observability/logging/).
The deployment's actual settings and historical configuration still need to
support each claimed completion time.

## Admission and completion

`DELETION_DISCOVERY_NAMESPACES` is derived from the adopted Worker outputs.
Accounts verifies persisted per-resource observations against that catalog.
`DELETION_RESOURCE_SCOPES` declares the exact non-DO resources for every current
or historical owner. `DELETION_ADDITIONAL_EVIDENCE` verifies the remaining
operator evidence; it cannot be replaced by a caller's completeness assertion.

The complete inventory resolver fails closed when these additional declarations
or proofs are absent. Durable Object discovery alone does not authorize full
erasure. A cleanup operation cannot report `erased` while any owner is missing,
any retained copy has an unknown expiry, or any declared retained copy remains.

The local multi-Worker acceptance fixture deliberately substitutes external
provider/evidence services. It proves application lifecycle isolation; it does
not turn these unresolved real-cloud owners into completed work.
