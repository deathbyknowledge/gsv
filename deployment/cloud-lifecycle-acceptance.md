# Guarded cloud lifecycle acceptance

This driver tests an existing operator deployment using two explicitly selected disposable spaces. It does not create a deployment or select fixtures by a handle search. The reviewed scope contains the complete existing registry, with at least two distinct identities: A may be reset, B receives one isolated marker file, and all other spaces remain untouched. Both fixtures must have the same local username. The driver never sends a message, starts inference, pairs a device, or edits an existing user file.

The operator supplies a private JSON scope:

```json
{
  "version": 1,
  "runId": "unique-acceptance-run",
  "accountId": "exact-cloudflare-account",
  "databaseId": "exact-installations-database",
  "accountsWorker": "exact-accounts-worker",
  "accountsOrigin": "https://accounts.example.com",
  "fixtures": {
    "a": { "installationId": "immutable-a-id", "handle": "fixture-a", "canonicalOrigin": "https://fixture-a.example.com" },
    "b": { "installationId": "immutable-b-id", "handle": "fixture-b", "canonicalOrigin": "https://fixture-b.example.com" }
  },
  "expectedSpaces": [
    { "id": "immutable-a-id", "handle": "fixture-a", "state": "active" },
    { "id": "immutable-b-id", "handle": "fixture-b", "state": "active" },
    { "id": "protected-c-id", "handle": "protected-c", "state": "active" },
    { "id": "protected-d-id", "handle": "protected-d", "state": "active" },
    { "id": "protected-e-id", "handle": "protected-e", "state": "active" }
  ]
}
```

The credential fixture file contains `spaces` with `installationId`, `handle`, `canonicalOrigin`, `username`, `password`, and `rootPassword` for A and B. Extra saved acceptance fields are allowed. The operator file contains `origin` and `token`; the Cloudflare token is a separate text file. Use owned regular files with mode `0600` and a dedicated output directory with mode `0700`. Keep all inputs and outputs outside the repository. The reviewed account/Worker's actual `INSTALLATIONS_DB` binding must match the database in the scope. A read-only D1 query checks the complete registry before and after each phase.

Run the preparation first:

```sh
node deployment/src/cloud-lifecycle-command.ts prepare \
  --config /private/scope.json \
  --fixtures /private/fixture.json \
  --operator /private/operator.json \
  --cloudflare-token /private/cloudflare-token \
  --output /private/lifecycle-run
```

Preparation authenticates A and B as human/root, requires an exact match against every reviewed registry identity, requires the new marker path to be absent, and fingerprints all of B's existing conversation messages. It makes no user-data or administrative writes. The private state includes generated replacement human/root credentials and fresh reset/deletion operation IDs, saved with `fsync` before any later mutation. The public report contains the approval digest and progress, without credentials, onboarding links, conversation contents, or markers.

Review the scope and report. Run each phase separately with the exact `approvalSha256` as `--approve`, retaining the same other arguments (the fixture file is required only for prepare):

1. `seed` writes distinct markers at the same unused path in A and B. Existing foreign content is never overwritten.
2. `reset` calls the operator reset API for A's immutable ID and exact handle, using the already saved operation ID. An uncertain response resumes that same operation.
3. `setup` activates the replacement using the pre-saved human/root credentials. After a lost reply it checks the actual installation state and those credentials, without issuing another setup to an active space. It proves the old marker is absent before writing a replacement marker.
4. `verify` proves both old passwords are rejected, both replacement passwords work, replacement data persists, B's marker and conversations remain unchanged, and every other reviewed identity/state is unchanged.
5. `retire` pins the saved deletion operation against the retired original ID and its current retired handle. Run this **before registering inventory**, because verified reset inventory can otherwise be admitted automatically by Accounts' cleanup cron.

The private `state.json` is the recovery record. Do not regenerate it, change the scope, rerun a creator script, or invent another operation ID after an interrupted phase. Check `phase` and `checkpoints` and rerun the interrupted phase with the same approval. The driver rejects resetting after completed setup. Each invocation owns `run.lock`; a crashed process leaves this lock intentionally. Before manually removing a stale lock, verify that its recorded PID is no longer the acceptance process and no other invocation is using the directory. Do not remove a live lock. Unique `.next` files left by a crash are uncommitted checkpoints and may be removed after the same check; `state.json` remains authoritative.

Physical discovery, inventory verification/import, and operator resource evidence use the existing [deletion capture flow](installation-deletion-capture.md). They must use the retired A ID and the `deletionOperationId` saved here. This driver does not construct or submit that evidence.

After inventory review and import, `delete --inventory-sha256 <verified-manifest-sha256>` persists that exact digest and begins only the pinned operation. `deletion-retry` advances it; `deletion-status` reads progress. These phases continue checking B and replacement data/credentials. Accounts may delete the old directory row and reset linkage during erasure: the driver accepts that only against the saved replacement ID and current matching Accounts receipts. Before final erasure, missing old rows require an explicit Accounts `live-erased` or `erased` receipt with zero pending resources. After final erasure removes owner receipts, the current authenticated coordinator tombstone for the exact saved installation and operation is authoritative; the saved replacement identity is still required. A remaining backup/log/provider retention period stays visible as pending; `live-erased` is not reported as complete deletion.

This proves the selected cloud reset/setup/data-isolation journey. It does not prove BYO model credentials, real messenger delivery, legacy credential migration, or complete historical physical inventory. Those remain separate acceptance gates.
