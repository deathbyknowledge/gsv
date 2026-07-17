import assert from "node:assert/strict";
import test from "node:test";

import {
  binaryBodyFromBytes,
  bundleAdapterMedia,
  consumeAdapterMediaBodyParts,
  readAdapterMediaBody,
  validateAdapterMediaBody,
  validateAdapterMediaBodyDescriptors,
} from "../dist/protocol/adapter-media-body.js";

const image = (filename) => ({
  type: "image",
  mimeType: "image/png",
  filename,
});

test("bundles multiple media streams into contiguous frame-body ranges", async () => {
  const bundle = await bundleAdapterMedia([
    { media: image("one.png"), body: binaryBodyFromBytes(Uint8Array.of(1, 2)) },
    { media: { ...image("remote.png"), url: "https://example.com/remote.png" } },
    { media: image("two.png"), body: binaryBodyFromBytes(Uint8Array.of(3, 4, 5)) },
  ]);

  assert.deepEqual(bundle.media.map((item) => item.body), [
    { offset: 0, length: 2 },
    undefined,
    { offset: 2, length: 3 },
  ]);
  assert.equal(bundle.body?.length, 5);

  const bytes = await readAdapterMediaBody(bundle.media, bundle.body);
  assert.deepEqual([...bytes[0]], [1, 2]);
  assert.equal(bytes[1], undefined);
  assert.deepEqual([...bytes[2]], [3, 4, 5]);
});

test("rejects non-contiguous descriptors and cancels their body", async () => {
  let cancelled = false;
  const body = {
    length: 1,
    stream: new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
  };

  await assert.rejects(
    readAdapterMediaBody([
      { ...image("bad.png"), body: { offset: 1, length: 1 } },
    ], body),
    /must be contiguous/,
  );
  assert.equal(cancelled, true);
});

test("cancels remaining sources when a bundled part violates its length", async () => {
  let secondCancelled = false;
  const first = {
    length: 3,
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(Uint8Array.of(1, 2));
        controller.close();
      },
    }),
  };
  const second = {
    length: 1,
    stream: new ReadableStream({
      cancel() {
        secondCancelled = true;
      },
    }),
  };
  const bundle = await bundleAdapterMedia([
    { media: image("short.png"), body: first },
    { media: image("pending.png"), body: second },
  ]);

  await assert.rejects(
    readAdapterMediaBody(bundle.media, bundle.body),
    /did not match/,
  );
  assert.equal(secondCancelled, true);
});

test("rejects an unreferenced request body", async () => {
  let cancelled = false;
  const body = {
    length: 0,
    stream: new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
  };

  await assert.rejects(
    readAdapterMediaBody([], body),
    /unreferenced binary body/,
  );
  assert.equal(cancelled, true);
});

test("validates descriptors without touching a frame body", async () => {
  const media = [
    { ...image("empty.png"), body: { offset: 0, length: 0 } },
    { ...image("remote.png"), url: "https://example.com/remote.png" },
    { ...image("data.png"), body: { offset: 0, length: 2 } },
  ];
  assert.deepEqual(validateAdapterMediaBodyDescriptors(media, {
    maxBytes: 2,
    maxPartBytes: 2,
  }), {
    parts: [
      { mediaIndex: 0, offset: 0, length: 0 },
      { mediaIndex: 2, offset: 0, length: 2 },
    ],
    totalLength: 2,
  });

  const body = binaryBodyFromBytes(Uint8Array.of(1, 2));
  assert.deepEqual(validateAdapterMediaBody(media, body), {
    parts: [
      { mediaIndex: 0, offset: 0, length: 0 },
      { mediaIndex: 2, offset: 0, length: 2 },
    ],
    totalLength: 2,
  });
  assert.equal(body.stream.locked, false);
  assert.deepEqual([...await readStream(body.stream)], [1, 2]);
});

