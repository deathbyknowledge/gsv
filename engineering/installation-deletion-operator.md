# Operator evidence for installation deletion

Application cleanup and external-copy cleanup are separate acknowledgements.
`operator-resources` is the public Accounts owner for operator-controlled scopes
that the application owners cannot inspect themselves. It does not fetch provider
APIs or hold their credentials. All provider access stays in the operator's tools.

The deployment supplies `OPERATOR_DELETION_CATALOG`, including current and
historical resources. Each entry has an immutable `id`, physical `namespace`,
`kind`, `source`, `scope` (`installation` or `deployment`), and `disposition`
(`live` or `retained`). Multipart uploads and queue/DLQ payloads must be `live`.
No resource is completed by configuration alone. Unknown retained-copy expiry is
reported as `null` and does not become known merely because time passes.

Public helpers are exported from
`@humansandmachines/gsv-installations/operator-resource-contracts`:

- `operatorResourceCatalogSchema` validates the deployment-owned catalog.
- `OPERATOR_RESOURCE_OWNER` is `operator-resources`.
- `operatorResourceManifestResources(catalog, installationId)` builds the exact
  non-DO manifest entries for this owner.
- `operatorResourceSelector(resource, installationId)` specifies the capture
  selector: the installation ID, its R2 prefix, or `*` for a whole shared scope.
- `operatorResourceDigest(capture)` computes the canonical capture hash.
- `operatorResourceAttestationSchema` validates `{ capture, sha256 }`.

`DELETION_RESOURCE_SCOPES` must include these scopes under `operator-resources`.
When the catalog is configured, the standard Accounts verifier can validate this
inventory without a separate `DELETION_ADDITIONAL_EVIDENCE` service. This verifies
scope coverage; it does not assert that any external scope has been erased.
The configured catalog is frozen when the owner joins a deletion operation.
Changing it during that operation stops further progress for explicit review.

The fresh public composition checks known sinks against this explicit catalog:
Worker logs use their actual Worker names; native inference uses provider
`workers-ai` and AI Gateway `default`; another default inference provider uses
its configured provider ID, or its exact custom base URL. Supplied adapters
also require their Worker log scopes. These checks do not discover historical
resources or dynamically selected BYOK providers. The operator must include
those resources in the declaration; current bindings alone do not establish a
complete inventory. Leave the catalog unset, and deletion fails closed, until
that declaration is available. Adopted directory, inference and Mail services
require explicit owner composition through `GsvDeletionResourceBindings`.

## Recording evidence

Use the existing operator authentication and mutation Origin header:

```
GET  /admin/api/installations/{id}/deletion/operator-resources
POST /admin/api/installations/{id}/deletion/operator-resources
```

Ordinary installation ownership does not authorize these endpoints. Every write
passes the same operator authentication and Origin checks as reset/deletion.
Inspection and deletion progress explicitly identify this evidence as
`operator-attested`. Accounts checks its scope, sequence, hash and freshness; the
operator is responsible for faithfully capturing the external provider's facts.
This is not independent Cloudflare or provider verification.

A capture contains `version: 1`, `installationId`, `operationId`, the catalog
`resourceId`, exact `namespace` and `source`, the derived `selector`,
`capturedAt`, a safe local artifact `reference`, and typed `facts`. Submit it with
the digest from `operatorResourceDigest`. Only facts, counters, pagination
cursors, identifiers and hashes enter Accounts. Do not include credentials,
provider response bodies, messages, filenames or other user content. References
are local artifact identifiers, not credential-bearing URLs.

Evidence must follow the application owners' live-erasure receipts. A capture
before that boundary could miss a final write and is rejected. The reference
owner accepts two fact shapes:

- `enumeration`: a bounded sequence of pages containing `requestedCursor`,
  `nextCursor`, `itemCount`, and `responseSha256`. The first requested cursor is
  `null`, subsequent cursors must form one chain, and an explicit terminal
  `nextCursor: null` is required for clearance. **Every page must be empty.** A
  nonempty page followed by an empty terminal page is still pending. Perform a
  fresh empty capture after deletion; a delete request acknowledgement is not
  an empty-store proof.
- `retention-policy`: `enforced`, nullable `retentionMs`, and `policySha256`.
  This is allowed only for retained copies. Unenforced or unknown policy leaves
  expiry unknown. For an enforced, concrete policy, Accounts conservatively
  starts the retention interval when the attestation is recorded. Replays do
  not extend it. The operator must maintain that attested enforcement and record
  changed policy facts before relying on its expiry. Queue/multipart retention
  metadata cannot clear their live payloads.

Application owners erase independently while this owner remains unfinished.
Accounts retains directory identity until all live scopes acknowledge cleanup.
Final erasure remains blocked by any live scope or retained copy. Evidence
records are removed in bounded batches after completion; a minimal operation
tombstone remains to reject replay. Restart and repeated lifecycle calls resume
the same operation without losing completion proof midway through that cleanup.

