# Hosting consolidation migration inventory

This is the schema and reset-state handoff inventory for the Accounts
extraction in [the consolidation specification](./hosting-consolidation-spec.md).
It defines what an adoption operation must verify and retain. It is not a
record that any migration has been applied to staging or production.

H&M initially keeps its existing D1 database and resource identity. Public
Accounts and the private policy/usage owner receive separate migration
ledgers against that database. Sharing a D1 binding does not provide table-level
security isolation. Physical tables and installation identities stay unchanged.

## Migration ownership

The legacy source location is the private repository's `accounts/migrations/`.
Copy shipped SQL unchanged into its owning migration directory. A gap in an
owner's numbering is expected; do not renumber the files to close it.

| Legacy file | Owner after handoff | Objects or changes to inventory |
|---|---|---|
| `0001_account_directory.sql` | Public Accounts | `principals`, `installations`, `hostnames`, `memberships`, `provisioning_operations`; their constraints and indexes |
| `0002_installation_onboarding.sql` | Public Accounts | `installation_onboarding_claims`, expiry index, installation foreign key |
| `0003_managed_inference_usage.sql` | Policy/usage | `managed_inference_usage_events`, keys, period index, installation foreign key |
| `0004_managed_inference_policy.sql` | Policy/usage | `managed_inference_control`, `managed_inference_policies`, defaults, installation foreign key |
| `0005_managed_inference_purpose.sql` | Policy/usage | Usage purpose column and index |
| `0006_add_installation_resets.sql` | Public Accounts | `installation_reset_operations`, identity uniqueness constraints, deletion index |
| `0007_managed_inference_routing.sql` | Policy/usage | Initial `managed_inference_routing` schema and seed |
| `0008_workers_ai_inference.sql` | Policy/usage | Routing table replacement and seed transition |
| `0009_managed_inference_fallbacks.sql` | Policy/usage | Ordered routing schema and fallback seed transition |
| `0010_prepare_membership_ownership.sql` | Public Accounts | Ownership table rebuild; legacy `role` default, `local_uid`, and constraints retained for the intermediate rollout |
| `0011_installation_reset_preparations.sql` | Public Accounts | `installation_reset_participants`, pending index, `installation_reset_preparation_guard` trigger |
| `0012_inference_reset_receipts.sql` | Policy/usage | `managed_inference_reset_receipts`; unique operation, previous identity, and replacement identity |

Public Accounts uses `workers/installations/migrations/` and the
`installation_migrations` ledger. Record the private owner's selected ledger
name before handoff; it must differ from the directory ledger and the retired
legacy runner's ledger. Classify migrations added after `0012` before cutting
the release. Each migration has exactly one active owner.

Files present in a checkout are not evidence that a stage applied them.
In particular, inventory `0010`, `0011`, and `0012` independently in each
environment rather than assuming they reached the live database together.

## Adoption evidence

Keep an adoption record for each deployment in the operator's controlled
state. Record these facts before either new runner applies DDL:

- Environment, Cloudflare account and D1 database identities, old and new
  runner revisions, ledger names, and the adoption operation identity.
- Every applied legacy migration name and recorded application time, together
  with the SHA-256 of its reviewed source file. A legacy ledger that has no
  checksum column is not proof of the historical file contents; reconcile
  source provenance and the actual schema as separate evidence.
- Actual table, index, and trigger definitions; column defaults; primary and
  unique keys; and foreign keys. Include the preparation guard trigger, not
  just the participant table.
- Per-table row counts, identity/reference consistency checks, and the
  preserved reset state described below. Retain any sensitive snapshot or
  export under operator access controls, outside Git and ordinary logs.
- For each new ledger, the verified legacy entries copied into it and its
  durable handoff-complete state. Record interrupted or conflicting adoption
  explicitly rather than treating an existing ledger as complete.

Freeze the legacy migration runner before seeding the new ledgers. Seed only
verified migrations already applied to the existing database; do not rerun
their `CREATE TABLE`, table rebuilds, or routing seeds. Preserve the legacy
ledger as historical evidence and stop using it to apply new migrations.

On retry, reconcile the same adoption record and entries. A partially seeded
ledger must not cause existing DDL to run again, skip unapplied DDL, or let
another owner apply the same migration. Stop before Worker cutover when the
schema, ledger entries, or source provenance disagree. Apply new forward
migrations only after both ownership handoffs are complete.

