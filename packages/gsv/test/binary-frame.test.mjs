import assert from "node:assert/strict";
import test from "node:test";
import {
  BINARY_FRAME_DATA,
  buildBinaryFrame,
  parseBinaryFrame,
} from "../dist/protocol/binary-frame.js";

test("binary body frames match the Android driver golden encoding", () => {
  const encoded = new Uint8Array(buildBinaryFrame(
    0x12345678,
    BINARY_FRAME_DATA,
    new Uint8Array([0x41, 0x42]),
  ));

  assert.deepEqual(
    [...encoded],
    [0x78, 0x56, 0x34, 0x12, 0x01, 0x41, 0x42],
  );
  const decoded = parseBinaryFrame(encoded);
  assert.equal(decoded.streamId, 0x12345678);
  assert.equal(decoded.flags, BINARY_FRAME_DATA);
  assert.deepEqual([...decoded.payload], [0x41, 0x42]);
});
