import { describe, expect, it } from "vitest";
import { encodeBase64Bytes } from "./base64";

describe("encodeBase64Bytes", () => {
  it("encodes large array buffers without argument spreading", () => {
    const bytes = new Uint8Array(70_000);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 251;
    }

    const expected = Buffer.from(bytes).toString("base64");
    expect(encodeBase64Bytes(bytes.buffer)).toBe(expected);
  });

  it("encodes only the visible window of a typed array view", () => {
    const source = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const view = source.subarray(2, 5);

    const expected = Buffer.from([3, 4, 5]).toString("base64");
    expect(encodeBase64Bytes(view)).toBe(expected);
  });

  it("encodes only the visible window of a data view", () => {
    const source = new Uint8Array([10, 20, 30, 40, 50, 60]);
    const view = new DataView(source.buffer, 1, 3);

    const expected = Buffer.from([20, 30, 40]).toString("base64");
    expect(encodeBase64Bytes(view)).toBe(expected);
  });
});
