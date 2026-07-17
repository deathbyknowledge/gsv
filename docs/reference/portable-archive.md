# GSV Portable Archive v1

GSV Portable Archive is the open interchange format for a logical GSV tenant
snapshot. Version 1 is designed for a client-pulled, encrypted transfer: the
source is quiesced, a client streams the archive without an operator staging
bucket, and restore creates a fresh target that stays unavailable until
verification and explicit activation. Provider resource identifiers are never
portable identities, so another conforming runtime can implement either side.

This document specifies the container and logical value encodings. Public GSV
runtime components expose authenticated, fenced logical snapshot and
journaled-restore primitives for their owned state. A deployment may advertise
export or restore only after its coordinator covers the complete object
inventory and verifies a clean-instance round trip. A syntactically valid
archive is not necessarily a complete or restorable GSV snapshot.

All multibyte integers in the binary container are unsigned and big-endian. All
JSON is UTF-8 [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785)
data. Decoders reject noncanonical JSON instead of normalizing it. Lengths and
counts represented in JSON are canonical unsigned decimal strings (`0` or a
non-zero digit followed by digits), unless a field is explicitly a binary
`u32` or `u64`.

## File structure

An archive has two layers:

```text
outer encrypted container
  GSVPA\0\1\n
  canonical encryption envelope
  authenticated AES-GCM chunks
    inner logical archive
      GSVI\0\1\n
      hash-chained logical frames
      final manifest frame
      GSVT trailer
```

The inner layer detects truncation, reordering, inconsistent inventories, and
logical corruption independently of encryption. The outer layer provides
confidentiality and authenticates chunk boundaries and the envelope. An
importer validates both complete layers before activating restored state.

## Outer encrypted container

The outer stream starts with:

| Field | Size | Meaning |
| --- | ---: | --- |
| magic | 8 bytes | `47 53 56 50 41 00 01 0a` (`GSVPA\0\1\n`) |
| envelope length | `u32` | Canonical envelope byte length, at most 64 KiB by default |
| envelope | variable | Canonical JSON |
| chunks | variable | One or more authenticated chunks; exactly one is final |

The recovery-key envelope has exactly these fields:

```json
{
  "format": "gsv-portable-archive",
  "version": 1,
  "cipher": "AES-256-GCM",
  "chunkPlaintextBytes": 4194304,
  "noncePrefix": "<unpadded base64url of 8 random bytes>",
  "key": {"mode": "recovery-key"}
}
```

The key is 32 random bytes delivered separately to the user and is never stored
in the archive. The same key and nonce prefix must never be reused for another
archive.

The passphrase envelope replaces `key` with:

```json
{
  "mode": "passphrase",
  "kdf": "scrypt",
  "N": 131072,
  "r": 8,
  "p": 1,
  "salt": "<unpadded base64url of 16 random bytes>"
}
```

These scrypt parameters are fixed for v1. Web Crypto does not provide scrypt;
the shared codec validates this metadata and accepts a caller-derived 32-byte
key, but does not derive it. A CLI implementation must use a reviewed scrypt
implementation and erase passphrase and derived-key buffers when practical.

Each encrypted chunk is:

| Field | Size | Meaning |
| --- | ---: | --- |
| plaintext length | `u32` | Bytes before encryption |
| flags | 1 byte | bit 0 is `final`; every other bit is zero |
| ciphertext and tag | plaintext length + 16 | AES-256-GCM result with a 128-bit tag |

The default and maximum plaintext chunk size is 4 MiB. Every non-final chunk is
exactly the envelope's `chunkPlaintextBytes`; the final chunk may be shorter or
empty. Empty input is represented by one empty final chunk.

The chunk counter starts at zero and is encoded as a `u32`. Its 12-byte GCM
nonce is `noncePrefix || counter`. Counter overflow is an error. Additional
authenticated data is the concatenation:

```text
outer magic
SHA-256(canonical envelope bytes)
counter u32
plaintext length u32
flags byte
```

This binds the cipher suite, key mode, chunk size, nonce prefix, chunk position,
length, and final marker. A decoder rejects bad magic, a noncanonical or unknown
envelope, unknown flags, non-full intermediate chunks, failed GCM tags, a
missing final chunk, counter overflow, truncation, and trailing bytes.

## Inner logical stream