test("descriptor validation rejects URL conflicts, gaps, and byte limits", () => {
  assert.throws(
    () => validateAdapterMediaBodyDescriptors([
      {
        ...image("conflict.png"),
        url: "https://example.com/conflict.png",
        body: { offset: 0, length: 1 },
      },
    ]),
    /both a URL and a binary body/,
  );
  assert.throws(
    () => validateAdapterMediaBodyDescriptors([
      { ...image("gap.png"), body: { offset: 1, length: 1 } },
    ]),
    /must be contiguous/,
  );
  assert.throws(
    () => validateAdapterMediaBodyDescriptors([
      { ...image("large.png"), body: { offset: 0, length: 3 } },
    ], { maxPartBytes: 2 }),
    /per-item limit/,
  );
  assert.throws(
    () => validateAdapterMediaBodyDescriptors([
      { ...image("one.png"), body: { offset: 0, length: 2 } },
      { ...image("two.png"), body: { offset: 2, length: 2 } },
    ], { maxBytes: 3 }),
    /total limit/,
  );
});

test("non-consuming preflight rejects missing, unreferenced, locked, and mismatched bodies", async () => {
  const media = [{ ...image("one.png"), body: { offset: 0, length: 1 } }];
  assert.throws(
    () => validateAdapterMediaBody(media, undefined),
    /missing binary body/,
  );
  assert.throws(
    () => validateAdapterMediaBody([], binaryBodyFromBytes(new Uint8Array())),
    /unreferenced binary body/,
  );
  assert.throws(
    () => validateAdapterMediaBody(media, binaryBodyFromBytes(Uint8Array.of(1, 2))),
    /did not match described length/,
  );

  const locked = binaryBodyFromBytes(Uint8Array.of(1));
  const owner = locked.stream.getReader();
  assert.throws(
    () => validateAdapterMediaBody(media, locked),
    /already locked/,
  );
  owner.releaseLock();
  await locked.stream.cancel();
});

test("rejects locked source bodies while bundling", async () => {
  const body = binaryBodyFromBytes(Uint8Array.of(1));
  const owner = body.stream.getReader();
  await assert.rejects(
    bundleAdapterMedia([{ media: image("locked.png"), body }]),
    /already locked/,
  );
  owner.releaseLock();
  await body.stream.cancel();
});

test("splits chunks across parts and preserves zero-length descriptors", async () => {
  const media = [
    { ...image("empty-first.png"), body: { offset: 0, length: 0 } },
    { ...image("one.png"), body: { offset: 0, length: 2 } },
    { ...image("remote.png"), url: "https://example.com/remote.png" },
    { ...image("empty-middle.png"), body: { offset: 2, length: 0 } },
    { ...image("two.png"), body: { offset: 2, length: 3 } },
  ];
  const body = bodyFromChunks([Uint8Array.of(1, 2, 3, 4, 5)], 5);

  const bytes = await readAdapterMediaBody(media, body);

  assert.deepEqual([...bytes[0]], []);
  assert.deepEqual([...bytes[1]], [1, 2]);
  assert.equal(bytes[2], undefined);
  assert.deepEqual([...bytes[3]], []);
  assert.deepEqual([...bytes[4]], [3, 4, 5]);
});

test("rejects short and overlong streams even when their declared length matches", async () => {
  await assert.rejects(
    readAdapterMediaBody([
      { ...image("short.png"), body: { offset: 0, length: 3 } },
    ], bodyFromChunks([Uint8Array.of(1, 2)], 3)),
    /length 2 did not match described length 3/,
  );

  await assert.rejects(
    readAdapterMediaBody([
      { ...image("overlong.png"), body: { offset: 0, length: 1 } },
    ], bodyFromChunks([Uint8Array.of(1, 2)], 1)),
    /exceeded described length 1/,
  );
});

