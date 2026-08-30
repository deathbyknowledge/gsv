/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion -- The benchmark intentionally erases result types through one sink and trusts its checked-in corpus. */
import corpus from "../corpus/v3-frames.json";
import { decodeV4BinaryMessage, encodeV4ControlMessage } from "../src/codec";
import type { ControlFrame } from "../src/types";

const frames = corpus.map((entry) => entry.frame as ControlFrame);
const iterations = parsePositiveInteger(process.argv[2] ?? "1000");
const jsonEncoded = frames.map((frame) => JSON.stringify(frame));
const capnpUnpacked = frames.map((frame) => encodeV4ControlMessage(frame));
const capnpPacked = frames.map((frame) => encodeV4ControlMessage(frame, { packed: true }));

let sink: unknown;

for (let iteration = 0; iteration < 100; iteration++) {
  for (let index = 0; index < frames.length; index++) {
    sink = JSON.stringify(frames[index]);
    sink = JSON.parse(jsonEncoded[index]);
    sink = encodeV4ControlMessage(frames[index]);
    sink = decodeCarrier(capnpUnpacked[index]);
    sink = encodeV4ControlMessage(frames[index], { packed: true });
    sink = decodeCarrier(capnpPacked[index]);
  }
}

const report = {
  runtime: `node ${process.versions.node}; capnp-es 0.0.14`,
  corpusFrames: frames.length,
  iterationsPerRound: iterations,
  rounds: 9,
  memoryMethod: global.gc === undefined
    ? "unavailable (run Node with --expose-gc)"
    : "retained batch delta after pre-GC; includes unreachable intermediates not yet collected",
  formats: {
    jsonV3: formatMetrics(
      jsonEncoded.map((value) => Buffer.byteLength(value)),
      () => {
        for (const frame of frames) sink = JSON.stringify(frame);
      },
      () => {
        for (const encoded of jsonEncoded) sink = JSON.parse(encoded);
      },
      () => frames.map((frame) => JSON.stringify(frame)),
      () => jsonEncoded.map((encoded) => JSON.parse(encoded)),
    ),
    capnpUnpacked: formatMetrics(
      capnpUnpacked.map((value) => value.byteLength),
      () => {
        for (const frame of frames) sink = encodeV4ControlMessage(frame);
      },
      () => {
        for (const encoded of capnpUnpacked) sink = decodeCarrier(encoded);
      },
      () => frames.map((frame) => encodeV4ControlMessage(frame)),
      () => capnpUnpacked.map((encoded) => decodeCarrier(encoded)),
    ),
    capnpPacked: formatMetrics(
      capnpPacked.map((value) => value.byteLength),
      () => {
        for (const frame of frames) sink = encodeV4ControlMessage(frame, { packed: true });
      },
      () => {
        for (const encoded of capnpPacked) sink = decodeCarrier(encoded);
      },
      () => frames.map((frame) => encodeV4ControlMessage(frame, { packed: true })),
      () => capnpPacked.map((encoded) => decodeCarrier(encoded)),
    ),
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
void sink;

function formatMetrics(
  sizes: number[],
  encodeBatch: () => void,
  decodeBatch: () => void,
  retainedEncodeBatch: () => unknown[],
  retainedDecodeBatch: () => unknown[],
) {
  const wireBytes = sizes.reduce((total, size) => total + size, 0);
  return {
    wireBytes,
    meanWireBytes: wireBytes / sizes.length,
    minWireBytes: Math.min(...sizes),
    maxWireBytes: Math.max(...sizes),
    encode: {
      medianNsPerFrame: benchmark(encodeBatch),
      retainedBatchBytesPerFrame: retainedBytes(retainedEncodeBatch),
    },
    decode: {
      medianNsPerFrame: benchmark(decodeBatch),
      retainedBatchBytesPerFrame: retainedBytes(retainedDecodeBatch),
    },
  };
}

function benchmark(batch: () => void): number {
  const samples: number[] = [];
  for (let round = 0; round < 9; round++) {
    const started = process.hrtime.bigint();
    for (let iteration = 0; iteration < iterations; iteration++) batch();
    const elapsed = process.hrtime.bigint() - started;
    samples.push(Number(elapsed) / (iterations * frames.length));
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)];
}

function retainedBytes(batch: () => unknown[]): { heap: number; arrayBuffers: number } | null {
  if (global.gc === undefined) return null;
  global.gc();
  const before = process.memoryUsage();
  const retained: unknown[] = [];
  const memoryIterations = 100;
  for (let iteration = 0; iteration < memoryIterations; iteration++) {
    retained.push(...batch());
  }
  const after = process.memoryUsage();
  sink = retained;
  const operations = memoryIterations * frames.length;
  const result = {
    heap: Math.max(0, after.heapUsed - before.heapUsed) / operations,
    arrayBuffers: Math.max(0, after.arrayBuffers - before.arrayBuffers) / operations,
  };
  sink = undefined;
  global.gc();
  return result;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("iterations must be positive");
  return parsed;
}

function decodeCarrier(message: ArrayBuffer): ControlFrame {
  const decoded = decodeV4BinaryMessage(message);
  if (decoded.kind !== "control") throw new Error("expected a v4 control message");
  return decoded.frame;
}
