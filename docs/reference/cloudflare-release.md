# Cloudflare release contract

Every GSV release with Cloudflare bundles publishes
`gsv-cloudflare-release.json`. This is the public, versioned deployment contract
shared by self-hosted tooling and services that deploy GSV for users.

The descriptor is deliberately provider-ID-free. It contains the public source
commit, component topology, immutable artifact hashes and sizes, logical
resource and binding intents, Worker compatibility settings, entrypoints and
assets, Durable Object migrations, and runtime portability versions. A deployer
chooses concrete Worker and storage names in its own account.

Private service concerns do not belong in this file. In particular it cannot
express tenant identity, credentials, account IDs, billing, release approval,
rollout policy, or fleet authorization.

## Verification

A consumer must:

1. Parse and hash `cloudflare-checksums.txt` with
   `verifyCloudflareReleaseChecksumManifest`, optionally checking its digest
   against an out-of-band operator pin.
2. Pass the descriptor bytes and parsed checksums to
   `verifyGsvCloudflareReleaseDescriptor`. This verifies the descriptor's
   checksum, strict canonical JSON, unique keys, public metadata size limit,
   semantic invariants, and every inline Durable Object migration digest.
3. Call `assertCloudflareReleaseChecksumInventory` to require exactly the
   descriptor and its declared artifacts, with matching digests.
4. Verify every selected component artifact against the descriptor before
   extracting or uploading it.
5. Apply components in `deployOrder`, satisfying each hard `dependsOn`
   prerequisite first.

The checksum manifest itself is canonical lowercase `sha256sum` text with two
spaces before each safe filename and an LF after every entry. Release descriptor
text has one canonical UTF-8 JSON representation, produced by
`serializeGsvCloudflareRelease`. Alternate whitespace or key ordering, comments,
trailing commas, duplicate keys, a byte-order mark, invalid UTF-8, and oversized
metadata are rejected. Consumers must bound, consume, and cancel the HTTP body
before passing complete metadata bytes to these helpers.

The bundled JSON Schema is for structural validation, editor support, and
documentation. It does not enforce every release invariant, including
sorted-unique identity sets, cross-references and resource-kind matching,
deployment ordering and dependency semantics, or migration-tag uniqueness.
A consumer must not use JSON Schema validation alone to admit a release.

TypeScript deployers should use `prepareCloudflareWorkerBundle` from the same
package for step 4 and bundle preparation. It accepts bytes, Web byte streams,
or async byte iterables; requires explicit compressed, uncompressed, file-count,
per-file, and aggregate-file limits; and returns deterministic Worker modules,
assets, logical bindings, migrations, and deployment settings. It consumes or
cancels the supplied stream to one terminal outcome and rejects path traversal,
duplicate paths, links, unsupported tar records, malformed gzip or tar data,
and descriptor mismatches.

The prepared binding inventory deliberately omits concrete KV IDs, bucket
names, and service script names. A deployer resolves logical resources into its
own account and naming scheme. Hosted-service admission, tenant authorization,
rollout, and telemetry policy remain outside the public package.

Service bindings describe runtime component relationships. They are not all
hard deployment prerequisites and may therefore point to a component later in
the deployment order. The current gateway declares channel adapter service
bindings unconditionally, so the three channel Workers are required release
components and hard gateway deployment prerequisites. A future release may make
an adapter optional only after making its gateway binding optional in the same
public contract.

For structural validation and tooling, the v1 JSON Schema is available from
the public package export
`@humansandmachines/gsv-cloudflare-release/schema.json` and from its canonical
URL, `https://gsv.space/schemas/gsv-cloudflare-release-v1.schema.json`.
