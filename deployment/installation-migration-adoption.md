# Installation migration adoption

`src/installation-migration-adoption.ts` plans the legacy Accounts ledger
handoff described in the engineering migration inventory. It reads a SQLite
snapshot and returns actions; it does not connect to Cloudflare, apply SQL to
the supplied database, change a runner, or authorize Worker cutover.
`src/installation-migration-adoption-executor.ts` applies a reviewed plan to
**local, transaction-capable SQLite only**. Neither module supplies an
authoritative Cloudflare D1 snapshot, freezes a remote runner, executes a live
D1 handoff, or authorizes Worker cutover.

Supply the exact operation, environment, account and database identities; full
old/new runner revisions; the three distinct ledger names; and a SHA-256
reference to the operator's reviewed historical source-provenance evidence.
The legacy runner must already be frozen. The context's freeze flag is an
operator attestation, not a lock implemented by these modules. The operator
retains this evidence, the snapshot, reset proofs and returned plan outside
ordinary logs and Git.

The source inventory pins twelve file names, owners, and exact SHA-256 values.
SQL is supplied by each owner; private policy/routing SQL and seeds are not
vendored here. The planner verifies every supplied source, reconstructs only
the recorded applied prefix in a disposable in-memory database, and compares
tables, indexes, triggers, column defaults/keys, and foreign keys to the
observed database. Source checksums do not prove what a historical runner
executed: historical provenance and actual schema remain separate requirements.
Unknown migrations, ledger records, schema drift or broken references stop
planning. A fresh public-only deployment uses ordinary public migrations,
not this adoption planner.

For each owner, apply `beginHandoff` before seeding its ledger. Create only the
new migration ledger if requested, preserve each verified legacy `id`, `name`
and `appliedAt`, and retain its source checksum in the adoption evidence.
Persist `completeHandoff` only after all of that owner's expected entries are
present and verified. The operator must apply these state transitions and
entries atomically, or recover by rereading the durable handoff and database.
An existing ledger is not a completion marker; a populated ledger without the
same adoption record is rejected. A repeat plan emits only missing entries.
The old ledger remains unchanged. No historical DDL or routing seed is replayed.

## Local transaction executor

The deployment package exposes the local executor separately from its planner:

```ts
import { executeLocalInstallationMigrationAdoption } from
  "@humansandmachines/gsv-deployment/installation-migration-adoption-local";
```

Call `executeLocalInstallationMigrationAdoption` with the same `context`,
reviewed `sources`, `resetProofs` and local `DatabaseSync` used for planning,
plus `approvedPreconditionSha256` from the reviewed plan. Initial externally
recorded `handoffs` may be supplied when recovering a previously interrupted
handoff. The executor accepts no caller-provided SQL action list.

The precondition binds the observed schema, ordered row values, migration
records, context and reset evidence. A change that preserves row counts still
invalidates approval. Row values are hashed incrementally; the returned plan
and durable metadata contain digests, never copied credentials or policy data.
The caller must own the local snapshot and keep the evidence confidential.
Checksums identify evidence; they do not authenticate who produced it or prove
that a historical reset actually occurred.

The executor requires foreign-key enforcement and no enclosing transaction.
It acquires `BEGIN IMMEDIATE`, rereads the database, and recomputes the plan
before comparing the approved precondition. In that transaction it:

1. Persists one operation record in `installation_migration_adoption`, a
   tooling-owned table with an exact validated schema and one JSON record.
   This durable record owns subsequent handoff state.
2. Creates only missing owner ledgers and seeds only verified legacy records,
   checking each owner before marking it complete. Existing Wrangler integer
   IDs and text ledger IDs are preserved; only an owner ledger's own
   `AUTOINCREMENT` sequence may advance.
3. Inserts only missing, verified historical reset receipts and prepared
   participants. It never copies policy, replays historical application DDL,
   applies forward migrations, or advances pending service preparation.
4. Verifies that existing application rows and the legacy ledger are unchanged,
   verifies both completed owner ledgers, and records the final precondition
   before committing. Any failure rolls back all of these changes.

A repeat call after a lost successful response can use the original approved
precondition, including after closing and reopening the database. It returns
the persisted result with `applied: false` only when the operation, evidence
and recorded postcondition still match. New application writes or forward
migrations make that completed snapshot stale; do not replay adoption against
the changed database. A previously interrupted external handoff needs a fresh
plan and approval of its current partial state. These guarantees apply to
this local SQLite transaction, not to a remote D1 database or a snapshot that
continues changing elsewhere.

