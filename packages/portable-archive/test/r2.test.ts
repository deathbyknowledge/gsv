import { describe, expect, it, vi } from "vitest";
import {
  MAX_FRAME_BODY_BYTES,
  R2_BODY_PART_BYTES,
  R2_LOGICAL_SNAPSHOT_SCHEMA_FEATURE,
  canonicalJsonBytes,
  createPortableR2Descriptor,
  decodePortableR2DescriptorFrame,
  encodePortableR2DescriptorFrame,
  parseCanonicalJson,
  portableR2BodyStream,
  snapshotPortableR2Object,
  type ArchiveDataFrameInput,
  type PortableR2CodecError,
  type PortableR2SourceObject,
} from "../src/index";

describe("portable R2 logical snapshot v1", () => {
  it("emits canonical metadata and deterministic fixed-size body parts", async () => {
    const bytes = patternedBytes(R2_BODY_PART_BYTES + 3);
    const object = descriptor("home/ada/π.txt", bytes.byteLength, {
      cacheControl: "private, max-age=60",
      cacheExpiry: "2026-07-16T12:00:00.000Z",
      contentType: "text/plain; charset=utf-8",
    }, { owner: "Ada Lovelace", note: "café" });
    const frames = await collect(snapshotPortableR2Object({
      objectId: "r2:object-sha256",
      object,
      response: bodyResponse(bytes, [7, R2_BODY_PART_BYTES - 2, 5]),
    }));

    expect(R2_LOGICAL_SNAPSHOT_SCHEMA_FEATURE).toBe("gsv-r2-logical-snapshot-v1");
    expect(R2_BODY_PART_BYTES).toBe(MAX_FRAME_BODY_BYTES);
    expect(frames.map((frame) => [frame.kind, frame.part, frame.body.byteLength])).toEqual([
      ["r2.descriptor", 0, frames[0]!.body.byteLength],
      ["r2.body", 0, R2_BODY_PART_BYTES],
      ["r2.body", 1, 3],
    ]);
    expect(decodePortableR2DescriptorFrame(frames[0]!)).toEqual({
      format: "gsv-r2-logical-snapshot",
      version: 1,
      record: "object",
      objectId: "r2:object-sha256",
      key: "home/ada/π.txt",
      size: String(bytes.byteLength),
      bodyParts: "2",
      storageClass: "Standard",
      encryption: "provider-managed",
      httpMetadata: {
        cacheControl: "private, max-age=60",
        cacheExpiry: "2026-07-16T12:00:00.000Z",
        contentDisposition: null,
        contentEncoding: null,
        contentLanguage: null,
        contentType: "text/plain; charset=utf-8",
      },
      customMetadata: { note: "café", owner: "Ada Lovelace" },
    });
    const canonicalDescriptor = parseCanonicalJson(frames[0]!.body) as Record<string, unknown>;
    expect(Object.keys(canonicalDescriptor)).toEqual([
      "bodyParts",
      "customMetadata",
      "encryption",
      "format",
      "httpMetadata",
      "key",
      "objectId",
      "record",
      "size",
      "storageClass",
      "version",
    ]);
  });

  it("owns source responses on validation failure and early iterator stop", async () => {
    const invalidCancel = vi.fn();
    const invalid = snapshotPortableR2Object({
      objectId: "r2:invalid",
      object: descriptor("bad\u0000key", 1),
      response: new Response(new ReadableStream({ cancel: invalidCancel })),
    });
    await expect(invalid.next()).rejects.toMatchObject({
      code: "unsupported_object",
    } satisfies Partial<PortableR2CodecError>);
    expect(invalidCancel).toHaveBeenCalledOnce();

    const stoppedCancel = vi.fn();
    const stopped = snapshotPortableR2Object({
      objectId: "r2:stopped",
      object: descriptor("stopped", 1),
      response: new Response(new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
        cancel: stoppedCancel,
      })),
    });
    await expect(stopped.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "r2.descriptor" },
    });
    await stopped.return(undefined);
    expect(stoppedCancel).toHaveBeenCalledOnce();
  });

  it("fails closed on truncated bodies and non-portable metadata", async () => {
    await expect(collect(snapshotPortableR2Object({
      objectId: "r2:short",
      object: descriptor("short", 2),
      response: new Response(new Uint8Array([1])),
    }))).rejects.toMatchObject({ code: "body_mismatch" });

    expect(() => createPortableR2Descriptor(
      "r2:uppercase-meta",
      descriptor("key", 0, {}, { Owner: "ada" }),
    )).toThrow("lowercase ASCII");
    expect(() => createPortableR2Descriptor(
      "r2:subsecond-expiry",
      descriptor("key", 0, { cacheExpiry: "2026-07-16T12:00:00.001Z" }),
    )).toThrow("sub-second");
  });

  it("rejects noncanonical and structurally inconsistent descriptors", () => {
    const frame = encodePortableR2DescriptorFrame(
      "r2:descriptor",
      descriptor("home/file", 1),
    );
    const decoded = parseCanonicalJson(frame.body) as Record<string, unknown>;
    const noncanonicalValue = Object.fromEntries(Object.entries(decoded).reverse());
    expect(() => decodePortableR2DescriptorFrame({
      ...frame,
      body: new TextEncoder().encode(JSON.stringify(noncanonicalValue)),
    })).toThrow("canonical");

    expect(() => decodePortableR2DescriptorFrame({
      ...frame,
      body: canonicalJsonBytes({ ...decoded, bodyParts: "2" }),
    })).toThrow("part count");
  });

  it("reassembles exact bodies and closes a rejected frame source", async () => {
    const bytes = patternedBytes(5);
    const frames = await collect(snapshotPortableR2Object({
      objectId: "r2:stream",
      object: descriptor("home/file", bytes.byteLength),
      response: bodyResponse(bytes, [2, 3]),
    }));
    const descriptorValue = decodePortableR2DescriptorFrame(frames[0]!);
    await expect(readStream(portableR2BodyStream(
      descriptorValue,
      frames.slice(1),
    ))).resolves.toEqual(bytes);

    const closed = vi.fn();
    async function* wrongFrames(): AsyncGenerator<ArchiveDataFrameInput> {
      try {
        yield { ...frames[1]!, part: 1 };
      } finally {
        closed();
      }
    }
    await expect(readStream(portableR2BodyStream(
      descriptorValue,
      wrongFrames(),
    ))).rejects.toMatchObject({ code: "body_mismatch" });
    expect(closed).toHaveBeenCalledOnce();
  });

  it("treats object size as format data rather than a provider quota", () => {
    const logicalSize = 1_000_000_000;
    expect(createPortableR2Descriptor(
      "r2:public-codec",
      descriptor("large-but-representable", logicalSize),
    )).toMatchObject({
      size: String(logicalSize),
      bodyParts: String(Math.ceil(logicalSize / R2_BODY_PART_BYTES)),
    });
  });
});

function descriptor(
  key: string,
  size: number,
  httpMetadata: PortableR2SourceObject["httpMetadata"] = {},
  customMetadata: Readonly<Record<string, string>> = {},
): PortableR2SourceObject {
  return {
    key,
    size,
    httpMetadata,
    customMetadata,
    storageClass: "Standard",
  };
}

function patternedBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = index % 251;
  return bytes;
}

function bodyResponse(bytes: Uint8Array, chunkSizes: readonly number[]): Response {
  let offset = 0;
  let chunkIndex = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const requested = chunkSizes[chunkIndex] ?? bytes.byteLength;
      chunkIndex += 1;
      const length = Math.min(requested, bytes.byteLength - offset);
      controller.enqueue(bytes.subarray(offset, offset + length));
      offset += length;
    },
  }), { headers: { "content-length": String(bytes.byteLength) } });
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      size += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
