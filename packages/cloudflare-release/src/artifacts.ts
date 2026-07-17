import {
  getNodeValue,
  parseTree,
  type Node,
  type ParseError,
} from "jsonc-parser";

import { canonicalJson } from "./canonical.js";
import type { GsvCloudflareRelease } from "./types.js";
import {
  assertGsvCloudflareRelease,
  verifyGsvCloudflareRelease,
} from "./validate.js";

export const GSV_CLOUDFLARE_RELEASE_DESCRIPTOR_FILE =
  "gsv-cloudflare-release.json" as const;
export const GSV_CLOUDFLARE_RELEASE_CHECKSUM_MANIFEST_FILE =
  "cloudflare-checksums.txt" as const;
export const GSV_CLOUDFLARE_RELEASE_DESCRIPTOR_MAX_BYTES = 1024 * 1024;
export const GSV_CLOUDFLARE_RELEASE_CHECKSUM_MANIFEST_MAX_BYTES = 256 * 1024;

export type CloudflareReleaseChecksums = ReadonlyMap<string, string>;

export type VerifiedCloudflareReleaseChecksumManifest = Readonly<{
  sha256: string;
  checksums: CloudflareReleaseChecksums;
}>;

export type VerifiedCloudflareReleaseArtifact = Readonly<{
  fileName: string;
  sha256: string;
  bytes: Uint8Array;
}>;

export type VerifiedGsvCloudflareReleaseDescriptor = Readonly<{
  release: GsvCloudflareRelease;
  sha256: string;
  bytes: Uint8Array;
}>;

const encoder = new TextEncoder();
const CHECKSUM_LINE = /^([0-9a-f]{64})  (.+)$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

/** Serialize a validated release descriptor to its one canonical wire form. */
export function serializeGsvCloudflareRelease(
  release: GsvCloudflareRelease,
): string {
  assertGsvCloudflareRelease(release);
  return `${canonicalJson(release)}\n`;
}

/**
 * Decode, structurally verify, and verify the canonical bytes of a public
 * release descriptor. The fixed metadata limit is part of the v1 wire
 * contract; artifact payload limits remain consumer policy.
 */