test("cancels before reading when descriptor limits or declared length fail", async () => {
  let limitCancelled = false;
  await assert.rejects(
    readAdapterMediaBody([
      { ...image("large.png"), body: { offset: 0, length: 2 } },
    ], pendingBody(2, () => {
      limitCancelled = true;
    }), { maxPartBytes: 1 }),
    /per-item limit/,
  );
  assert.equal(limitCancelled, true);

  let lengthCancelled = false;
  await assert.rejects(
    readAdapterMediaBody([
      { ...image("mismatch.png"), body: { offset: 0, length: 1 } },
    ], pendingBody(2, () => {
      lengthCancelled = true;
    })),
    /did not match described length/,
  );
  assert.equal(lengthCancelled, true);
});

test("streams parts sequentially with callback and source backpressure", async () => {
  let pulls = 0;
  const body = {
    length: 2,
    stream: new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(Uint8Array.of(pulls));
        if (pulls === 2) {
          controller.close();
        }
      },
    }, { highWaterMark: 0 }),
  };
  const media = [
    { ...image("one.png"), body: { offset: 0, length: 1 } },
    { ...image("two.png"), body: { offset: 1, length: 1 } },
  ];
  const calls = [];

  await consumeAdapterMediaBodyParts(media, body, async (part) => {
    calls.push(`start:${part.mediaIndex}`);
    assert.equal(body.stream.locked, true);
    assert.equal(pulls, part.mediaIndex);
    assert.deepEqual([...await readStream(part.body.stream)], [part.mediaIndex + 1]);
    assert.equal(pulls, part.mediaIndex + 1);
    calls.push(`end:${part.mediaIndex}`);
  });

  assert.deepEqual(calls, ["start:0", "end:0", "start:1", "end:1"]);
  assert.equal(body.stream.locked, false);
});

test("cancels the owned body when a part is not consumed or its callback fails", async () => {
  let unconsumedCancelled = false;
  await assert.rejects(
    consumeAdapterMediaBodyParts([
      { ...image("ignored.png"), body: { offset: 0, length: 1 } },
    ], pendingBody(1, () => {
      unconsumedCancelled = true;
    }), async () => {}),
    /was not fully consumed/,
  );
  assert.equal(unconsumedCancelled, true);

  let explicitlyCancelled = false;
  await assert.rejects(
    consumeAdapterMediaBodyParts([
      { ...image("cancelled.png"), body: { offset: 0, length: 1 } },
    ], pendingBody(1, () => {
      explicitlyCancelled = true;
    }), async (part) => {
      await part.body.stream.cancel(new Error("skip part"));
    }),
    /skip part/,
  );
  assert.equal(explicitlyCancelled, true);

  let failedCancelled = false;
  await assert.rejects(
    consumeAdapterMediaBodyParts([
      { ...image("failed.png"), body: { offset: 0, length: 1 } },
    ], pendingBody(1, () => {
      failedCancelled = true;
    }), async () => {
      throw new Error("consumer failed");
    }),
    /consumer failed/,
  );
  assert.equal(failedCancelled, true);
});

test("propagates abort and cancels the single owned body reader", async () => {
  const abortController = new AbortController();
  let cancelReason;
  const body = {
    length: 1,
    stream: new ReadableStream({
      pull() {
        abortController.abort(new Error("stop media"));
      },
      cancel(reason) {
        cancelReason = reason;
      },
    }, { highWaterMark: 0 }),
  };

  await assert.rejects(
    consumeAdapterMediaBodyParts([
      { ...image("abort.png"), body: { offset: 0, length: 1 } },
    ], body, async (part) => {
      await readStream(part.body.stream);
    }, { signal: abortController.signal }),
    /stop media/,
  );
  assert.match(String(cancelReason), /stop media/);
});

async function readStream(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function bodyFromChunks(chunks, length) {
  return {
    length,
    stream: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
  };
}

function pendingBody(length, cancel) {
  return {
    length,
    stream: new ReadableStream({ cancel }),
  };
}
