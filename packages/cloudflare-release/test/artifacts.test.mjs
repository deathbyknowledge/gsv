import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertCloudflareReleaseChecksumInventory,
  GSV_CLOUDFLARE_RELEASE_DESCRIPTOR_FILE,
  GSV_CLOUDFLARE_RELEASE_DESCRIPTOR_MAX_BYTES,
  parseCloudflareReleaseChecksumManifest,
  parseGsvCloudflareReleaseDescriptor,
  serializeGsvCloudflareRelease,
  sha256BytesHex,
  verifyCloudflareReleaseArtifact,
  verifyCloudflareReleaseChecksumManifest,
  verifyGsvCloudflareReleaseDescriptor,
} from "../dist/index.js";

const fixtureUrl = new URL("./fixtures/gsv-cloudflare-release-v1.json", import.meta.url);
const encoder = new TextEncoder();

async function fixture() {
  return JSON.parse(await readFile(fixtureUrl, "utf8"));
}

test("round trips the one canonical release descriptor representation", async () => {
  const release = await fixture();
  const text = serializeGsvCloudflareRelease(release);
  const bytes = encoder.encode(text);

  const parsed = await parseGsvCloudflareReleaseDescriptor(bytes);
  assert.equal(serializeGsvCloudflareRelease(parsed), text);
  assert.equal(text.endsWith("\n"), true);
  assert.equal(text.includes("\n", 0), true);
  assert.equal(text.split("\n").length, 2);
});

test("rejects duplicate, relaxed, noncanonical, invalid UTF-8, and oversized descriptors", async () => {
  const release = await fixture();
  const canonical = serializeGsvCloudflareRelease(release);
  const duplicate = canonical.replace(
    '"format":"gsv-cloudflare-release"',
    '"format":"gsv-cloudflare-release","format":"gsv-cloudflare-release"',
  );

  await assert.rejects(
    () => parseGsvCloudflareReleaseDescriptor(encoder.encode(duplicate)),
    /duplicate field/u,
  );
  await assert.rejects(
    () => parseGsvCloudflareReleaseDescriptor(encoder.encode(` ${canonical}`)),
    /not canonical JSON/u,
  );
  await assert.rejects(
    () => parseGsvCloudflareReleaseDescriptor(encoder.encode(`\ufeff${canonical}`)),
    /(not strict|not canonical) JSON/u,
  );
  await assert.rejects(
    () => parseGsvCloudflareReleaseDescriptor(encoder.encode(`${canonical.slice(0, -2)},}\n`)),
    /not strict JSON/u,
  );
  await assert.rejects(
    () => parseGsvCloudflareReleaseDescriptor(Uint8Array.of(0xff)),
    /not valid UTF-8/u,
  );
  await assert.rejects(
    () => parseGsvCloudflareReleaseDescriptor(
      new Uint8Array(GSV_CLOUDFLARE_RELEASE_DESCRIPTOR_MAX_BYTES + 1),
    ),
    /format limit/u,
  );
});

test("parses only canonical checksum manifests and verifies their pinned digest", async () => {
  const artifact = encoder.encode("artifact");
  const artifactSha256 = await sha256BytesHex(artifact);
  const text = `${artifactSha256}  bundle.tar.gz\n`;
  const bytes = encoder.encode(text);
  const manifestSha256 = await sha256BytesHex(bytes);

  const checksums = parseCloudflareReleaseChecksumManifest(text);
  assert.equal(checksums.get("bundle.tar.gz"), artifactSha256);
  assert.deepEqual(
    await verifyCloudflareReleaseChecksumManifest(bytes, manifestSha256),
    { sha256: manifestSha256, checksums },
  );
  await assert.rejects(
    () => verifyCloudflareReleaseChecksumManifest(bytes, "f".repeat(64)),
    /digest mismatch/u,
  );

  for (const invalid of [
    `${artifactSha256.toUpperCase()}  bundle.tar.gz\n`,
    `${artifactSha256}\tbundle.tar.gz\n`,
    `${artifactSha256}  bundle.tar.gz\r\n`,
    `${artifactSha256}  bundle.tar.gz`,
    `# generated\n${artifactSha256}  bundle.tar.gz\n`,
    `${artifactSha256}  ../bundle.tar.gz\n`,
    `${artifactSha256}  bundle.tar.gz\n\n`,
  ]) {
    assert.throws(() => parseCloudflareReleaseChecksumManifest(invalid));
  }
  assert.throws(
    () => parseCloudflareReleaseChecksumManifest(`${text}${text}`),
    /repeats/u,
  );
});

test("verifies exact artifacts, canonical descriptors, and descriptor inventory", async () => {
  const release = await fixture();
  const descriptorBytes = encoder.encode(serializeGsvCloudflareRelease(release));
  const descriptorSha256 = await sha256BytesHex(descriptorBytes);
  const checksums = new Map([
    [GSV_CLOUDFLARE_RELEASE_DESCRIPTOR_FILE, descriptorSha256],
    ...release.components.map((component) => [
      component.artifact.file,
      component.artifact.sha256,
    ]),
  ]);

  const verified = await verifyGsvCloudflareReleaseDescriptor(descriptorBytes, checksums);
  assert.equal(verified.release.releaseVersion, release.releaseVersion);
  assert.equal(verified.sha256, descriptorSha256);
  assertCloudflareReleaseChecksumInventory(checksums, verified.release);

  const artifact = encoder.encode("artifact");
  const artifactChecksums = new Map([["bundle.tar.gz", await sha256BytesHex(artifact)]]);
  assert.deepEqual(
    await verifyCloudflareReleaseArtifact("bundle.tar.gz", artifact, artifactChecksums),
    {
      fileName: "bundle.tar.gz",
      sha256: artifactChecksums.get("bundle.tar.gz"),
      bytes: artifact,
    },
  );
  await assert.rejects(
    () => verifyCloudflareReleaseArtifact(
      "bundle.tar.gz",
      encoder.encode("corrupt"),
      artifactChecksums,
    ),
    /checksum mismatch/u,
  );

  const extra = new Map(checksums);
  extra.set("unlisted.tar.gz", "a".repeat(64));
  assert.throws(
    () => assertCloudflareReleaseChecksumInventory(extra, release),
    /artifact inventory/u,
  );
  const mismatch = new Map(checksums);
  mismatch.set(release.components[0].artifact.file, "c".repeat(64));
  assert.throws(
    () => assertCloudflareReleaseChecksumInventory(mismatch, release),
    /descriptor checksum/u,
  );
});