export async function parseGsvCloudflareReleaseDescriptor(
  bytes: Uint8Array,
): Promise<GsvCloudflareRelease> {
  assertMaximumBytes(
    bytes,
    GSV_CLOUDFLARE_RELEASE_DESCRIPTOR_MAX_BYTES,
    "Cloudflare release descriptor",
  );
  const text = decodeUtf8(bytes, "Cloudflare release descriptor");
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, {
    allowEmptyContent: false,
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (!tree || errors.length > 0) {
    throw new Error("Cloudflare release descriptor is not strict JSON");
  }
  assertUniqueJsonKeys(tree, "Cloudflare release descriptor");
  const release = await verifyGsvCloudflareRelease(getNodeValue(tree));
  if (text !== serializeGsvCloudflareRelease(release)) {
    throw new Error("Cloudflare release descriptor is not canonical JSON");
  }
  return release;
}

/** Parse the canonical sha256sum-compatible release checksum manifest. */
export function parseCloudflareReleaseChecksumManifest(
  content: string,
): CloudflareReleaseChecksums {
  const bytes = encoder.encode(content);
  assertMaximumBytes(
    bytes,
    GSV_CLOUDFLARE_RELEASE_CHECKSUM_MANIFEST_MAX_BYTES,
    "Cloudflare release checksum manifest",
  );
  if (!content.endsWith("\n")) {
    throw new Error("Cloudflare release checksum manifest is not canonical text");
  }

  const lines = content.slice(0, -1).split("\n");
  if (lines.length === 1 && lines[0] === "") {
    throw new Error("Cloudflare release checksum manifest is empty");
  }

  const checksums = new Map<string, string>();
  for (let index = 0; index < lines.length; index += 1) {
    const match = CHECKSUM_LINE.exec(lines[index]!);
    if (!match) {
      throw new Error(`Cloudflare release checksum manifest line ${index + 1} is invalid`);
    }
    const [, sha256, fileName] = match;
    assertReleaseFileName(fileName!);
    if (checksums.has(fileName!)) {
      throw new Error(`Cloudflare release checksum manifest repeats ${fileName}`);
    }
    checksums.set(fileName!, sha256!);
  }
  return checksums;
}

/** Decode and hash the checksum manifest, optionally against an out-of-band pin. */
export async function verifyCloudflareReleaseChecksumManifest(
  bytes: Uint8Array,
  expectedSha256?: string,
): Promise<VerifiedCloudflareReleaseChecksumManifest> {
  assertMaximumBytes(
    bytes,
    GSV_CLOUDFLARE_RELEASE_CHECKSUM_MANIFEST_MAX_BYTES,
    "Cloudflare release checksum manifest",
  );
  const sha256 = await sha256BytesHex(bytes);
  if (expectedSha256 !== undefined) {
    assertSha256(expectedSha256, "Expected Cloudflare release checksum manifest SHA-256");
    if (!constantTimeHexEqual(sha256, expectedSha256)) {
      throw new Error("Cloudflare release checksum manifest digest mismatch");
    }
  }
  return Object.freeze({
    sha256,
    checksums: parseCloudflareReleaseChecksumManifest(
      decodeUtf8(bytes, "Cloudflare release checksum manifest"),
    ),
  });
}

/** Verify one immutable release file against its checksum-manifest entry. */
export async function verifyCloudflareReleaseArtifact(
  fileName: string,
  bytes: Uint8Array,
  checksums: CloudflareReleaseChecksums,
): Promise<VerifiedCloudflareReleaseArtifact> {
  assertReleaseFileName(fileName);
  const expected = checksums.get(fileName);
  if (!expected) {
    throw new Error(`Cloudflare release checksum manifest is missing ${fileName}`);
  }
  assertSha256(expected, `Cloudflare release checksum for ${fileName}`);
  const sha256 = await sha256BytesHex(bytes);
  if (!constantTimeHexEqual(sha256, expected)) {
    throw new Error(`Cloudflare release checksum mismatch for ${fileName}`);
  }
  return Object.freeze({ fileName, sha256, bytes: bytes.slice() });
}

/** Verify and parse the descriptor named by the public checksum manifest. */
export async function verifyGsvCloudflareReleaseDescriptor(
  bytes: Uint8Array,
  checksums: CloudflareReleaseChecksums,
): Promise<VerifiedGsvCloudflareReleaseDescriptor> {
  assertMaximumBytes(
    bytes,
    GSV_CLOUDFLARE_RELEASE_DESCRIPTOR_MAX_BYTES,
    "Cloudflare release descriptor",
  );
  const artifact = await verifyCloudflareReleaseArtifact(
    GSV_CLOUDFLARE_RELEASE_DESCRIPTOR_FILE,
    bytes,
    checksums,
  );
  const release = await parseGsvCloudflareReleaseDescriptor(artifact.bytes);
  return Object.freeze({ release, sha256: artifact.sha256, bytes: artifact.bytes });
}

/**
 * Require the checksum manifest to describe exactly the descriptor and every
 * artifact declared by that descriptor, with matching artifact digests.
 */
export function assertCloudflareReleaseChecksumInventory(
  checksums: CloudflareReleaseChecksums,
  release: GsvCloudflareRelease,
): void {
  assertGsvCloudflareRelease(release);
  const expectedFiles = new Set([
    GSV_CLOUDFLARE_RELEASE_DESCRIPTOR_FILE,
    ...release.components.map((component) => component.artifact.file),
  ]);
  if (
    checksums.size !== expectedFiles.size
    || [...checksums.keys()].some((fileName) => !expectedFiles.has(fileName))
  ) {
    throw new Error(
      "Cloudflare release checksum manifest does not match the descriptor artifact inventory",
    );
  }
  assertSha256(
    checksums.get(GSV_CLOUDFLARE_RELEASE_DESCRIPTOR_FILE)!,
    "Cloudflare release descriptor checksum",
  );
  for (const component of release.components) {
    const actual = checksums.get(component.artifact.file);
    if (actual !== component.artifact.sha256) {
      throw new Error(
        `Cloudflare release descriptor checksum does not match ${component.artifact.file}`,
      );
    }
  }
}

/** Hash exact bytes without applying JSON canonicalization. */
export async function sha256BytesHex(bytes: Uint8Array): Promise<string> {
  const copy = bytes.slice();
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
}

function assertUniqueJsonKeys(node: Node, label: string): void {
  if (node.type === "object") {
    const names = (node.children ?? []).map((property) => {
      if (property.type !== "property" || property.children?.[0]?.type !== "string") {
        throw new Error(`${label} contains an invalid object member`);
      }
      return property.children[0].value as string;
    });
    if (new Set(names).size !== names.length) {
      throw new Error(`${label} contains a duplicate field`);
    }
  }
  for (const child of node.children ?? []) assertUniqueJsonKeys(child, label);
}

function assertReleaseFileName(fileName: string): void {
  if (
    fileName.length === 0
    || fileName.length > 512
    || fileName.trim() !== fileName
    || fileName === "."
    || fileName === ".."
    || fileName.includes("/")
    || fileName.includes("\\")
    || CONTROL_CHARACTER.test(fileName)
  ) {
    throw new Error("Cloudflare release checksum manifest contains an invalid filename");
  }
}

function assertMaximumBytes(bytes: Uint8Array, maximum: number, label: string): void {
  if (bytes.byteLength > maximum) throw new Error(`${label} exceeds its format limit`);
}

function assertSha256(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} is invalid`);
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
