# Gateway installation retirement

`GatewayLifecycleEntrypoint` is an operator service binding with the fixed
`installation-deletion` authority. It requires the trusted directory to identify
the exact installation as `retained` before inspection, inventory import, or
cleanup. It is not a public HTTP route. Accounts owns authorization, the complete
deletion manifest, and coordination with the other storage owners.
Lifecycle receipts also admit `deleting` and `deleted` directory tombstones so
backup expiry can finish after Accounts has removed the live directory record.

## Durable ownership and erasure

Kernel migration 048 retains Process and Conversation addresses even when their
normal registry rows disappear. A successfully removed pid cannot be reused.
New managed repository accesses register the physical repository address in an
installation index before reaching the Repository object. Ordinary repository
deletion preserves this ownership metadata.

Retirement closes ordinary admission and persists an operation-specific fence.
Kernel cancels routed work, Processes run their existing kill cancellation path,
and Conversations drain admitted append/archive work. R2 writes already admitted
must finish before the owner acknowledges quiescence. Later R2 writes, SQL/KV
mutations, alarms, and repository continuations fail at the owning storage
boundary. The fence survives eviction and remains after application data is
erased.

Cleanup visits at most 16 child objects per call. Kernel retains their addresses
until each acknowledges erasure for the exact installation and operation. Ripgit
similarly retains its repository index until every child has acknowledged.
Kernel then deletes R2 objects under only `installations/<installationId>/`, one
page per call, before erasing its own application state. Lost replies and repeated
calls resume the recorded state. A replacement installation has a different ID
and prefix.

The Gateway receipt distinguishes live erasure from retained platform backups.
Cloudflare Durable Object PITR can retain deleted data for up to 30 days; the
receipt conservatively starts that retention period after the final Kernel
erasure and adds a one-minute expiry buffer. Other owners and provider retention
remain separate receipts.

## Historical inventory is a prerequisite

Old Process registry deletion and old ripgit deployments did not preserve a
complete address inventory. A current registry listing cannot establish historical
completeness. Legacy Kernels therefore report `missing-inventory` until an
authenticated operator manifest has been verified and imported.

The deployment evidence validator accepts complete captured Cloudflare namespace
pages, including the actual final empty page, for both a before and after
enumeration. Deployment configuration fixes the expected namespace IDs, classes,
and owners. The object sets and stored-data flags must agree. Trusted owner probes
must identify or establish emptiness for every stored object, and the target
installation's exact physical addresses and names must match the manifest.
An unidentified nonempty object blocks verification even if the current registry
does not mention it. Hashes establish artifact integrity; they do not replace
authenticated provenance or live ownership checks.

Inspection returns ownership metadata and emptiness only. A nameless historical
Process or Conversation is opened without replaying schema migrations or startup
work. Candidate local IDs and installation IDs count only when their computed
namespace address matches the physical object ID. Legacy empty kill tombstones
do not imply ownership of unrelated data.

Accounts sends the entire verified Gateway/ripgit resource list on every import
retry. Kernel persists that exact list and hash with a cursor. Each call validates
and imports at most 16 objects; only the final acknowledged batch seals the
inventory. The import also rejects omission of any already-known child address.
No request-supplied `complete` flag can seal a partial batch.

## Historical R2 multipart uploads

The R2 Workers binding cannot list incomplete multipart uploads. New uploads are
recorded by their owning object and aborted before it acknowledges quiescence,
but this does not cover uploads created before this inventory existed.

Before a historical deletion can be reported complete, the operator must capture
authenticated S3-compatible `ListMultipartUploads` results for the exact bucket
and installation prefix. Evidence must preserve every page, both continuation
markers, the final `IsTruncated=false` result, capture time, bucket identity, and
the exact key/upload-ID pairs. Complete uploads are separately covered by the R2
object-prefix scan. Empty object-list results do not prove absence of unfinished
uploads.

Once all producers are quiesced, abort every discovered upload with its exact key
and upload ID. Retain each abort outcome, reconcile lost replies by re-enumerating,
and capture a complete final enumeration showing no uploads in that prefix.
Never abort a replacement installation's uploads or scan an unscoped singleton
prefix as though it belonged to one managed installation.

This Gateway batch does not implement the operator S3 capture/abort runner or its
manifest evidence validator. That remains an explicit completion gate alongside
the other non-DO owners; DO verification alone must not satisfy it. None of the
local tests or implementation commits constitute a live deletion or an approved
historical inventory.

## Validation

Local Workers fixtures cover two-installation isolation, eviction and retry,
preserved Process tombstones, rejected frame-body cancellation, late SQL/KV/R2
writes, multipart aborts, and an interrupted multi-batch inventory import. Ripgit
fixtures additionally hold a remote import across retirement and verify its late
continuation cannot recreate erased data. Repository erasure fails closed if a
future application table lacks an explicit erasure policy.