`handoffComplete` describes the observed durable state, not the projected result
of applying the plan. Both owners must be complete before either new runner
applies `pendingForwardMigrations`. Adoption of prefixes 0009, 0010, 0011 and
0012 is tested independently. This planner covers the frozen legacy handoff:
after new owners apply forward migrations, the operator uses their ledgers and
validates the new schema rather than treating the now-stale legacy prefix as
the current schema. Prefer applying the already-reviewed reset-preparation
migrations before freezing the old runner if historical resets need importing.

When reset receipt/participant tables exist, each reset requires an explicit
operation-bound classification and evidence digest. A verified legacy atomic
reset yields receipt and **prepared** participant insertions only. The receipt
also establishes the retired identity's policy-write fence. Policy rows are
never recopied or updated, and deletion state is untouched. Repeated imports
recover an existing matching receipt, including a receipt written before its
reply was lost. Pending service preparations stay pending; missing participants,
ambiguous history, active old identities and conflicting tuples fail closed.
Before the required tables exist, `resetImportsRequireMigrations` blocks these
imports rather than fabricating pending work. The local executor refuses the
whole adoption in that case, before creating ledgers or metadata. Apply the
reviewed preparation migrations through their current owner before freezing
and obtaining another snapshot.

## Remote D1 handoff

`@humansandmachines/gsv-deployment/installation-migration-adoption-remote`
adds a separate remote executor. It does not change the local executor's scope.
The remote transport uses Cloudflare's authenticated D1 REST query endpoint;
all statements in an adoption batch commit or roll back together.

Before running it, stop every privileged migration/deployment runner for the
selected database and review the exact paired public/private Git revisions.
The private composition removes `migrationsDir` from the existing D1 resource;
its former mixed directory remains a historical source archive. This is an
operator maintenance window: Accounts/inference D1 writes temporarily fail
closed while the snapshot is frozen. Drain affected work and arrange retries
before starting. Ordinary reads remain available. The tool does not pause
Workers, change credentials, or freeze other storage systems.

The database record `installation_migration_freeze` owns one operation with
phases `frozen`, `adopted`, `released`, and `cancelled`. Creating its record and
INSERT/UPDATE/DELETE guards on every observed application/ledger table is one
transaction. A full schema comparison in that transaction rejects a race that
added an unfrozen table. Subsequent reads validate the exact guard definitions.
Reserved Cloudflare `_cf_*` and SQLite internal objects are excluded from the
application schema, except the legacy `sqlite_sequence` values are captured.

Snapshot rows travel as typed values: integer decimal strings, round-trippable
real strings, blob hex, and unchanged text/null. This avoids JavaScript number
rounding in ordinary D1 JSON/export results. The local reconstructed snapshot
is validated by the existing planner and local transaction executor. No
historical source SQL is sent to the remote database.

Applying the reviewed precondition performs one guarded D1 batch. It rechecks
the exact operation and entire schema while writes remain frozen, seeds only
verified owner rows, imports only verified missing reset preparation tuples,
and stores both completion receipts. A short `applying` phase exists only
inside that transaction so the import can pass the guards. A persisted
`applying` phase is invalid. After commit, the executor recaptures and compares
the entire frozen postcondition before removing application guards. The three
legacy ledger guards remain, so the old runner cannot append more migration
records. A normal migration plus its legacy ledger insert therefore rolls
back. Privileged DDL can remove SQL triggers; this mechanism does not claim to
protect against another operator dropping/recreating tables or editing the
control record. Keeping all privileged runners stopped is a required external
precondition, not something a bookmark or caller boolean proves.

A failed or lost response is reconciled from the durable phase:

- `frozen`: re-prepare into a new private artifact directory, review, then apply;
  cancellation can remove the guards before adoption has committed.
- `adopted`: repeat apply with the original approved checksum; it verifies the
  committed postcondition before releasing writes. It cannot be cancelled.
- `released`: repeating the same apply returns its receipt. Later application
  writes or forward migrations do not cause historical adoption to replay.
- `cancelled`: no ownership changes committed; the same reviewed operation can
  freeze a new snapshot. A different operation/evidence requires review.

If postcondition verification fails, writes remain frozen. Diagnose the
mismatch; do not delete guards or import a modified snapshot. The runner never
restores an entire database automatically.

### Operator command and evidence custody

The private overlay exposes:

```sh
node deployment/migrate-installations.ts prepare --request /secure/handoff/request.json --output /secure/handoff/snapshot-1
node deployment/migrate-installations.ts status --request /secure/handoff/request.json
node deployment/migrate-installations.ts apply --request /secure/handoff/request.json --approved-precondition <reviewed-sha256>
node deployment/migrate-installations.ts forward --request /secure/handoff/request.json
```

Use Node 24 with `CLOUDFLARE_API_TOKEN` provided through the operator's existing
secret mechanism. The public entrypoint is also exported as
`@humansandmachines/gsv-deployment/installation-migration-command`.
The token remains in memory, never in request/plan files, arguments or output.
Commands are explicit mutations; deploying a Worker never runs them implicitly.

The strict request JSON contains:

- `context`: the existing planner context, exact database/account/environment,
  operation ID, all three Git revisions and three distinct ledger names;
- `legacy`, `directory`, `policy`: each `{ "repository": "...", "directory":
  "..." }`, resolved relative to the request file. The legacy directory is
  `accounts/migrations`; the new directory owner is the public
  `workers/installations/migrations`, the policy owner is private
  `inference/migrations`;
- `sourceProvenanceFile`: a reviewed historical source/deployment evidence file
  whose contents match `context.legacySourceEvidenceSha256`;
- `resetProofs`: the existing exact reset proof fields plus `evidenceFile` for
  each proof. The file contents must match its `evidenceSha256`.

Historical SQL is loaded with `git show` from the exact legacy revision, never
from a dirty working copy. Owner SQL is likewise read from the exact directory
and policy runner revisions. Artifact hashes bind reviewed evidence bytes;
they do not authenticate a historical deployment or prove an old reset was
atomic. The operator must establish that provenance from the actual previous
implementation, deployment/audit records and operation identity. Missing
provenance blocks import; a placeholder hash or an invented receipt is not a
substitute.

Prepare requires a new output directory, creates it with mode 0700, and writes
`snapshot.sqlite` and `plan.json` with mode 0600. The plan includes the snapshot's
raw-byte SHA-256. Keep these artifacts and provenance outside Git and ordinary
CI logs: the snapshot contains private Accounts/policy data. A write failure
after freezing leaves the durable freeze available for status/recovery, rather
than silently reopening a snapshot that was never reviewed. Standard output
contains only operation phase/checksums and names of applied forward migrations.

### Owned forward migrations

The owner runner requires both completed handoff receipts and the legacy ledger
fence. It validates each owner's applied prefix, all twelve historical source
fingerprints, and immutable checksums for later migrations. Each forward
migration, owner ledger row and checksum receipt commits in one D1 batch.
Source mismatches, foreign owner rows, missing receipts and concurrent ledger
changes fail before a partial migration can commit. A lost reply is retried by
rereading receipts; no already-applied SQL is replayed. The old ledger and all
historical SQL files remain untouched. Directory migration 0013 and later run
only through the directory owner after adoption.

This runner deliberately rejects an existing database without a released
handoff. Fresh public/operator database bootstrap is a separate W3 path and
must not fabricate a legacy adoption receipt.

### Validation and remaining operator step

The remote suite runs real D1 transactions through Miniflare, including actual
private migration prefixes when `GSV_ADOPTION_LEGACY_MIGRATIONS` is set. It
checks freeze/cancellation, integer precision, both ledger shapes, failed-batch
rollback, lost replies at each phase, changed schema/guards, historical reset
imports, pending service preparation, and forward migration receipts.

The [isolated historical upgrade fixture](acceptance/legacy-upgrade/README.md)
deploys pinned pre-extraction services, creates real credentials and a pending
reset, then exercises this same handoff against the retained resources. It
checks password/token, file and nonempty history continuity without issuing
replacement credentials. Its synthetic operator admission does not establish
Cloudflare Access or existing messenger-link continuity. Recorded live results
and remaining release coverage are in the
[cloud acceptance report](../engineering/hosting-consolidation-cloud-acceptance-2026-09-12.md).

For each adopted deployment, review the evidence and exact release, disable the old
runner, drain writes, prepare/review/apply its snapshot, verify both
owners and data preservation, run the owned forward migrations, then perform
the two-installation routing/reset/deletion acceptance flow. Worker cutover is
still an explicit operator decision.

References: [D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[REST query batches](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and
[export precision caveat](https://developers.cloudflare.com/d1/best-practices/import-export-data/).