The decrypted stream begins with the 7 bytes `47 53 56 49 00 01 0a`
(`GSVI\0\1\n`). It is followed by data frames, one final `manifest` frame, and
the trailer. A frame is:

| Field | Size | Meaning |
| --- | ---: | --- |
| header length | `u32` | Canonical header bytes; 64 KiB maximum by default |
| body length | `u64` | Body bytes; 4 MiB maximum in v1 |
| header | variable | Canonical JSON |
| body | variable | Bytes described by the header |

The header has exactly these fields:

```json
{
  "sequence": "0",
  "kind": "tenant",
  "objectId": "tenant",
  "part": 0,
  "bodyMediaType": "application/json",
  "bodyEncoding": "identity",
  "bodySha256": "<unpadded base64url SHA-256>",
  "previousFrameDigest": "<unpadded base64url SHA-256>"
}
```

`sequence` starts at `0` and increments without gaps. `part` is a `u32` chosen
by the owning logical-object codec. `objectId` is the stable logical inventory
ID, not a Cloudflare Durable Object ID or provider resource ID.
`bodyEncoding` is `identity` in v1. A body is accepted only after its SHA-256
matches `bodySha256`.

The frame digest is:

```text
SHA-256(header length u32 || body length u64 || canonical header || body)
```

The first frame's `previousFrameDigest` is 32 zero bytes. Every later frame
contains the preceding frame digest. The chain makes omitted, reordered, or
spliced frames invalid. Frames delivered to a streaming visitor remain
untrusted until the final manifest and trailer validate; restore code must
spool or journal them instead of exposing partial state.

### Frame kinds

| Kind | Intended logical content |
| --- | --- |
| `tenant` | Tenant-level portable metadata |
| `do.descriptor` | Durable Object role and logical identity |
| `do.sqlite.schema` | Normalized SQLite schema records |
| `do.sqlite.rows` | Tagged SQLite row records |
| `do.sqlite.cell` | An externalized large SQLite TEXT or BLOB part |
| `do.kv` | Versioned Durable Object KV structured-clone records |
| `r2.descriptor` | R2 object key and portable metadata |
| `r2.body` | R2 body part |
| `workers-kv.descriptor` | Workers KV key and portable metadata |
| `workers-kv.value` | Workers KV value part |
| `manifest` | Final full inventory; never a data frame |

Frame kinds reserve stable routing slots. Runtime body schemas are versioned in
their media type and listed in `requiredSchemaFeatures`; an importer fails
closed on a required feature it does not implement.

Every logical object's data frames form exactly one contiguous run in the
global frame stream. Once a different `objectId` begins, an earlier object ID
cannot reappear. The encoder, streaming validator, and inventory accumulator
all enforce this rule, allowing importers to finalize one object at a time
without retaining an unbounded set of partially decoded objects.

The portable-archive package owns the canonical v1 feature-token registry so
TypeScript coordinators and cross-language codecs do not invent spellings:
`gsv-do-logical-snapshot-v1`, `gsv-ripgit-logical-snapshot-v1`,
`gsv-r2-logical-snapshot-v1`, and `gsv-workers-kv-logical-snapshot-v1`.
Exported constants reserve these protocol names; an exporter includes only the
tokens for body codecs it actually emitted, and an importer still rejects any
token whose complete codec it does not implement.

### Ripgit logical snapshot v1

`@humansandmachines/gsv-portable-archive/ripgit` is the public interoperability
boundary for `gsv-ripgit-logical-snapshot-v1`. Ripgit emits one
`do.sqlite.schema` frame with
`application/vnd.gsv.ripgit-snapshot-manifest+json`, followed by zero or more
`do.sqlite.rows` frames with
`application/vnd.gsv.ripgit-snapshot-page+json`. The manifest frame has part
`0`; page parts form one independent sequence starting at `0`.

The manifest body uses format `gsv-ripgit-logical-sql-v1`, carries only the
portable repository identity `{ owner, repo }`, pins the exact ordered v1 table
and column layout, records a non-negative source fence epoch, and declares each
table's row count. Epochs and row counts stay within the JavaScript safe
integer range shared by both implementations. Source Durable Object IDs,
account IDs, and registry IDs are runtime routing state and are forbidden in
this body. Derived search and graph tables are rebuilt after restore, while
package caches are deliberately excluded.

