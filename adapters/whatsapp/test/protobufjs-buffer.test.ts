import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

type BufferWriterInstance = {
  string(value: string): BufferWriterInstance;
  finish(): Buffer;
};

type BufferWriterConstructor = {
  new(): BufferWriterInstance;
  alloc(size: number): Buffer;
};

type Utf8WriteCall = {
  offset: number;
  length: number;
  bufferLength: number;
};

const require = createRequire(import.meta.url);
const BufferWriter = require(
  "protobufjs/src/writer_buffer",
) as BufferWriterConstructor;

describe("Workers protobuf compatibility", () => {
  it("passes the remaining buffer length to protobufjs utf8Write", () => {
    const prototypeDescriptor = Object.getOwnPropertyDescriptor(
      Buffer.prototype,
      "utf8Write",
    );
    const originalAlloc = BufferWriter.alloc;
    let utf8WriteCall: Utf8WriteCall | undefined;

    BufferWriter.alloc = (size: number): Buffer => {
      const buffer = Buffer.alloc(size);
      Object.defineProperty(buffer, "utf8Write", {
        value: function checkedUtf8Write(
          this: Buffer,
          value: string,
          offset: number,
          length?: number,
        ): number {
          if (length === undefined) {
            throw new RangeError("utf8Write length must be explicit");
          }
          utf8WriteCall = {
            offset,
            length,
            bufferLength: this.length,
          };
          return this.write(value, offset, length, "utf8");
        },
      });
      return buffer;
    };

    try {
      const value = "x".repeat(233);
      const encoded = new BufferWriter().string(value).finish();

      expect(utf8WriteCall).toEqual({
        offset: 2,
        length: 233,
        bufferLength: 235,
      });
      expect(encoded.subarray(2).toString()).toBe(value);
    } finally {
      BufferWriter.alloc = originalAlloc;
    }

    expect(Object.getOwnPropertyDescriptor(
      Buffer.prototype,
      "utf8Write",
    )).toEqual(prototypeDescriptor);
  });
});
