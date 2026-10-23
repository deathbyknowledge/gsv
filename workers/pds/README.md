# PDS repository engine

`src/cirrus/` is the ATProto repository engine from
[Cirrus](https://github.com/ascorbic/cirrus), copied from `packages/pds/src` at
commit `de476f57ba1fb936c6480a8fc278b6c7fc250cab` (2026-10-09) with the local
changes listed below. It signs repository commits over a SQLite-backed Merkle
search tree, sequences firehose events, encodes firehose frames, exports CAR
files, stages blobs in R2 and validates records. Nothing deploys it yet; the
tests host it in a SQLite Durable Object.

Cirrus is MIT-licensed by Matt Kane, as declared in its
`packages/pds/package.json`. The upstream repository has no license file.

## Local changes

- `repo/blobs.ts`: `BlobStore` takes an optional key prefix and prepends it to
  every R2 key, so one bucket can keep each installation's blobs under its own
  prefix. Without a prefix, keys match upstream.

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

The smoke tests write and read records, verify each firehose commit the way a
sync 1.1 relay does, compare replayed frames with live ones, verify an
exported CAR file against the signing key, stage blobs in R2 and keep blobs
under a key prefix.
