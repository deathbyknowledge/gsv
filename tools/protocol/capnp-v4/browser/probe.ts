/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- This browser-only assertion harness recursively compares arbitrary JSON and reports caught errors. */
import corpus from "../corpus/v3-frames.json";
import { decodeV4BinaryMessage, encodeV4ControlMessage } from "../src/codec";
import type { ControlFrame } from "../src/types";

const frames = corpus.map((entry) => entry.frame as ControlFrame);

void run().then(
  (report) => finish("pass", report),
  (error: unknown) => finish("fail", {
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  }),
);

async function run(): Promise<Record<string, unknown>> {
  let unpackedBytes = 0;
  let packedBytes = 0;
  let browserSink: unknown;
  const started = performance.now();
  const jsonEncoded = frames.map((frame) => JSON.stringify(frame));
  const unpackedEncoded = frames.map((frame) => encodeV4ControlMessage(frame));
  const packedEncoded = frames.map((frame) => encodeV4ControlMessage(frame, { packed: true }));
  for (const frame of frames) {
    const unpacked = encodeV4ControlMessage(frame);
    const packed = encodeV4ControlMessage(frame, { packed: true });
    assertDeepEqual(decodeCarrier(unpacked), frame);
    assertDeepEqual(decodeCarrier(packed), frame);
    unpackedBytes += unpacked.byteLength;
    packedBytes += packed.byteLength;
  }

  const transferable = encodeV4ControlMessage(frames[0]);
  const transferred = await transferThroughMessageChannel(transferable);
  if (transferable.byteLength !== 0) throw new Error("ArrayBuffer was not transferred");
  assertDeepEqual(decodeCarrier(transferred), frames[0]);

  const blobBytes = await new Blob([encodeV4ControlMessage(frames[1])]).arrayBuffer();
  assertDeepEqual(decodeCarrier(blobBytes), frames[1]);

  for (let iteration = 0; iteration < 50; iteration++) {
    for (let index = 0; index < frames.length; index++) {
      browserSink = JSON.stringify(frames[index]);
      browserSink = JSON.parse(jsonEncoded[index]);
      browserSink = encodeV4ControlMessage(frames[index]);
      browserSink = decodeCarrier(unpackedEncoded[index]);
      browserSink = encodeV4ControlMessage(frames[index], { packed: true });
      browserSink = decodeCarrier(packedEncoded[index]);
    }
  }

  const benchmarkIterations = 100;
  const benchmark = {
    iterationsPerRound: benchmarkIterations,
    rounds: 7,
    jsonV3: {
      encodeMedianNsPerFrame: measure(() => {
        for (const frame of frames) browserSink = JSON.stringify(frame);
      }, benchmarkIterations),
      decodeMedianNsPerFrame: measure(() => {
        for (const encoded of jsonEncoded) browserSink = JSON.parse(encoded);
      }, benchmarkIterations),
    },
    capnpUnpacked: {
      encodeMedianNsPerFrame: measure(() => {
        for (const frame of frames) browserSink = encodeV4ControlMessage(frame);
      }, benchmarkIterations),
      decodeMedianNsPerFrame: measure(() => {
        for (const encoded of unpackedEncoded) browserSink = decodeCarrier(encoded);
      }, benchmarkIterations),
    },
    capnpPacked: {
      encodeMedianNsPerFrame: measure(() => {
        for (const frame of frames) browserSink = encodeV4ControlMessage(frame, { packed: true });
      }, benchmarkIterations),
      decodeMedianNsPerFrame: measure(() => {
        for (const encoded of packedEncoded) browserSink = decodeCarrier(encoded);
      }, benchmarkIterations),
    },
  };
  void browserSink;

  return {
    runtime: navigator.userAgent,
    frames: frames.length,
    unpackedBytes,
    packedBytes,
    messageChannelArrayBuffer: true,
    blobArrayBuffer: true,
    benchmark,
    elapsedMs: performance.now() - started,
  };
}

function decodeCarrier(message: ArrayBuffer): ControlFrame {
  const decoded = decodeV4BinaryMessage(message);
  if (decoded.kind !== "control") throw new Error("expected a v4 control message");
  return decoded.frame;
}

function measure(batch: () => void, iterations: number): number {
  const samples: number[] = [];
  for (let round = 0; round < 7; round++) {
    const started = performance.now();
    for (let iteration = 0; iteration < iterations; iteration++) batch();
    samples.push((performance.now() - started) * 1_000_000 / (iterations * frames.length));
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)];
}

function transferThroughMessageChannel(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const channel = new MessageChannel();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("MessageChannel timeout")), 2_000);
    channel.port2.onmessage = (event: MessageEvent<unknown>) => {
      window.clearTimeout(timeout);
      channel.port1.close();
      channel.port2.close();
      if (!(event.data instanceof ArrayBuffer)) {
        reject(new Error("MessageChannel did not deliver an ArrayBuffer"));
        return;
      }
      resolve(event.data);
    };
    channel.port1.postMessage(buffer, [buffer]);
  });
}

function assertDeepEqual(actual: unknown, expected: unknown, path = "frame"): void {
  if (Object.is(actual, expected)) return;
  if (typeof actual !== "object" || actual === null || typeof expected !== "object" || expected === null) {
    throw new Error(`${path} differs: ${String(actual)} !== ${String(expected)}`);
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) {
      throw new Error(`${path} array shape differs`);
    }
    for (let index = 0; index < actual.length; index++) {
      assertDeepEqual(actual[index], expected[index], `${path}[${index}]`);
    }
    return;
  }
  const actualRecord = actual as Record<string, unknown>;
  const expectedRecord = expected as Record<string, unknown>;
  const actualKeys = Object.keys(actualRecord).sort();
  const expectedKeys = Object.keys(expectedRecord).sort();
  assertDeepEqual(actualKeys, expectedKeys, `${path}.keys`);
  for (const key of actualKeys) {
    assertDeepEqual(actualRecord[key], expectedRecord[key], `${path}.${key}`);
  }
}

function finish(status: "pass" | "fail", report: Record<string, unknown>): void {
  document.body.dataset.status = status;
  const output = document.createElement("pre");
  output.id = "result";
  output.textContent = JSON.stringify({ status, ...report });
  document.body.replaceChildren(output);
}
