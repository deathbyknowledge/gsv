/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion -- This test harness deliberately constructs and inspects hostile JSON shapes. */
import { describe, expect, it } from "vitest";
import { Message, utils } from "capnp-es";
import corpus from "../corpus/v3-frames.json";
import {
  decodeControlFrame,
  decodeV4BinaryMessage,
  encodeControlFrame,
  encodeV4ControlMessage,
  firstSegmentCopy,
  MAX_CONTROL_FRAME_BYTES,
  MAX_CONTROL_NESTING,
  MAX_CONTROL_SEGMENTS,
  openRawSingleSegmentForProbe,
  V4_BINARY_HEADER_BYTES,
} from "../src/codec";
import type { ControlFrame, JsonValue } from "../src/types";
import {
  JsonValue_Which,
  WireFrame as CurrentWireFrame,
} from "../generated/current/wire-frame";
import {
  WireFrame as OldWireFrame,
  WireFrame_Which as OldWireFrameWhich,
} from "../generated/v0/wire-frame-v0";

const frames = corpus.map((entry) => entry.frame as ControlFrame);

describe("Cap'n Proto v4 control codec", () => {
  it.each([false, true])("round-trips the protocol-v3 corpus (packed=%s)", (packed) => {
    for (const frame of frames) {
      expect(decodeControlFrame(encodeControlFrame(frame, { packed }), { packed })).toEqual(frame);
      expect(decodeV4BinaryMessage(encodeV4ControlMessage(frame, { packed }))).toEqual({
        kind: "control",
        frame,
        packed,
      });
    }
  });

  it("routes nonzero stream IDs to the unchanged body-frame path", () => {
    const payload = new TextEncoder().encode("external-body-bytes");
    const message = new Uint8Array(V4_BINARY_HEADER_BYTES + payload.byteLength);
    const view = new DataView(message.buffer);
    view.setUint32(0, 41, true);
    view.setUint8(4, 3);
    message.set(payload, V4_BINARY_HEADER_BYTES);
    const decoded = decodeV4BinaryMessage(message);
    expect(decoded.kind).toBe("body");
    if (decoded.kind !== "body") throw new Error("expected body frame");
    expect(decoded.streamId).toBe(41);
    expect(decoded.flags).toBe(3);
    expect(decoded.payload).toEqual(payload);

    const unknownControl = new Uint8Array(V4_BINARY_HEADER_BYTES);
    unknownControl[4] = 2;
    expect(() => decodeV4BinaryMessage(unknownControl)).toThrow(/Unknown v4 control encoding/);
  });

  it("distinguishes an explicit null payload from an absent payload", () => {
    const withNull: ControlFrame = { type: "sig", signal: "null", payload: null };
    const without: ControlFrame = { type: "sig", signal: "null" };
    expect(decodeControlFrame(encodeControlFrame(withNull))).toEqual(withNull);
    expect(decodeControlFrame(encodeControlFrame(without))).toEqual(without);
  });

  it("decodes a byte-offset ArrayBuffer view exactly", () => {
    const frame = frames[0];
    const encoded = new Uint8Array(encodeControlFrame(frame));
    const surrounding = new Uint8Array(encoded.length + 17).fill(0xa5);
    surrounding.set(encoded, 9);
    expect(decodeControlFrame(surrounding.subarray(9, 9 + encoded.length))).toEqual(frame);
  });

  it("materializes __proto__ as data without mutating the result prototype", () => {
    const args = JSON.parse('{"__proto__":{"polluted":true},"normal":1}') as JsonValue;
    const frame: ControlFrame = {
      type: "req",
      id: "prototype-key",
      call: "prototype.key",
      args,
    };
    const decoded = decodeControlFrame(encodeControlFrame(frame));
    expect(decoded.type).toBe("req");
    if (decoded.type !== "req" || typeof decoded.args !== "object" || decoded.args === null || Array.isArray(decoded.args)) {
      throw new Error("unexpected decoded frame");
    }
    expect(Object.getPrototypeOf(decoded.args)).toBe(Object.prototype);
    expect(Object.hasOwn(decoded.args, "__proto__")).toBe(true);
    expect(decoded.args.__proto__).toEqual({ polluted: true });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects strings that cannot round-trip through UTF-8 Text", () => {
    const frame: ControlFrame = {
      type: "req",
      id: "unicode",
      call: "prototype.unicode",
      args: "\ud800",
    };
    expect(() => encodeControlFrame(frame)).toThrow(/Invalid Unicode/);
  });
});

describe("capnp-es memory behavior", () => {
  it("copies framed segments before generated fields are traversed", () => {
    const frame: ControlFrame = {
      type: "req",
      id: "framed-copy-marker",
      call: "prototype.copy",
      args: null,
    };
    const encoded = encodeControlFrame(frame);
    const reader = new Message(encoded, false).getRoot(CurrentWireFrame);
    mutateMarker(encoded, "framed-copy-marker");
    expect(reader.request.id).toBe("framed-copy-marker");
  });

  it("traverses generated fields lazily from a raw single segment", () => {
    const frame: ControlFrame = {
      type: "req",
      id: "raw-lazy-marker",
      call: "prototype.lazy",
      args: null,
    };
    const segment = firstSegmentCopy(encodeControlFrame(frame));
    const reader = openRawSingleSegmentForProbe(segment);
    mutateMarker(segment, "raw-lazy-marker");
    expect(reader.request.id).toBe("xaw-lazy-marker");
  });

  it("copies an ArrayBufferView even in raw single-segment mode", () => {
    const frame: ControlFrame = {
      type: "req",
      id: "view-copy-marker",
      call: "prototype.view",
      args: null,
    };
    const segment = firstSegmentCopy(encodeControlFrame(frame));
    const reader = new Message(new Uint8Array(segment), false, true).getRoot(CurrentWireFrame);
    mutateMarker(segment, "view-copy-marker");
    expect(reader.request.id).toBe("view-copy-marker");
  });
});