Each page binds the manifest hash, table index and name, current offset, next
offset, and rows. Values use ripgit's exact tagged union (`null`, `boolean`,
`integer`, `float_bits`, `string`, and `blob_base64`); the fixed table layout
accepts only null or its declared `INTEGER`, `TEXT`, or `BLOB` representation.
Integers in stored rows are restricted to JavaScript's lossless integer range,
and blobs use canonical padded standard base64. A complete-stream validator
requires the manifest first, one archive object ID throughout, contiguous page
parts and row ranges, non-empty pages, and exact coverage of every declared
row before it returns the sorted SQLite inventory.

Frame bodies are canonical JSON. The embedded `manifestHash` and `pageHash`
remain compatible with ripgit's Rust structs: they hash compact JSON serialized
in Rust declaration order, which is intentionally different from the sorted
object-key order used by canonical frame bodies. Implementations should use the
public codec rather than reimplementing that transcript detail.

### R2 logical snapshot v1

`@humansandmachines/gsv-portable-archive/r2` is the public interoperability
boundary for `gsv-r2-logical-snapshot-v1`. It exports the canonical descriptor
types and media types, descriptor encoder/decoder, deterministic snapshot
framer, and exact-length restore body stream. The same API is also exported
from the package root.

Each logical R2 object begins with one `r2.descriptor` frame at part `0`, using
`application/vnd.gsv.r2-descriptor.v1+json`. Its canonical JSON body contains:

| Field | Meaning |
| --- | --- |
| `format`, `version`, `record` | `gsv-r2-logical-snapshot`, `1`, and `object` |
| `objectId` | Exact logical inventory identity; must match the frame |
| `key` | Portable object key, never a provider URL or resource ID |
| `size`, `bodyParts` | Canonical decimal strings describing the exact body |
| `storageClass` | `Standard` or `InfrequentAccess` |
| `encryption` | `provider-managed`; external customer key material is never archived |
| `httpMetadata`, `customMetadata` | Normalized metadata that can round-trip exactly |

The descriptor is followed by ordered `r2.body` frames with
`application/octet-stream` bodies. Parts are exactly `MAX_FRAME_BODY_BYTES`
(4 MiB) except for the final remainder. A zero-byte object has one empty body
part. Export framing is independent of source response chunk boundaries, and
both framing and reconstruction own their input streams: completion consumes
the source, while errors and early termination cancel or close it.

The codec deliberately has no managed-service object-size limit and knows
nothing about Cloudflare account IDs, R2 bucket IDs, credentials, REST paths,
ownership fences, or retry policy. A deployment provider must reject source
encryption it cannot recreate, enforce its own product/quota limits, validate
that keys can be represented by its provider API, fence the target before and
after mutation, and convert the validated body stream into the provider write.
Those checks do not change the archive representation.

### Workers KV logical snapshot v1

`@humansandmachines/gsv-portable-archive/workers-kv` is the public,
provider-neutral boundary for `gsv-workers-kv-logical-snapshot-v1`. It exports
the canonical descriptor types and media types, descriptor encoder/decoder,
deterministic snapshot framer, and exact-length restore value stream. The same
API is exported from the package root.

Each logical Workers KV entry begins with one `workers-kv.descriptor` frame at
part `0`, using
`application/vnd.gsv.workers-kv-descriptor.v1+json`. Its canonical JSON body
contains:

| Field | Meaning |
| --- | --- |
| `format`, `version`, `record` | `gsv-workers-kv-logical-snapshot`, `1`, and `entry` |
| `objectId` | Exact logical inventory identity; must match the frame |
| `key` | Portable key, never a provider namespace ID or REST path |
| `valueBytes`, `valueParts` | Canonical decimal strings describing the exact value |
| `expiration` | Absolute Unix seconds as a canonical decimal string, or `null` |
| `metadata` | Canonical JSON metadata, preserving `null` distinctly |

The descriptor is followed by ordered `workers-kv.value` frames with
`application/octet-stream` bodies. Parts are exactly `MAX_FRAME_BODY_BYTES`
(4 MiB) except for the final remainder, and an empty value has one empty part.
Export framing does not depend on provider response chunk boundaries. Snapshot
and restore streams consume their input on success and cancel or close it on
errors and early termination.

