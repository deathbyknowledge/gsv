import { describe, expect, it, vi } from "vitest";
import {
  MAX_FRAME_BODY_BYTES,
  WORKERS_KV_LOGICAL_SNAPSHOT_SCHEMA_FEATURE,
  WORKERS_KV_VALUE_PART_BYTES,
  canonicalJsonBytes,
  createPortableWorkersKvDescriptor,
  decodePortableWorkersKvDescriptorFrame,
  encodePortableWorkersKvDescriptorFrame,
  parseCanonicalJson,
  portableWorkersKvValueStream,
  snapshotPortableWorkersKvEntry,
  type ArchiveDataFrameInput,
  type PortableWorkersKvCodecError,
  type PortableWorkersKvSourceEntry,
} from "../src/index";

describe("portable Workers KV logical snapshot v1", () => {
  it("emits canonical metadata and deterministic fixed-size value parts", async () => {
    const bytes = patternedBytes(WORKERS_KV_VALUE_PART_BYTES + 3);
    const frames = await collect(snapshotPortableWorkersKvEntry({
      objectId: "workers-kv:key-sha256",
      entry: entry("repos/ada/home", bytes.byteLength, {
        z: [true, null],
        a: { version: 1 },
      }),
      response: bodyResponse(bytes, [7, WORKERS_KV_VALUE_PART_BYTES - 2, 5]),
    }));

    expect(WORKERS_KV_LOGICAL_SNAPSHOT_SCHEMA_FEATURE).toBe(
      "gsv-workers-kv-logical-snapshot-v1",
    );
    expect(WORKERS_KV_VALUE_PART_BYTES).toBe(MAX_FRAME_BODY_BYTES);
    expect(frames.map((frame) => [frame.kind, frame.part, frame.body.byteLength])).toEqual([
      ["workers-kv.descriptor", 0, frames[0]!.body.byteLength],
      ["workers-kv.value", 0, WORKERS_KV_VALUE_PART_BYTES],
      ["workers-kv.value", 1, 3],
    ]);
    expect(decodePortableWorkersKvDescriptorFrame(frames[0]!)).toEqual({
      format: "gsv-workers-kv-logical-snapshot",
      version: 1,
      record: "entry",
      objectId: "workers-kv:key-sha256",
      key: "repos/ada/home",
      valueBytes: String(bytes.byteLength),
      valueParts: "2",
      expiration: "1900000000",
      metadata: {
        a: { version: 1 },
        z: [true, null],
      },
    });
    const canonicalDescriptor = parseCanonicalJson(frames[0]!.body) as Record<string, unknown>;
    expect(Object.keys(canonicalDescriptor)).toEqual([
      "expiration",
      "format",
      "key",
      "metadata",
      "objectId",
      "record",
      "valueBytes",
      "valueParts",
      "version",
    ]);
  });

  it("owns source responses on validation failure and early iterator stop", async () => {
    const invalidCancel = vi.fn();
    const invalid = snapshotPortableWorkersKvEntry({
      objectId: "workers-kv:invalid",
      entry: entry("bad\u0000key", 1),
      response: new Response(new ReadableStream({ cancel: invalidCancel })),
    });
    await expect(invalid.next()).rejects.toMatchObject({
      code: "unsupported_entry",
    } satisfies Partial<PortableWorkersKvCodecError>);
    expect(invalidCancel).toHaveBeenCalledOnce();

    const stoppedCancel = vi.fn();
    const stopped = snapshotPortableWorkersKvEntry({
      objectId: "workers-kv:stopped",
      entry: entry("stopped", 1),
      response: new Response(new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
        cancel: stoppedCancel,
      })),
    });
    await expect(stopped.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "workers-kv.descriptor" },
    });
    await stopped.return(undefined);
    expect(stoppedCancel).toHaveBeenCalledOnce();
  });

  it("fails closed on truncated values and non-portable metadata", async () => {
    await expect(collect(snapshotPortableWorkersKvEntry({
      objectId: "workers-kv:short",
      entry: entry("short", 2),
      response: new Response(new Uint8Array([1])),
    }))).rejects.toMatchObject({ code: "body_mismatch" });

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => createPortableWorkersKvDescriptor(
      "workers-kv:cyclic",
      entry("key", 0, cyclic),
    )).toThrow("canonical JSON");
    expect(() => createPortableWorkersKvDescriptor(
      "workers-kv:expiration",
      { ...entry("key", 0), expiration: 0 },
    )).toThrow("positive whole Unix second");
  });

  it("rejects noncanonical and structurally inconsistent descriptors", () => {
    const frame = encodePortableWorkersKvDescriptorFrame(
      "workers-kv:descriptor",
      entry("home/file", 1),
    );
    const decoded = parseCanonicalJson(frame.body) as Record<string, unknown>;
    const noncanonicalValue = Object.fromEntries(Object.entries(decoded).reverse());
    expect(() => decodePortableWorkersKvDescriptorFrame({
      ...frame,
      body: new TextEncoder().encode(JSON.stringify(noncanonicalValue)),
    })).toThrow("canonical");

    expect(() => decodePortableWorkersKvDescriptorFrame({
      ...frame,
      body: canonicalJsonBytes({ ...decoded, valueParts: "2" }),
    })).toThrow("part count");
  });

  it("reassembles exact values and closes a rejected frame source", async () => {
    const bytes = patternedBytes(5);
    const frames = await collect(snapshotPortableWorkersKvEntry({
      objectId: "workers-kv:stream",
      entry: entry("home/file", bytes.byteLength),
      response: bodyResponse(bytes, [2, 3]),
    }));
    const descriptor = decodePortableWorkersKvDescriptorFrame(frames[0]!);
    await expect(readStream(portableWorkersKvValueStream(
      descriptor,
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
    await expect(readStream(portableWorkersKvValueStream(
      descriptor,
      wrongFrames(),
    ))).rejects.toMatchObject({ code: "body_mismatch" });
    expect(closed).toHaveBeenCalledOnce();
  });

  it("keeps provider quotas out of the public descriptor", () => {
    const logicalSize = 30 * 1024 * 1024;
    expect(createPortableWorkersKvDescriptor(
      "workers-kv:public-codec",
      entry("large-but-representable", logicalSize),
    )).toMatchObject({
      valueBytes: String(logicalSize),
      valueParts: String(Math.ceil(logicalSize / WORKERS_KV_VALUE_PART_BYTES)),
    });
  });
});

function entry(
  key: string,
  valueBytes: number,
  metadata: unknown = null,
): PortableWorkersKvSourceEntry {
  return {
    key,
    valueBytes,
    expiration: 1_900_000_000,
    metadata,
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
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
