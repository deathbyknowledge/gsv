import { describe, expect, it, vi } from "vitest";
import {
  INNER_MAGIC,
  PortableArchiveError,
  ZERO_SHA256,
  canonicalJsonBytes,
  concatBytes,
  decodeInnerArchive,
  decodeU32,
  encodeBase64Url,
  encodeInnerArchive,
  encodeU32,
  encodeU64,
  sha256Parts,
  validateInnerArchive,
  type ArchiveDataFrameInput,
} from "../src/index";
import { createFixture, fragment } from "./support";

describe("inner portable archive", () => {
  it("validates a fragmented hash-chained stream through its final manifest and trailer", async () => {
    const { frames, manifest } = await createFixture();
    const encoded = await encodeInnerArchive(frames, manifest);
    const visitor = vi.fn();
    const result = await validateInnerArchive(fragment(encoded, 1), { onFrame: visitor });
    expect(result.manifest).toEqual(manifest);
    expect(result.dataFrameCount).toBe(1);
    expect(result.frameCount).toBe(2);
    expect(result.dataBodyBytes).toBe(BigInt(frames[0].body.byteLength));
    expect(visitor).toHaveBeenCalledTimes(2);
    expect(result.manifestOffset).toBe(visitor.mock.calls[1][0].offset);
  });

  it("rejects body, sequence, chain, trailer, truncation, and trailing-data corruption", async () => {
    const { frames, manifest } = await createFixture();
    const encoded = await encodeInnerArchive(frames, manifest);
    const decoded = await decodeInnerArchive(encoded);

    const badBody = encoded.slice();
    const first = decoded.frames[0];
    const firstBodyOffset = Number(first.offset) + 12 + first.headerBytes.byteLength;
    badBody[firstBodyOffset] ^= 1;
    await expect(validateInnerArchive(badBody)).rejects.toMatchObject({
      code: "integrity_error",
    });

    const badSequence = encoded.slice();
    const firstHeaderOffset = Number(first.offset) + 12;
    const firstHeader = new TextDecoder().decode(first.headerBytes);
    const sequenceOffset = firstHeader.indexOf('"sequence":"0"') + '"sequence":"'.length;
    badSequence[firstHeaderOffset + sequenceOffset] = "1".charCodeAt(0);
    await expect(validateInnerArchive(badSequence)).rejects.toThrow(/sequence/);

    const manifestFrame = decoded.frames[1];
    const badChain = encoded.slice();
    const manifestHeaderOffset = Number(manifestFrame.offset) + 12;
    const manifestHeader = new TextDecoder().decode(manifestFrame.headerBytes);
    const chainOffset =
      manifestHeader.indexOf('"previousFrameDigest":"') +
      '"previousFrameDigest":"'.length;
    badChain[manifestHeaderOffset + chainOffset] =
      badChain[manifestHeaderOffset + chainOffset] === 65 ? 66 : 65;
    await expect(validateInnerArchive(badChain)).rejects.toMatchObject({
      code: "integrity_error",
    });

    const badTrailer = encoded.slice();
    badTrailer[badTrailer.byteLength - 1] ^= 1;
    await expect(validateInnerArchive(badTrailer)).rejects.toThrow(/manifest digest/);
    await expect(validateInnerArchive(encoded.subarray(0, encoded.byteLength - 1))).rejects.toMatchObject({
      code: "truncated_archive",
    });
    const trailing = new Uint8Array(encoded.byteLength + 1);
    trailing.set(encoded);
    await expect(validateInnerArchive(trailing)).rejects.toMatchObject({
      code: "trailing_data",
    });
  });

  it("rejects noncanonical headers and configured limit violations before allocation", async () => {
    const { frames, manifest } = await createFixture();
    const encoded = await encodeInnerArchive(frames, manifest);
    const headerLengthOffset = INNER_MAGIC.byteLength;
    const headerLength = decodeU32(encoded.subarray(headerLengthOffset, headerLengthOffset + 4));
    const headerOffset = headerLengthOffset + 12;
    const noncanonical = new Uint8Array(encoded.byteLength + 1);
    noncanonical.set(encoded.subarray(0, headerLengthOffset));
    noncanonical.set(encodeU32(headerLength + 1), headerLengthOffset);
    noncanonical.set(encoded.subarray(headerLengthOffset + 4, headerOffset), headerLengthOffset + 4);
    noncanonical[headerOffset] = 0x20;
    noncanonical.set(encoded.subarray(headerOffset), headerOffset + 1);
    await expect(validateInnerArchive(noncanonical)).rejects.toBeInstanceOf(
      PortableArchiveError,
    );
    await expect(validateInnerArchive(encoded, { maxBodyBytes: 8 })).rejects.toMatchObject({
      code: "limit_exceeded",
    });
  });

  it("closes its byte source after parse and frame-visitor failures", async () => {
    const invalid = trackedSource([new Uint8Array(INNER_MAGIC.byteLength)]);
    await expect(validateInnerArchive(invalid.source)).rejects.toMatchObject({
      code: "invalid_magic",
    });
    expect(invalid.closed()).toBe(true);

    const { frames, manifest } = await createFixture();
    const encoded = await encodeInnerArchive(frames, manifest);
    const rejected = trackedSource([encoded]);
    await expect(validateInnerArchive(rejected.source, {
      onFrame() {
        throw new Error("visitor rejected frame");
      },
    })).rejects.toThrow("visitor rejected frame");
    expect(rejected.closed()).toBe(true);
  });

  it("requires the manifest inventory to exactly cover every data frame", async () => {
    const { frames, manifest } = await createFixture();
    const inconsistent = {
      ...manifest,
      totals: { ...manifest.totals, dataFrames: "2" },
    };
    await expect(encodeInnerArchive(frames, inconsistent)).rejects.toThrow(/inventory sum/);

    const lyingDigest = {
      ...manifest,
      inventory: manifest.inventory.map((item) => ({
        ...item,
        semanticSha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      })),
    };
    await expect(encodeInnerArchive(frames, lyingDigest)).rejects.toThrow(
      /semantic digest/,
    );
  });

  it("rejects interleaved logical object runs in both encoder and validator", async () => {
    const { manifest } = await createFixture();
    const interleaved: ArchiveDataFrameInput[] = [
      dataFrame("object-a", "r2.descriptor", 0, [1]),
      dataFrame("object-b", "r2.descriptor", 0, [2]),
      dataFrame("object-a", "r2.body", 0, [3]),
    ];

    await expect(encodeInnerArchive(interleaved, manifest)).rejects.toThrow(
      "one contiguous run",
    );
    const legacyBytes = await encodeUnterminatedDataFrames(interleaved);
    await expect(validateInnerArchive(legacyBytes)).rejects.toThrow(
      "one contiguous run",
    );
  });
});

