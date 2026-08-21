import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeManagedInferenceStream,
  encodeManagedInferenceStreamEvent,
} from "../dist/protocol.js";

test("frames managed inference events across arbitrary byte chunks", async () => {
  const first = { type: "text_delta", contentIndex: 0, delta: "hé" };
  const second = { type: "thinking_delta", contentIndex: 1, delta: "why" };
  const bytes = concatenate(
    encodeManagedInferenceStreamEvent(first),
    encodeManagedInferenceStreamEvent(second),
  );
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 3));
      controller.enqueue(bytes.subarray(3, 11));
      controller.enqueue(bytes.subarray(11));
      controller.close();
    },
  });

  const events = [];
  for await (const event of decodeManagedInferenceStream(body)) {
    events.push(event);
  }
  assert.deepEqual(events, [first, second]);
});

test("rejects a truncated managed inference event", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"type":"done"}'));
      controller.close();
    },
  });

  await assert.rejects(async () => {
    for await (const _event of decodeManagedInferenceStream(body)) {}
  }, /incomplete event/);
});

test("cancels the owned stream when its consumer stops", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encodeManagedInferenceStreamEvent({
        type: "text_delta",
        contentIndex: 0,
        delta: "first",
      }));
    },
    cancel() {
      cancelled = true;
    },
  });

  for await (const _event of decodeManagedInferenceStream(body)) break;
  assert.equal(cancelled, true);
});

function concatenate(...parts) {
  const output = new Uint8Array(
    parts.reduce((length, part) => length + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}
