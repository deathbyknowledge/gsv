import {
  type ArchiveDataFrameInput,
  type ArchiveManifestV1,
  PORTABLE_ARCHIVE_FORMAT,
  canonicalJsonBytes,
  computeObjectSemanticDigestV1,
  encodeBase64Url,
} from "../src/index";

export async function createFixture(): Promise<{
  frames: readonly ArchiveDataFrameInput[];
  manifest: ArchiveManifestV1;
}> {
  const body = canonicalJsonBytes({ handle: "ada" });
  const frames: readonly ArchiveDataFrameInput[] = [
    {
      kind: "tenant",
      objectId: "tenant",
      part: 0,
      bodyMediaType: "application/json",
      body,
    },
  ];
  const digest = encodeBase64Url(
    await computeObjectSemanticDigestV1("tenant", frames),
  );
  const manifest: ArchiveManifestV1 = {
    format: PORTABLE_ARCHIVE_FORMAT,
    version: 1,
    archiveId: "01J00000000000000000000000",
    createdAt: "2026-07-16T10:00:00.000Z",
    source: {
      release: "v0.4.0+0123456789abcdef0123456789abcdef01234567",
      deployment: "managed",
    },
    consistency: {
      mode: "quiesced",
      frozenAt: "2026-07-16T10:00:00.000Z",
    },
    normalizationPolicyVersion: 1,
    requiredSchemaFeatures: [],
    inventory: [
      {
        objectId: "tenant",
        kind: "tenant",
        component: "gateway",
        logicalName: "ada.gsv.space",
        frameCount: "1",
        bodyBytes: body.byteLength.toString(),
        semanticSha256: digest,
        storage: {},
      },
    ],
    totals: {
      dataFrames: "1",
      dataBodyBytes: body.byteLength.toString(),
      r2Objects: "0",
      r2Bytes: "0",
    },
  };
  return { frames, manifest };
}

export async function* fragment(
  bytes: Uint8Array,
  size: number,
): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + size));
  }
}