The public codec does not encode a provider namespace ID or impose
Cloudflare's key, value, metadata, expiration, write-rate, or account quotas.
A provider integration enforces those limits, checks ownership and immutable
namespace identity before and after mutation, and supplies a fresh value stream
for any retry.

### Trailer

The trailer is exactly 44 bytes:

| Field | Size | Meaning |
| --- | ---: | --- |
| magic | 4 bytes | `GSVT` |
| manifest offset | `u64` | Offset from the start of the inner stream to the manifest frame's header length |
| manifest digest | 32 bytes | SHA-256 of the canonical manifest body |

There is no footer after the trailer. Missing or non-final manifests, a bad
offset or digest, truncated trailers, and trailing data are errors.

## Manifest

The final frame has part `0`, an `objectId` equal to `archiveId`, media type
`application/vnd.gsv.portable-manifest+json`, and a canonical JSON body. Its
top-level fields are:

| Field | Meaning |
| --- | --- |
| `format`, `version` | `gsv-portable-archive`, `1` |
| `archiveId` | Stable ID for this export attempt |
| `createdAt` | Canonical millisecond UTC timestamp |
| `source` | Exact GSV release and `managed` or `self-hosted` deployment kind |
| `consistency` | `quiesced` and the freeze timestamp; equal to `createdAt` in v1 |
| `normalizationPolicyVersion` | `1` |
| `requiredSchemaFeatures` | Sorted, unique required codec/schema features |
| `inventory` | Full logical object inventory sorted by unique `objectId` |
| `totals` | Data-frame/body counts and aggregate R2 object/byte counts |

Every inventory object declares its logical kind, owning component, logical
name, data-frame count, data-body bytes, semantic SHA-256, and storage detail.
SQLite detail includes sorted table names and row counts. Durable Object KV
includes an entry count. An `r2-object` item represents exactly one independently
framed object and therefore has `r2.objectCount: "1"`; multiple items may share
the same bucket logical name but must retain unique `objectId` values. A
`workers-kv-entry` similarly represents exactly one key and has
`workersKv.entryCount: "1"`. The item storage byte count is the logical object
or value length, distinct from `bodyBytes`, which also covers descriptor frame
bodies. Manifest data totals exclude the manifest frame itself and must equal
the observed frames exactly. Every data-frame `objectId` occurs in the
inventory, and every inventory object has at least one descriptor or data
frame.

### Streaming inventory construction

`ArchiveInventoryAccumulator`, also available from the `inventory` package
subpath, is the one-pass exporter companion to `encodeInnerArchiveStream`.
Callers register each logical object with its kind, component, logical name,
and storage detail before streaming. They then await `observe(frame)` for every
emitted data frame, or pipe a source through `observeFrames(source)`. `finish()`
returns the sorted inventory plus exact data-frame, data-body, R2 object, and R2
byte totals; each per-object semantic digest is computed incrementally with
normalization policy 1. `createManifest(base)` combines that result with the
archive header fields and runs full manifest validation.

Observation is deliberately serial. Unknown object IDs, duplicate
registrations, missing object frames, noncontiguous semantic parts, and frames
that split an object into multiple global runs or arrive after finalization
fail closed. Registration storage is cloned when
the accumulator is created, so caller mutation cannot change a manifest that
is already being streamed. A one-pass exporter resolves the deferred manifest
only after its observed frame generator reaches completion.

### Normalization policy 1

The per-object `semanticSha256` is derived from its ordered logical-frame
transcript, not trusted as a declaration. Start with:

```text
state = SHA-256("GSVS\0\1\n" || objectId length u32 || UTF-8 objectId)
```

For each object frame in archive sequence, canonicalize exactly this metadata:

```json
{
  "bodyEncoding": "identity",
  "bodyMediaType": "application/json",
  "kind": "tenant",
  "part": 0
}
```

Then update:

```text
record = SHA-256(metadata length u32 || metadata || body length u64 || body)
state  = SHA-256("GSVS\0\1\n" || state || record)
```

The final state is `semanticSha256`. Parts start at zero and are contiguous
independently for each frame kind within an object. Owning codecs must therefore
use deterministic frame ordering and partitioning; changing a part boundary is
a semantic-transcript change. Sequence numbers, offsets, the global frame
chain, provider IDs, SQLite page layout, encryption, and outer chunks are not
inputs. Encoder and decoder both recompute and compare every inventory digest.

