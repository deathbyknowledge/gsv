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

## Remaining cloud handoff

Capture an authoritative D1 snapshot and durable cloud operation record;
enforce the remote runner freeze and concurrent-write/precondition checks;
implement and verify atomic owner-ledger and historical-receipt changes on the
live D1 database; configure both new runners; then run the
onboarding/reset/isolation acceptance journey before Worker cutover. The local
executor is an executable rehearsal of the checked transitions, not a D1
compare-and-swap protocol or permission to import a modified snapshot.

Run the public fixtures with `npm exec -- vitest run
test/installation-migration-adoption.test.ts
test/installation-migration-adoption-executor.test.ts` from `deployment/`. The private
owner's acceptance run additionally sets `GSV_ADOPTION_LEGACY_MIGRATIONS` to
its reviewed twelve-file directory. Those extra tests use real SQLite and
private sources locally; they explicitly skip when private sources are absent.
The existing public CI deployment job runs `npm test --workspace deployment`,
which discovers both files and runs all public fixtures. Private-source
acceptance remains the private owner's check.
