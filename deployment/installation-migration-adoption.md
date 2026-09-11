# Installation migration adoption planner

`src/installation-migration-adoption.ts` plans the legacy Accounts ledger
handoff described in the engineering migration inventory. It reads a SQLite
snapshot and returns actions; it does not connect to Cloudflare, apply SQL to
the supplied database, change a runner, or authorize Worker cutover.

Supply the exact operation, environment, account and database identities; full
old/new runner revisions; the three distinct ledger names; and a SHA-256
reference to the operator's reviewed historical source-provenance evidence.
The legacy runner must already be frozen. The operator retains this evidence,
the snapshot, reset proofs and returned plan outside ordinary logs and Git.

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
imports rather than fabricating pending work.

Remaining runner work: capture an authoritative D1 snapshot and durable
operation record, enforce the freeze and concurrent-write/precondition checks,
create/seed owner ledgers and persist completion atomically, apply and fence
historical receipt imports, verify postconditions and preserved data, configure
both new runners, then run the onboarding/reset/isolation acceptance journey
before Worker cutover. `preconditionSha256` identifies this observed plan; it
does not itself provide a database lock or a compare-and-swap operation.

Run the public fixture with `npm exec -- vitest run
test/installation-migration-adoption.test.ts` from `deployment/`. The private
owner's acceptance run additionally sets `GSV_ADOPTION_LEGACY_MIGRATIONS` to
its reviewed twelve-file directory. Those extra tests use real SQLite and
private sources locally; they explicitly skip when private sources are absent.