The complete per-object transcript digest is the only semantic digest in v1.
The manifest deliberately has no table, schema, KV, or R2 subsection digests:
the generic container cannot assign frames to owner-specific subsections without
parsing those versioned body schemas, so such fields would be unverifiable
declarations. Owning codecs validate their descriptor counts and logical
records, while the container authenticates their complete ordered transcript.
An exporter and importer that do not share every required body schema fail
before restore.

## Lossless logical values

### SQLite

SQLite cells use a tagged union so `INTEGER` values are never rounded through a
JavaScript number:

- null: `{"type":"null"}`
- signed 64-bit integer: `{"type":"integer","value":"-9223372036854775808"}`
- IEEE-754 double: `{"type":"real","value":"-0"}`
- text: `{"type":"text","byteLength":"5","value":"hello"}`
- inline blob: `{"type":"blob","byteLength":"2","value":"AP8"}`
- external TEXT or BLOB: `text-ref` or `blob-ref` with unsigned
  `byteLength`, logical `objectId`, `firstPart`, and `partCount`

Finite doubles use JavaScript's shortest round-trippable spelling. `-0`,
`NaN`, `Infinity`, and `-Infinity` have those exact spellings. SQLite text is
valid Unicode with an authenticated UTF-8 byte length. BLOBs remain arbitrary
bytes. External TEXT parts are raw UTF-8 bytes in `do.sqlite.cell` frames. The
importer concatenates exactly `byteLength`, decodes with fatal UTF-8 validation,
and restores as TEXT (for example through `CAST`); it never changes the value to
BLOB. A value must be externalized whenever its containing row frame would
exceed 4 MiB, not only when the value alone crosses that boundary.

### Durable Object KV

The v1 codec is a self-contained, canonical tagged graph rather than JSONifying
structured-clone data. A document has `version: 1`, one tagged `root`, and
sequential decimal-ID `nodes`. It preserves:

- `undefined`, `null`, booleans, strings, doubles, and arbitrary `bigint`s;
- `Date`, `ArrayBuffer`, `DataView`, and all standard numeric typed arrays;
- array holes, arrays, plain and null-prototype objects, `Map`, and `Set`;
- cycles, shared object identity, shared backing buffers, map insertion order,
  set insertion order, and object enumeration order.

Strings with paired Unicode are UTF-8 plus an authenticated byte length.
Unpaired UTF-16 surrogates use an explicit little-endian code-unit encoding so
the enclosing canonical JSON stays valid without data loss. Accessors, symbol
properties, custom prototypes/classes, `SharedArrayBuffer`, `RegExp`, errors,
and other structured-clone extensions are outside v1 and cause export preflight
to fail rather than degrade silently.

## Snapshot and restore policy

The v1 runtime flow has stricter requirements than the byte format:

1. Remove public routing and quiesce the Kernel, Process, AppRunner, adapters,
   and ripgit owners.
2. Reconcile every provider Durable Object ID with a registered logical ID and
   fail closed on an unknown legacy object.
3. Stream one consistent logical snapshot through the client. The managed
   service never needs an operator-owned tenant export bucket.
4. Restore only into a fresh, unrouted deployment with compatible required
   schema features. Keep it suspended while all counts and digests are checked.
5. Activate routing only through a separate explicit operation. Abort removes
   staged state; a late frame cannot mutate an active tenant.

Runtime-owned deployment material is regenerated, not exported: keys under
`__gsv:managed:*`, managed setup-token policy, provider resource IDs, and
restore journals. User-owned credentials and application state are tenant data
and must not be dropped merely because they are secrets; outer encryption
protects them in transit and at rest.

### Managed ripgit lifecycle

The authenticated managed runtime coordinates ripgit through its public Worker
service boundary; it does not reach into repository Durable Objects from the
hosted control plane. Pause and resume enumerate the authoritative repository
registry in pages of at most 100 identities and require every Repository object
to acknowledge the same fence epoch before the transition is complete.

Tenant erase is irreversible. The registry first persists an `erasing`
tombstone and closes admission, then each Repository object synchronously
applies the fence, deletes and verifies all logical repository and restore
state, and persists its own `erased` tombstone. Only after that acknowledgement
may the registry delete the repository identity. The registry becomes `erased`
only after an exact terminal inventory proves that no identities remain.
Replaying any page or the complete erase is safe; an erased registry can never
resume or register a repository again.