## Reset and service state to preserve

For every reset, inventory the exact operation ID, previous and replacement
installation IDs, canonical handle/origin/hostname, and both installation
states. Retain the original creation and update times, provisioning operation,
reservation state, and `data_deletion_state`, including any error or completion
record. A chain of resets must retain every identity and operation in the chain.

For resets using service preparation, retain:

- The frozen participant IDs, each `pending` or `prepared` state, and its
  attempt timestamp. Configuration changes must not silently remove a
  required participant or substitute a different participant identity.
- Each service's operation-bound receipt and the exact previous/replacement
  tuple. For inference, preserve `managed_inference_reset_receipts` and both
  identities' policy rows. Replaying a receipt must not copy policy again or
  overwrite an operator edit made after preparation.
- The source policy until required preparation is complete. A pending
  participant keeps the replacement reserved and blocks provisioning and
  activation, even when another participant has already prepared.
- The configured retry owner and periodic trigger. A timed-out or interrupted
  attempt retains its pending row, advances retry fairness durably, and can
  resume after a Worker restart. A late reply does not mark the timed-out
  coordinator attempt complete; a later retry can recover the service receipt.

Also preserve principal and ownership rows, hostname aliases and retirement
state, onboarding claim hashes/expiry/revocation/completion, inference control
and routing, usage records, and any independently owned inference reservations.
Do not export raw onboarding capabilities or credentials into the inventory.

## Historical resets without preparation rows

Before the service-preparation protocol, the legacy reset transaction copied
the replacement inference policy and disabled the previous policy atomically
with the directory reset. Such an operation can have no participant or service
receipt rows while its replacement is already provisioning or active.
Its old installation may still be marked pending deletion.

Classify these operations from verified legacy provenance and the adopted
state. Missing participant rows alone do not establish which implementation
performed a reset or whether the deployment required any service preparation.

For a verified legacy atomic reset, record preparation as already completed.
When importing it into the new receipt/fence protocol, persist the matching
service receipt and any required prepared participant record without copying
policy again. Preserve the replacement's current policy, including later
operator edits. Preserve or establish the retired identity's write fence.

Do not backfill these operations as pending and run preparation against them
blindly: an active replacement correctly rejects first-time preparation, and
the source policy has already been disabled. Recopying that source can lose
the original enabled policy or overwrite later intent. Ambiguous historical
state requires explicit reconciliation before admitting a new preparation.

Preparation completion and data deletion are independent. Do not change
`data_deletion_state` to complete when importing a receipt or retiring routing.
Kernel, Process, Conversation, R2, ripgit, adapter, mail, and inference data
remain owned by their cleanup participants until those owners confirm erasure.

## Remaining schema boundaries

`managed_inference_policies` and `managed_inference_usage_events` currently
reference `installations` with deletion cascades. Inventory both dependencies.
Remove them only through a later data-preserving policy/usage migration, after
explicit cleanup acknowledgments and write fences replace the cascades.
Keep physical table names and accumulated usage unchanged during that step.

Membership `role` and `local_uid` retirement is a separate two-deployment
change. `0010` is the intermediate compatibility schema; removing those
columns must wait until older Workers and requests have drained. The usage
ledger's `local_uid` identifies an inference actor and is not part of the
membership-column removal.

## Acceptance evidence before cutover

Verify a fresh public-only database and an adopted database independently.
A fresh public deployment applies directory-owned migrations only; private
policy/routing seeds must not enter it. A fresh H&M deployment applies each
owner's migrations, with directory tables present before historical policy
and usage foreign keys require them.

The adoption verification must exercise:

- Interruption between owners, partial ledger seeding, and repeated adoption
  without duplicate DDL or overwritten data; unexpected schema fails closed.
- Historical resets whose replacements are reserved, provisioning, or active,
  with old data still pending deletion and later replacement policy edits.
- A service receipt committed before its reply is lost, concurrent preparation
  retries, a missing configured participant, and no activation before every
  required acknowledgment.
- A stalled participant alongside a responsive one, restart after the durable
  attempt timestamp changes, progress for later operations, and a late reply
  after the attempt deadline.
- Unknown-host rejection, inactive-installation admission refusal, onboarding
  claim continuity, and unchanged installation and credential identities.

Record the exact runtime, private-service, and infrastructure revisions used
for these checks. Migration adoption is not permission to rename physical
resources, reset installation data, or deploy an unreviewed revision.
