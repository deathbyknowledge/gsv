# GSV Cloudflare Release Contract

`@humansandmachines/gsv-cloudflare-release` is the public deployment boundary
between a GSV source release and any Cloudflare deployer. It describes immutable
artifacts and logical deployment intent. It does not contain account IDs,
concrete bucket or Worker names, credentials, tenant identity, rollout policy,
or fleet authorization.

The v1 descriptor records:

- the exact public source commit and release version;
- component ordering and hard deployment prerequisites;
- artifact filenames, byte sizes, and SHA-256 digests;
- logical persistent resources and Worker binding intents;
- compatibility dates and flags, entrypoints, and static asset policy;
- complete Durable Object migration steps and their canonical digest; and
- runtime-management and portable archive codec versions.

`dependsOn` contains hard deployment prerequisites. Service bindings separately
name their target component and can represent runtime relationships that are not
a deployment DAG.

## API

```ts
import {
  assertCloudflareReleaseChecksumInventory,
  prepareCloudflareWorkerBundle,
  verifyCloudflareReleaseChecksumManifest,
  verifyGsvCloudflareReleaseDescriptor,
} from "@humansandmachines/gsv-cloudflare-release";

const verifiedChecksums = await verifyCloudflareReleaseChecksumManifest(checksumBytes);
const verifiedDescriptor = await verifyGsvCloudflareReleaseDescriptor(
  descriptorBytes,
  verifiedChecksums.checksums,
);
const release = verifiedDescriptor.release;
assertCloudflareReleaseChecksumInventory(verifiedChecksums.checksums, release);
const artifactResponse = await fetch(artifactUrl);
if (!artifactResponse.body) throw new Error("Artifact response has no body");

const gateway = await prepareCloudflareWorkerBundle({
  release,
  componentId: "gateway",
  artifact: artifactResponse.body,
  limits: {
    maxCompressedBytes: 8 * 1024 * 1024,
    maxUncompressedBytes: 32 * 1024 * 1024,
    maxFiles: 20_000,
    maxFileBytes: 16 * 1024 * 1024,
    maxTotalFileBytes: 30 * 1024 * 1024,
  },
});
```

The checksum parser accepts only the canonical `sha256sum` form emitted by GSV:
lowercase SHA-256, two spaces, one safe filename, and an LF terminator for every
entry. It rejects duplicate filenames, comments, blank lines, alternate
separators, unsafe names, invalid UTF-8, and metadata beyond the public format
limit. An operator may pass an out-of-band checksum-manifest digest to
`verifyCloudflareReleaseChecksumManifest` as the release trust root.

Release descriptors likewise have one canonical UTF-8 JSON representation,
produced by `serializeGsvCloudflareRelease`. The descriptor verifier rejects
comments, trailing commas, duplicate keys at any depth, alternate JSON text,
invalid UTF-8, and metadata beyond the public format limit before returning a
semantically verified descriptor. It also recomputes every Durable Object
migration digest. `assertCloudflareReleaseChecksumInventory` then requires the
manifest to name exactly the descriptor and all declared artifacts, and checks
that every declared artifact digest agrees with the manifest.

These metadata APIs accept complete bounded byte arrays. The caller that
downloads them owns the response stream and must enforce its response timeout
and cancellation contract. Artifact streams remain owned end to end by
`prepareCloudflareWorkerBundle` once accepted.

`prepareCloudflareWorkerBundle` is the shared, runtime-agnostic artifact
consumer. It accepts `Uint8Array`, `ArrayBuffer`, a Web `ReadableStream`, or an
async iterable of byte chunks. It uses Web Crypto and `DecompressionStream`, so
the same API runs in Workers, modern browsers, and modern Node runtimes without
a Node-only archive dependency. The function owns an accepted stream through
completion. It consumes the exact compressed artifact before hash and format
validation, and cancels the stream if reading cannot finish because of a size,
source, or abort failure.

Callers choose every archive limit explicitly. There are no package defaults
because a self-hosted deployer and a multi-tenant control plane have different
memory budgets. The consumer enforces the descriptor's exact artifact size and
SHA-256 in addition to the caller's compressed, uncompressed, file-count,
per-file, and aggregate-file limits. Archives are strict ustar gzip: traversal,
non-canonical paths, duplicate paths, links, PAX or GNU extension records,
malformed checksums, truncated entries, and trailing data are rejected.

The prepared result contains deterministic Worker modules, static assets,
asset controls, compatibility data, Durable Object migrations, logical binding
intents, source deployment settings, and byte accounting. KV namespace IDs,
bucket names, service script names, credentials, account IDs, and hosted-service
policy are not returned. The deployer resolves logical resources and applies
its own naming, authorization, rollout, and telemetry policy.

### Migrating an existing deployer

Replace local gunzip, tar parsing, manifest parsing, Wrangler parsing, module
collection, and descriptor cross-checking with one call to
`prepareCloudflareWorkerBundle`. Keep provider API calls, resource-name
resolution, asset hashing and upload sessions, migration rollout decisions,
and service-specific policy in the deployer. In particular:

- use `mainModule` and `modules` for the Worker multipart upload;
- resolve `bindings` from their logical resources or target components;
- use `assets` and `assetConfig` for the static-assets upload flow;
- admit or replace `deploymentSettings` according to the deployer's policy; and
- use `statistics.retainedBytes` for aggregate release-memory accounting.

The JSON Schema is exported as
`@humansandmachines/gsv-cloudflare-release/schema.json`.

## Release generation

Normal GSV releases run `scripts/build-cloudflare-bundles.sh`. The script builds
the component bundles, computes their hashes, derives the descriptor from the
bundled manifests and Wrangler configs, then appends the descriptor hash to
`cloudflare-checksums.txt`.

Schema additions require a new schema version when an old strict validator
cannot accept them. Runtime and codec versions are negotiated fields and may
advance independently of the descriptor schema.
