# PDS

The PDS worker hosts each Ship's public ATProto repository. `src/host/` is the
host. One `HostedRepo` Durable Object per account holds its did:plc, signed
repository, blobs and firehose outbox. One `HostFirehose` object numbers every
repository's events into the host's firehose and keeps the directory of hosted
repositories. `handleXrpc` serves public reads, sending each repository read to
the object that holds the repository. The host imports nothing from GSV.

`src/gsv/` connects the host to a GSV deployment. Each installation's
repository object is named by its installation ID and keeps its blobs under
`installations/<id>/`. `PdsPublisherEntrypoint` hands the Kernel its
installation's repository when the binding carries the `kernel-publish`
authority and Accounts reports the installation active. A new account takes
only a handle that Accounts routes to the same installation. Public reads
serve an active installation's repository; a retired one reads as deleted and
any other state as suspended. Nothing deploys the worker yet.

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
- `repo/blobs.ts`: `BlobStore.putStaged` streams an upload into `staged/` under
  a name the host chooses, and `getStagedBlob`, `promoteBlob` and
  `deleteStagedBlob` take that name. A streamed upload's CID is only known once
  every byte has arrived.

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

Uploads stream in with a declared size, up to 48 MiB. The host hashes the bytes
as they arrive, names the staged copy by the resulting CID, and keeps one
staged copy for identical uploads. An upload that ends early, runs long or has
no plain MIME type stores nothing. Its staged record expires with every other
unreferenced upload, after six hours. The account can read an upload back
before any record publishes it.

The GSV tests use an in-memory Accounts directory. They cover the publishing
authority, installations that are not active, the handles a new account may
take, the installation's blob prefix, and how each installation state reads.

## Smoke check

```bash
GOAT=/path/to/goat npm run smoke --workspace @humansandmachines/gsv-pds
```

The smoke check runs a clean local host and checks it with
[goat](https://github.com/bluesky-social/goat), the reference ATProto CLI. One
wrangler session runs the host from `src/index.ts`. A second runs
`smoke/worker.ts`, which stands in for the PLC directory, Accounts and the
Kernel's publisher binding. The run creates an account, uploads a small blob and a
48 MiB one across the service binding, and creates, updates and deletes records
in three commits. goat then resolves the
DID, exports and inspects the repository, reads the records, downloads both
blobs (the large one must hash to its CID), and lists the host's accounts. It also follows the firehose live and from cursor 0,
verifying each commit's signature and MST.

goat 0.2.5 and later refuse loopback addresses, so `GOAT` must name a goat
0.2.4 binary.