These endpoints remain unpublished when managed administration is not
configured. Normal self-hosted routing and repository ownership are unchanged.

SQLite is exported logically, not as database pages or a Durable Object PITR
backup. The generic Durable Object codec currently rejects every virtual table,
including content-backed and contentless FTS, because v1 has not yet defined
which modules can be rebuilt losslessly. A future owner-specific codec may
rebuild supported FTS indexes from content tables; shadow-table bytes and
query-planner state are not portable. Contentless FTS always fails preflight
until a body schema defines a lossless policy.

R2 preservation covers object keys, bytes, content type and other user-set HTTP
metadata, custom metadata, and supported checksums. Provider-assigned bucket
IDs, object version IDs, upload IDs, `uploaded` timestamps, ETags, in-progress
multipart uploads, and bucket-level CORS/lifecycle/domain configuration are not
portable. Multipart objects restore as equivalent completed bytes; checksums
and ETags may be recalculated. Unsupported or invalid metadata must fail or be
reported explicitly, never be silently rewritten.

## Shared codec

`@humansandmachines/gsv-portable-archive` implements canonical JSON, bounded
inner streaming validation, manifest and per-object digest validation, SQLite
and Durable Object KV tagged values, recovery-key/passphrase envelope metadata,
and Web Crypto AES-256-GCM chunks. Checked-in golden vectors pin the exact v1
bytes. The package does not enumerate or mutate a live GSV deployment.

### SQLite-backed Durable Object body records

`@humansandmachines/gsv-worker-runtime/portable-do` is the reusable owner-level
codec for one SQLite-backed Durable Object. Its snapshot generator consumes
`DurableObjectStorage.sql`, synchronous `DurableObjectStorage.kv`, and alarm
state. Its restore session applies the resulting frames to a fresh fenced
object with a synchronous journal. It does not discover objects, assign logical
IDs, freeze application code, validate an outer archive or final manifest,
move routing, or delete a failed target. Those remain responsibilities of the
owning runtime and tenant-level orchestrator.

Every JSON body repeats `format: "gsv-do-logical-snapshot"` and `version: 1`
and is RFC 8785 canonical JSON. An archive containing these bodies declares the
single required schema feature `gsv-do-logical-snapshot-v1`, exported as
`DO_LOGICAL_SNAPSHOT_SCHEMA_FEATURE`. Alarm presence or absence is a required
descriptor field in that schema, not a separately negotiable feature. The
exact media types are:

| Frame | Media type | Body |
| --- | --- | --- |
| `do.descriptor` | `application/vnd.gsv.do-descriptor.v1+json` | Logical object ID, total table/row/KV counts, and alarm timestamp |
| `do.sqlite.schema` | `application/vnd.gsv.do-sqlite-schema.v1+json` | Tables, columns, insertion columns, deterministic order, explicit indexes, and `sqlite_sequence` |
| `do.sqlite.rows` | `application/vnd.gsv.do-sqlite-rows.v1+json` | Table name, zero-based table page, and tagged row values |
| `do.sqlite.cell` | `application/octet-stream` | One raw external TEXT or BLOB part |
| `do.kv` | `application/vnd.gsv.do-kv.v1+json` | Portable string keys and v1 structured-clone graph documents |

Descriptor and schema are part `0`. Parts start at `0` and remain contiguous
independently for rows, cells, and KV. Row pages start at `0` independently for
each table. Tables and indexes come from sorted `sqlite_schema` inspection;
ordinary rowid tables order by an unshadowed `_rowid_`, `rowid`, or `oid`, and
`WITHOUT ROWID` tables order by their declared primary key. A table that
shadows every rowid alias and has no primary key is rejected because it has no
stable v1 paging order.

SQLite projection never reads an `INTEGER` through a JavaScript number. It
reads the storage class with `typeof`, integers through `CAST(... AS TEXT)`,
reals as their native IEEE-754 JavaScript doubles, and TEXT/BLOB as raw bytes.
Projection queries are split so a 100-column source table stays below Workers'
100-result-column limit. Every cursor is fully consumed synchronously before
the generator yields or awaits. TEXT is fatal-decoded as UTF-8; invalid SQLite
TEXT fails export rather than becoming BLOB or replacement characters. Large
TEXT and BLOB values use contiguous raw cell parts of at most 1 MiB. JSON frame
bodies are at most 4 MiB; the default row/KV target is 1 MiB. A schema that
cannot fit in one v1 schema frame is not portable under this codec version.

