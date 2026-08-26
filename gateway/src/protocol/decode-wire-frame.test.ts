import { describe, expect, it } from "vitest";
import {
  decodeWireFrameJson,
  decodeWireResponse,
  InvalidWireFrameError,
} from "./decode-wire-frame";

describe("decodeWireFrameJson", () => {
  it("decodes a syscall request with its call-specific argument contract", () => {
    expect(decodeWireFrameJson(JSON.stringify({
      type: "req",
      id: "request-1",
      call: "fs.read",
      args: { path: "/notes.txt", limit: 50 },
    }))).toEqual({
      type: "req",
      id: "request-1",
      call: "fs.read",
      args: { path: "/notes.txt", limit: 50 },
    });
  });

  it.each([
    {
      type: "req",
      id: "request-1",
      call: "fs.read",
      args: { path: 42 },
    },
    {
      type: "req",
      id: "request-1",
      call: "unknown.call",
      args: {},
    },
    {
      type: "req",
      id: "request-1",
      call: "fs.read",
      args: { path: "/notes.txt" },
      unexpected: true,
    },
    {
      type: "sig",
      signal: "peer.ping",
      body: { streamId: 1 },
    },
  ])("rejects values outside the wire contract", (frame) => {
    expect(() => decodeWireFrameJson(JSON.stringify(frame))).toThrow(InvalidWireFrameError);
  });

  it("decodes response errors and generic JSON signals", () => {
    expect(decodeWireFrameJson(JSON.stringify({
      type: "res",
      id: "request-1",
      ok: false,
      error: {
        code: 409,
        message: "Conflict",
        details: { owner: "kernel", retryAfterMs: 100 },
      },
    }))).toMatchObject({ type: "res", ok: false });

    expect(decodeWireFrameJson(JSON.stringify({
      type: "sig",
      signal: "peer.ping",
      payload: { nonce: "nonce-1" },
      seq: 4,
    }))).toMatchObject({ type: "sig", signal: "peer.ping" });
  });

  it("distinguishes malformed JSON from a structurally invalid frame", () => {
    expect(() => decodeWireFrameJson("{"))
      .toThrowError(new InvalidWireFrameError("Malformed JSON"));
    expect(() => decodeWireFrameJson("null"))
      .toThrowError(new InvalidWireFrameError("Invalid frame"));
  });

  it("validates a successful response against its routed syscall", () => {
    const response = {
      type: "res" as const,
      id: "request-1",
      ok: true as const,
      data: {
        ok: true,
        path: "/notes.txt",
        kind: "text",
        contentType: "text/plain",
        size: 12,
      },
    };

    expect(decodeWireResponse("fs.read", response)).toEqual(response);
    expect(() => decodeWireResponse("fs.write", response))
      .toThrowError(new InvalidWireFrameError("Invalid fs.write response"));
  });

  it("retains a request id when call-specific arguments are invalid", () => {
    try {
      decodeWireFrameJson(JSON.stringify({
        type: "req",
        id: "request-invalid",
        call: "fs.read",
        args: { path: 42 },
      }));
      throw new Error("Expected decoding to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidWireFrameError);
      expect(error).toMatchObject({ frameId: "request-invalid" });
    }
  });
});