describe("schema evolution", () => {
  it("lets an old reader consume a new ordinary field and preserves it only while forwarding the original message", () => {
    const message = new Message();
    const request = message.initRoot(CurrentWireFrame)._initRequest();
    request.id = "evolution";
    request.call = "prototype.evolution";
    request._initArgs().nullValue = true;
    request.revisionProbe = "new-field";

    const encoded = message.toArrayBuffer();
    const oldMessage = new Message(encoded, false);
    const oldRoot = oldMessage.getRoot(OldWireFrame);
    expect(oldRoot.which()).toBe(OldWireFrameWhich.REQUEST);
    expect(oldRoot.request.id).toBe("evolution");

    const forwarded = oldMessage.toArrayBuffer();
    const forwardedRequest = new Message(forwarded, false).getRoot(CurrentWireFrame).request;
    expect(forwardedRequest.revisionProbe).toBe("new-field");

    const materialized = decodeControlFrame(encoded);
    const rebuiltRequest = new Message(encodeControlFrame(materialized), false)
      .getRoot(CurrentWireFrame)
      .request;
    expect(utils.isNull(utils.getPointer(5, rebuiltRequest))).toBe(true);
  });

  it("fails closed on a new union variant", () => {
    const message = new Message();
    message.initRoot(CurrentWireFrame).futureFrame = "future";
    const encoded = message.toArrayBuffer();
    expect(new Message(encoded, false).getRoot(OldWireFrame).which()).toBe(3);
    expect(() => decodeControlFrame(encoded)).toThrow(/Unsupported frame variant/);
  });
});

describe("hostile input limits", () => {
  it("rejects a small packed expansion bomb before allocating the expansion", () => {
    const packed = new Uint8Array(513 * 2);
    for (let offset = 0; offset < packed.length; offset += 2) {
      packed[offset] = 0;
      packed[offset + 1] = 255;
    }
    expect(packed.length).toBeLessThan(MAX_CONTROL_FRAME_BYTES);
    expect(() => decodeControlFrame(packed, { packed: true })).toThrow(/expands past byte limit/);
  });

  it("rejects a segment table above the explicit cap", () => {
    const segmentCount = MAX_CONTROL_SEGMENTS + 1;
    const headerBytes = (4 + segmentCount * 4 + 7) & ~7;
    const encoded = new ArrayBuffer(headerBytes + 8);
    const view = new DataView(encoded);
    view.setUint32(0, segmentCount - 1, true);
    view.setUint32(4, 1, true);
    expect(() => decodeControlFrame(encoded)).toThrow(/Too many/);
  });

  it("rejects excessive recursive JSON nesting during encode", () => {
    let args: JsonValue = null;
    for (let depth = 0; depth < MAX_CONTROL_NESTING; depth++) args = [args];
    const frame: ControlFrame = {
      type: "req",
      id: "deep",
      call: "prototype.deep",
      args,
    };
    expect(() => encodeControlFrame(frame)).toThrow(/nesting limit/);
  });

  it("rejects invalid UTF-8 while materializing domain values", () => {
    const frame: ControlFrame = {
      type: "req",
      id: "unique-utf8-marker",
      call: "prototype.utf8",
      args: null,
    };
    const encoded = encodeControlFrame(frame);
    const offset = findBytes(
      new Uint8Array(encoded),
      new TextEncoder().encode("unique-utf8-marker"),
    );
    expect(offset).toBeGreaterThanOrEqual(0);
    new Uint8Array(encoded)[offset] = 0xff;
    expect(() => decodeControlFrame(encoded)).toThrow(/UTF-8/);
  });

  it("rejects duplicate object keys", () => {
    const message = new Message();
    const request = message.initRoot(CurrentWireFrame)._initRequest();
    request.id = "duplicate";
    request.call = "prototype.duplicate";
    const entries = request._initArgs()._initObjectValue(2);
    for (let index = 0; index < 2; index++) {
      const entry = entries.get(index);
      entry.key = "same";
      entry._initValue().boolValue = index === 0;
    }
    expect(request.args.which()).toBe(JsonValue_Which.OBJECT_VALUE);
    expect(() => decodeControlFrame(message.toArrayBuffer())).toThrow(/Duplicate/);
  });
});

function mutateMarker(buffer: ArrayBuffer, marker: string): void {
  const bytes = new Uint8Array(buffer);
  const offset = findBytes(bytes, new TextEncoder().encode(marker));
  if (offset < 0) throw new Error(`marker not found: ${marker}`);
  bytes[offset] = "x".charCodeAt(0);
}

function findBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let start = 0; start <= haystack.length - needle.length; start++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return start;
  }
  return -1;
}