function dataFrame(
  objectId: string,
  kind: ArchiveDataFrameInput["kind"],
  part: number,
  body: readonly number[],
): ArchiveDataFrameInput {
  return {
    objectId,
    kind,
    part,
    bodyMediaType: "application/octet-stream",
    body: new Uint8Array(body),
  };
}

async function encodeUnterminatedDataFrames(
  frames: readonly ArchiveDataFrameInput[],
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [INNER_MAGIC];
  let previousDigest = ZERO_SHA256;
  for (let sequence = 0; sequence < frames.length; sequence += 1) {
    const frame = frames[sequence]!;
    const headerBytes = canonicalJsonBytes({
      bodyEncoding: "identity",
      bodyMediaType: frame.bodyMediaType,
      bodySha256: encodeBase64Url(await sha256Parts([frame.body])),
      kind: frame.kind,
      objectId: frame.objectId,
      part: frame.part,
      previousFrameDigest: encodeBase64Url(previousDigest),
      sequence: sequence.toString(),
    });
    const headerLength = encodeU32(headerBytes.byteLength);
    const bodyLength = encodeU64(BigInt(frame.body.byteLength));
    parts.push(headerLength, bodyLength, headerBytes, frame.body);
    previousDigest = await sha256Parts([
      headerLength,
      bodyLength,
      headerBytes,
      frame.body,
    ]);
  }
  return concatBytes(parts);
}

function trackedSource(chunks: readonly Uint8Array[]): Readonly<{
  source: AsyncGenerator<Uint8Array>;
  closed(): boolean;
}> {
  let closed = false;
  const source = (async function* () {
    try {
      for (const chunk of chunks) yield chunk;
    } finally {
      closed = true;
    }
  })();
  return { source, closed: () => closed };
}
