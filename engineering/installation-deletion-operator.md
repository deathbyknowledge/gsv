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
