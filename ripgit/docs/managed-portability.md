# Managed repository portability primitives

Ripgit exposes a private, epoch-fenced control surface for inventorying,
pausing, logically snapshotting, restoring, and resuming repository Durable
Objects. These are component primitives, not an end-to-end portable archive
claim. The managed control plane must still coordinate them with the other GSV
components and with an authenticated archive format.

## Ownership and identity

Every named repository request is admitted through the singleton
`ManagedRepositoryRegistry` Durable Object before it reaches a `Repository`.
The registry stores an immutable mapping from the Cloudflare provider ID to
`{owner, repo}` in SQLite. The repository independently persists the same
identity and verifies that the provider ID equals its own Durable Object ID.

Workers KV binding `REGISTRY` is optional cache storage only. It is never an
authority for identity, inventory, lifecycle state, or mutation admission.

A pre-registry provider ID is unknown and fails closed. An operator may supply
an owner and repository through `legacy-map`; ripgit accepts the mapping only
when `REPOSITORY.idFromName("<owner>/<repo>")` exactly equals the supplied
provider ID. There is no guessed or lossy reverse mapping.

## Deployment requirements

The worker requires these Durable Object bindings:

- `REPOSITORY` -> `Repository`
- `MANAGED_REPOSITORY_REGISTRY` -> `ManagedRepositoryRegistry`

Wrangler migration `v2` creates `ManagedRepositoryRegistry` as a SQLite
Durable Object. Existing managed deployments must upload that migration before
uploading later ID-less script revisions; merely copying the binding into an
existing worker is insufficient.

Managed deployments must also provision `GSV_MANAGED_ADMIN_TOKEN_HASH` into
the ripgit worker. It is the lowercase SHA-256 hex digest of the same bearer
token used by the gateway managed-admin surface. The control plane calls
ripgit through a service binding and sends `Authorization: Bearer <token>`.
When the secret is absent, the managed surface returns not found. Ripgit has
`workers_dev = false`; it should not receive a public route to this surface.
The Worker reserves the entire `/__gsv/managed` namespace before named
repository routing. Calls from the Worker to its registry and repository
control endpoints also carry a distinct internal control marker that normal
forwarding always overwrites, so caller-supplied headers cannot enter the
private lifecycle surface.

Release integration must add the new binding, class, migration, secret, and
service-binding call path to the managed security-epoch capability manifest
and its tests. Do not mark repository export or restore as supported until the
fleet coordinator and archive pipeline consume these primitives.

## Private worker API

All routes below are `POST` routes under
`/__gsv/managed/v1/ripgit` and require managed-admin authorization.

### Inventory and descriptors

- `/status`, body `{}`: returns the durable global gate and count of
  repositories still pending the current transition.
- `/inventory`, body `{ "cursor": null, "limit": 100 }`: returns registered
  repositories ordered by provider ID. The maximum page is 100.
- `/objects/describe`, body
  `{ "kind": "repository", "providerIds": ["..."] }`: returns the exact
  `ManagedObjectDescriptorBatch` v1 shape. Kind may be `repository` or
  `repository_registry`; the maximum batch is 500. Every valid provider ID is
  returned, including unknown IDs as `uninitialized` with a null logical name.
- `/legacy-map`, body
  `{ "identity": { "owner": "alice", "repo": "memory", "providerId": "..." } }`:
  verifies `idFromName`, registers the immutable mapping, initializes the
  repository identity, and acknowledges its current lifecycle epoch.

The registry descriptor logical name is `singleton`. A repository descriptor
logical name is `<owner>/<repo>`.

### Pause and resume

- `/pause`, body `{ "cursor": null, "limit": 100 }`
- `/resume`, body `{ "cursor": null, "limit": 100 }`

The first pause call advances the durable global epoch and fences new
mutations before visiting repository objects. Each response contains
`nextCursor`; callers repeat with that cursor until it is null and
`pendingRepositories` is zero. Registration of previously unknown named
repositories is disabled while the gate is not active.

Resume advances the epoch again and enters `resuming`. Each repository must
acknowledge the exact epoch. The last page seals the gate back to `active` only
when no acknowledgement is pending. Replayed pages and transitions are
idempotent; stale epochs fail.

A mutation carries its admitted epoch to the repository. Ripgit rechecks that
epoch after reading request bodies and after upstream network waits, before any
subsequent SQL mutation. Thus a request that resumes after its pause handshake
cannot write late.

### Logical snapshot

Snapshot calls require the global gate and the selected repository to have
acknowledged the same paused epoch.

- `/snapshot/manifest`, body `{ "providerId": "..." }`
- `/snapshot/page`, body
  `{ "providerId": "...", "manifestHash": "...", "tableIndex": 0,
     "offset": 0, "limit": 100 }`

The manifest fixes the portable logical repository identity `{owner, repo}`,
source epoch, table layouts, and row counts and is SHA-256 hashed. The source
provider ID is live registry/routing state and is never serialized into the
snapshot. Pages are ordered by stable primary-key order,
carry the manifest hash, and have their own SHA-256 content hash. Page output
is bounded to 250 rows and approximately 8 MiB of encoded row data; a single
row may exceed the byte target. Integer values are decimal strings and blobs
are base64. The exact v1 repository tables use only SQLite `INTEGER`, `TEXT`,
and `BLOB` storage classes; a value with another storage class fails closed.
Because the Workers Rust SQL bridge carries integers through JavaScript
numbers, v1 also fails closed for integers outside the JavaScript safe range
(`-(2^53-1)` through `2^53-1`) instead of exporting or restoring them
lossily. This is an explicit logical-schema codec, not an arbitrary SQLite
codec.

The v1 codec includes these authoritative tables:

`config`, `blob_groups`, `commits`, `commit_parents`, `trees`, `blobs`,
`blob_chunks`, `raw_objects`, `refs`, `issues`, and `issue_comments`.

`commit_graph`, `fts_head`, and `fts_commits` are derived and rebuilt after a
restore. `package_build_cache` and `package_npm_cache` are disposable and are
not exported. Snapshot creation fails closed if it finds an unknown user table
or a changed authoritative column layout. Consequently this is lossless for
the explicitly supported ripgit table rows, not an arbitrary SQLite file
codec or a byte-identical database image. SQLite-internal metadata such as
`sqlite_sequence` is recreated by the target schema and explicit row inserts;
it is not a serialized primitive in v1.

### Fresh restore

Restore calls require the target registry and repository to remain at one
paused epoch. The target provider identity comes from its registry mapping;
the source's logical `{owner, repo}` identity is used only to bind the archive
object and is not a provider resource identifier.

- `/restore/begin`, body
  `{ "providerId": "...", "restoreId": "...", "manifest": { ... } }`
- `/restore/apply`, body
  `{ "providerId": "...", "restoreId": "...", "page": { ... } }`
- `/restore/seal`, body `{ "providerId": "...", "restoreId": "..." }`

Begin rejects a target containing repository data. It journals the exact
manifest hash and next table/offset. Apply accepts only that next page. An
exact replay is idempotent, including recovery after a page write completed
but its journal advance did not; a replay with another hash fails. Seal is
allowed only after all declared rows have been applied and table counts match,
then rebuilds the derived indexes and marks the journal sealed.

The logical pages do not provide archive encryption, cross-component ordering,
retention, or transport authentication. Those remain responsibilities of the
managed portable-archive coordinator. Restore is intentionally fresh-only;
merging into a populated repository is unsupported.
