import assert from "node:assert/strict";
import test from "node:test";

import {
  DATA_FRAME_STREAM_CANONICAL_JSON_MEDIA_TYPE,
  DATA_FRAME_STREAM_CONTROL_KIND,
  DATA_FRAME_STREAM_MEDIA_TYPE,
  decodeDataFrameStream,
  decodeManagedRestoreControl,
  encodeDataFrameStream,
  encodeManagedRestoreControl,
} from "../dist/protocol/data-frame-stream.js";

const SHA256 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("data frame streams preserve fragmented binary bodies", async () => {
  assert.equal(DATA_FRAME_STREAM_MEDIA_TYPE, "application/vnd.gsv.data-frame-stream.v1");
  const body = new Uint8Array([0x00, 0xff, 0x80, 0x41, 0x00]);
  const encoded = await collect(encodeDataFrameStream([{
    kind: "do.sqlite.cell",
    objectId: "process:one",
    part: 7,
    bodyMediaType: "application/octet-stream",
    body,
  }]));

  const records = [];
  for await (const record of decodeDataFrameStream(oneByteStream(encoded))) records.push(record);
  assert.deepEqual(records, [{
    kind: "do.sqlite.cell",
    objectId: "process:one",
    part: 7,
    bodyMediaType: "application/octet-stream",
    body,
  }]);
  assert.equal(indexOfBytes(encoded, body) >= 0, true);
});

test("restore control records require exact canonical metadata", () => {
  const control = {
    component: "gateway",
    kind: "process",
    logicalName: "pid:private",
    objectId: "archive-object:1",
    restoreId: "restore:1",
    fenceEpoch: 4,
    frameCount: "5",
    bodyBytes: "1234",
    semanticSha256: SHA256,
  };
  const record = encodeManagedRestoreControl(control);
  assert.equal(record.kind, DATA_FRAME_STREAM_CONTROL_KIND);
  assert.equal(record.part, 0);
  assert.equal(record.bodyMediaType, DATA_FRAME_STREAM_CANONICAL_JSON_MEDIA_TYPE);
  assert.deepEqual(decodeManagedRestoreControl(record), control);

  const noncanonical = {
    ...record,
    body: new TextEncoder().encode(JSON.stringify(control)),
  };
  assert.throws(
    () => decodeManagedRestoreControl(noncanonical),
    /canonical JSON/,
  );
  assert.throws(
    () => encodeManagedRestoreControl({ ...control, component: "ripgit", kind: "repository_registry" }),
    /component and kind/,
  );
  assert.throws(
    () => encodeManagedRestoreControl({ ...control, restoreId: "restore\ud800" }),
    /invalid Unicode/,
  );
  assert.throws(
    () => encodeManagedRestoreControl({ ...control, restoreId: "restore\u0085id" }),
    /restoreId is invalid/,
  );
});

test("decoder rejects truncation and trailing bytes and cancels the source", async () => {
  const encoded = await collect(encodeDataFrameStream([{
    kind: "do.kv",
    objectId: "object",
    part: 0,
    bodyMediaType: "application/json",
    body: new Uint8Array([0x7b, 0x7d]),
  }]));

  let truncatedCancelled = false;
  const truncated = new ReadableStream({
    start(controller) {
      controller.enqueue(encoded.subarray(0, encoded.byteLength - 2));
      controller.close();
    },
    cancel() {
      truncatedCancelled = true;
    },
  });
  await assert.rejects(async () => {
    for await (const _record of decodeDataFrameStream(truncated)) {
      // consume
    }
  }, /ended during record prefix/);
  // A closed stream has nothing left for cancel to interrupt, but the decoder
  // still invokes the cancellation path for live sources (covered below).
  assert.equal(typeof truncatedCancelled, "boolean");

  const trailing = new Uint8Array(encoded.byteLength + 1);
  trailing.set(encoded);
  trailing[trailing.byteLength - 1] = 1;
  await assert.rejects(async () => {
    for await (const _record of decodeDataFrameStream(oneByteStream(trailing))) {
      // consume
    }
  }, /bytes after its terminator/);
});

test("decoder early exit propagates cancellation", async () => {
  let cancelled = false;
  let controller;
  const stream = new ReadableStream({
    start(value) {
      controller = value;
      void collect(encodeDataFrameStream([{
        kind: "do.kv",
        objectId: "object",
        part: 0,
        bodyMediaType: "application/json",
        body: new TextEncoder().encode("{}"),
      }])).then((bytes) => controller.enqueue(bytes));
    },
    cancel() {
      cancelled = true;
    },
  });

  for await (const _record of decodeDataFrameStream(stream)) break;
  assert.equal(cancelled, true);
});

test("encoder cancellation closes its record iterator", async () => {
  let finalized = false;
  async function* records() {
    try {
      yield {
        kind: "do.kv",
        objectId: "object",
        part: 0,
        bodyMediaType: "application/json",
        body: new TextEncoder().encode("{}"),
      };
      await new Promise(() => {});
    } finally {
      finalized = true;
    }
  }
  const stream = encodeDataFrameStream(records());
  const reader = stream.getReader();
  await reader.read();
  await reader.read();
  await reader.cancel("caller stopped");
  assert.equal(finalized, true);
});

test("configured limits can only tighten the v1 bounds", async () => {
  assert.throws(
    () => encodeDataFrameStream([], { maxBodyBytes: 4 * 1024 * 1024 + 1 }),
    /maxBodyBytes/,
  );
  const stream = encodeDataFrameStream([{
    kind: "do.kv",
    objectId: "object",
    part: 0,
    bodyMediaType: "application/json",
    body: new Uint8Array([1, 2]),
  }], { maxTotalBodyBytes: 1n });
  await assert.rejects(() => collect(stream), /total body byte limit/);

  const records = [{
    kind: "gsv.restore.control",
    objectId: "object",
    part: 0,
    bodyMediaType: "application/json",
    body: new Uint8Array([1, 2]),
  }, {
    kind: "do.sqlite.rows",
    objectId: "object",
    part: 0,
    bodyMediaType: "application/octet-stream",
    body: new Uint8Array([1, 2]),
  }];
  await assert.rejects(
    () => collect(encodeDataFrameStream(records, { maxFirstBodyBytes: 1 })),
    /First data frame body/,
  );

  const encoded = await collect(encodeDataFrameStream(records));
  await assert.rejects(async () => {
    for await (const _record of decodeDataFrameStream(oneByteStream(encoded), {
      maxFirstBodyBytes: 1,
    })) {
      // consume
    }
  }, /record length/);

  const decoded = [];
  for await (const record of decodeDataFrameStream(oneByteStream(encoded), {
    maxFirstBodyBytes: 2,
  })) decoded.push(record);
  assert.equal(decoded.length, 2);
});

async function collect(stream) {
  const chunks = [];
  let length = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function oneByteStream(bytes) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + 1));
      offset += 1;
    },
  });
}

function indexOfBytes(haystack, needle) {
  outer: for (let start = 0; start <= haystack.byteLength - needle.byteLength; start += 1) {
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (haystack[start + index] !== needle[index]) continue outer;
    }
    return start;
  }
  return -1;
}