The local multi-Worker acceptance gate proves application isolation and erasure.
It does not satisfy the separate fresh-Cloudflare-account, external provider,
telemetry, multipart, queue or backup-retention gates.

## Capture tagged AI Gateway records

Run `scripts/capture-ai-gateway-logs.ts` from the public checkout using Node 24,
as in the deployment checks. The command only lists log metadata. It never fetches log request or
response payload endpoints, deletes logs, or submits an Accounts attestation.
Supply an existing operator API token through `CF_API_TOKEN` or
`CLOUDFLARE_API_TOKEN`; do not put the token in configuration, arguments or files.
The [list endpoint](https://developers.cloudflare.com/api/resources/ai_gateway/subresources/logs/methods/list/)
requires AI Gateway Read or Write permission.

Create an operator scope file using the immutable installation ID from the
authenticated deletion/reset response or the private test fixture. Do not
derive identity from a hostname, handle, log content, or user-supplied tag.
Copy the exact resource entry from the operator's declared catalog. For example:

```json
{
  "version": 1,
  "accountId": "00000000000000000000000000000000",
  "gatewayId": "default",
  "installationId": "immutable-id-from-operator-state",
  "resourceId": "ai-gateway-logs",
  "catalog": [{
    "id": "ai-gateway-logs",
    "kind": "provider",
    "namespace": "default",
    "source": "ai-gateway",
    "scope": "installation",
    "disposition": "retained"
  }]
}
```

This example selects one existing resource for observation; it does not declare
the deployment's complete current/historical catalog. Use a new private output
directory for every capture:

```bash
node scripts/capture-ai-gateway-logs.ts \
  --config /private/operator-ai-gateway-scope.json \
  --output /private/ai-gateway-capture-001
```

The helper fixes the Cloudflare origin and GET collection endpoint, refuses
redirects, and filters by `metadata.key = gsv.installation_id` and
`metadata.value = <installationId>`. It checks every row's actual
`gsv.installation_id` value, because matching independent metadata filters alone
does not prove that key/value pair belongs together. It validates page numbers,
counts, stable totals and unique log IDs. A missing page, inconsistent total or
capture beyond 64 pages of 50 records fails without a completed report; start a
fresh capture after resolving the cause. Do not split a larger result set and
present one part as complete.

Output directories use 0700 and artifacts 0600. Page artifacts retain only exact
log IDs, creation times, the verified installation identity, pagination and
capture time. Arbitrary metadata, credentials and user content are discarded.
`ai-gateway-capture-report.json` contains the same `enumeration` fact shape the
operator evidence contract accepts. Each `responseSha256` hashes its sanitized
page artifact, not a raw provider response. The report separates this query
projection from the catalog resource and always has `submission: null`.

**An empty tagged query does not prove the resource empty.** Historical
untagged logs, delayed indexing and upstream-provider copies remain unknown.
The report is deliberately not an upload-ready attestation; do not extract its
empty facts and submit them as full-scope evidence. Full-scope clearance still
requires independent coverage of those gaps and a capture after application
owners finish their final writes. Verified IDs can support a separately
authorized, exact-record cleanup and a new observation afterward. H&M shares
gateway `default` between staging and production; never clear it globally.

## Narrow queue and multipart observations

For each configured queue and dead-letter queue, capture its exact physical
ID, current settings and enforcement history using operator read access.
[Queue metrics](https://developers.cloudflare.com/api/resources/queues/methods/get_metrics/)
are explicitly approximate. A zero backlog is not a full empty enumeration.
The [peek API](https://developers.cloudflare.com/api/typescript/resources/queues/subresources/messages/methods/peek)
and message preview return body-bearing batches without continuation; they do
not supply a complete metadata-only inventory. Do not remove consumers, pull,
acknowledge or purge messages from a live shared queue to manufacture proof.
The last possible enqueue time plus enforced TTL can support an expiry
argument, but it must account for retries and later forwarding into the DLQ.
The current live-resource contract does not accept retention metadata alone
for queues. Keep this scope pending until an appropriate proof is supported.

For unfinished R2 uploads, use existing operator S3 credentials and
[ListMultipartUploads](https://developers.cloudflare.com/r2/api/s3/api/)
with the exact `installations/<encoded-immutable-id>/` prefix. Follow both
`key-marker` and `upload-id-marker` until `IsTruncated` is false; retain page
counts, marker continuity and hashes of a sanitized identifier projection.
Object keys can contain private filenames: keep them in memory and retain a
hash where a raw key is unnecessary. Do not fetch object bodies or list parts.
A prefix observation covers only that prefix; historical unscoped uploads
require their own ownership inventory. A default lifecycle setting or a
successful abort request is not completion evidence. After separately
authorized scoped cleanup, a fresh complete empty enumeration must follow the
last possible upload write. No multipart or queue clearance receipt is
generated by the AI Gateway helper.
