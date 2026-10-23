# PDS

The PDS worker hosts each Ship's public ATProto repository. `src/host/` is the
host. One `HostedRepo` Durable Object per account holds its did:plc, signed
repository, blobs and firehose outbox. One `HostFirehose` object numbers every
repository's events into the host's firehose and keeps the directory of hosted
repositories. `handleXrpc` serves public reads, sending each repository read to
the object that holds the repository. Nothing deploys the host yet.

## Repository engine

`src/cirrus/` is the ATProto repository engine from
[Cirrus](https://github.com/ascorbic/cirrus), copied from `packages/pds/src` at
commit `de476f57ba1fb936c6480a8fc278b6c7fc250cab` (2026-10-09) with the local
changes listed below. It signs repository commits over a SQLite-backed Merkle
search tree, sequences firehose events, encodes firehose frames, exports CAR
files, stages blobs in R2 and validates records.

Cirrus is MIT-licensed by Matt Kane, as declared in its
`packages/pds/package.json`. The upstream repository has no license file.

## Local changes

- `repo/blobs.ts`: `BlobStore` takes an optional key prefix and prepends it to
  every R2 key, so one bucket can keep each installation's blobs under its own
  prefix. Without a prefix, keys match upstream.
- `repo/blobs.ts`: `BlobStore.deleteStagedBlob` and `deleteBlob` delete a
  blob's staged and public copies. A host whose key prefix keeps R2 lifecycle
  rules from reaching `staged/` cleans up with them, and deletes a public copy
  once no record references it.

Each local change has a test that fails without it. Make any other engine fix
upstream, then refresh the copy. GSV code that wraps the engine lives outside
`src/cirrus/`. Lint ignores the copy so that it keeps upstream's style.

## Refreshing the copy

Check out the new upstream commit and copy the same files:

```bash
git clone https://github.com/ascorbic/cirrus /tmp/cirrus
git -C /tmp/cirrus checkout <commit>
src=/tmp/cirrus/packages/pds/src
cp "$src"/repo/{engine,storage,sequencer,blobs,firehose,sync,facet}.ts src/cirrus/repo/
cp "$src"/{validation,cbor-compat}.ts src/cirrus/
```

Then reapply the local changes that upstream does not have, update the commit
above, and pin the dependencies in `package.json` to the versions that
upstream's `pnpm-lock.yaml` resolves at that commit.

## Validation

```bash
npm run typecheck --workspace @humansandmachines/gsv-pds
npm test --workspace @humansandmachines/gsv-pds
```

The engine tests write and read records, verify each firehose commit the way
a sync 1.1 relay does, compare replayed frames with live ones, verify an
exported CAR file against the signing key, stage blobs in R2, delete them and
keep them under a key prefix.

The host tests register did:plc identities with an in-memory PLC directory
that applies plc.directory's log rules, and read every frame from the host
firehose as a relay does. They cover a lost directory response, writes that
overlap while blob storage is slow, a head that no event announced, delivery
retries with backoff, the blob lifecycle, cursor replay and retention, and the
XRPC reads, including an unknown DID that must not address any object.