The supported schema surface is deliberately narrow:

- ordinary rowid and `WITHOUT ROWID` tables, composite primary keys, generated
  columns, explicit indexes, and exact `AUTOINCREMENT` sequence state;
- all five SQLite storage classes and valid UTF-8 TEXT;
- synchronous Durable Object KV values supported by the v1 graph codec; and
- one alarm timestamp or no alarm.

Views, triggers, foreign keys, virtual tables, contentless FTS, unsafe or
multi-statement schema SQL, and non-deterministically ordered tables fail
closed. Foreign keys are excluded because a paged restore cannot hold one
SQLite transaction across the complete object. Cloudflare-owned `_cf_KV` and
`_cf_METADATA` tables (plus the older `__cf_kv` spelling) are never queried or
copied; their contents are represented through the public synchronous KV and
alarm APIs. Keys beginning `__gsv:managed:` or `__gsv:restore:` are runtime
state and are excluded from snapshots.

An owner must also pass every provider-bound identity, lifecycle, migration, or
fence table through `excludedSqlTables` during snapshot and the same names
through `preservedSqlTables` during restore. Names are exact, not patterns;
duplicates, wildcard characters, platform table names, and a named source or
target table that does not exist are errors. Objects whose `tbl_name` is an
excluded table, such as its indexes and triggers, are excluded with it.
`sqlite_sequence` entries for excluded tables are excluded as well. This keeps
a source provider ID out of an archive and prevents restore from replacing the
fresh target's provider ID. Owner-specific managed KV prefixes may be preserved
explicitly; `__gsv:managed:` is preserved by default and is never accepted as
archive application KV.

The caller supplies a fence assertion and must hold that fence for the entire
generator or restore session. Paging uses `LIMIT`/`OFFSET`, which is stable only
under that fence. Restore has two explicit schema modes. `empty` creates archive
application tables in a target with no non-preserved schema. `fresh-migrated`
supports real GSV Durable Objects whose constructors have already run numbered
migrations: application tables and indexes must exist, their rows and sequence
state must be empty, and their complete portable schema must exactly match the
archive before the codec inserts a row. A release mismatch fails closed; the
codec never drops or rewrites a migrated schema to make it fit. In both modes,
non-preserved KV and alarm state must be empty.

Durable Objects expose only one alarm, so the generic codec treats it as
application state and cannot merge it with a target lifecycle alarm. An owner
that uses the same alarm for managed coordination must first redesign that
coordination or provide an owner-specific lossless policy; it cannot opt that
alarm into `preservedSqlTables` or `preservedKvPrefixes`.

The owner-level lifecycle is therefore: create a new provider object; run its
normal release migrations; initialize the new logical name, provider ID,
lifecycle record, and fence only in explicitly preserved storage; keep the
object paused and unrouted; begin `fresh-migrated` restore; apply only archive
application SQL/KV/alarm state; finalize and verify all counts; rebuild or
reconcile managed metadata; then activate routing in a separate operation. A
failed target remains fenced and disposable.

Each accepted frame, table page, cell part, and KV key is journaled under
`__gsv:restore:` in the same synchronous transaction as its mutation. An exact
frame replay is a no-op; a same-part replay with different bytes fails. Finalize
checks declared table, row, KV, cell, and sequence state. Stream restores also
bind the canonical frame count, body-byte count, and semantic digest—together
with the resolved schema and preservation policy—to the versioned journal and
completion marker. An accepting journal cannot finalize until a complete
stream has verified that exact transcript; only a previously verified
interrupted finalization or exact completed replay may finish without reading
the retry body. Finalize creates indexes only in `empty` mode, restores the
alarm idempotently, removes the in-progress journal in bounded pages, and
retains the small excluded completion marker. Frames are still untrusted until
the archive manifest validates, so the target must remain unrouted and
disposable throughout restore.

Importers still treat authenticated archives as hostile input. They apply
explicit limits before allocation; reject unknown versions, fields, flags,
kinds, encodings, and required features; avoid logging keys or content; and keep
restore state fenced and disposable until complete verification succeeds.
