/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- The checked-in corpus is the typed fixture under test. */
import { describe, expect, it } from "vitest";
import corpus from "../corpus/v3-frames.json";
import { decodeV4BinaryMessage, encodeV4ControlMessage } from "../src/codec";
import type { ControlFrame } from "../src/types";
import worker from "./worker";

const frames = corpus.map((entry) => entry.frame as ControlFrame);

describe.each([false, true])("workerd codec execution (packed=%s)", (packed) => {
  it("round-trips binary Request and Response bodies", async () => {
    for (const frame of frames) {
      const response = await worker.fetch(new Request("https://probe.invalid/control", {
        body: encodeV4ControlMessage(frame, { packed }),
        method: "POST",
      }));
      expect(response.headers.get("content-type")).toBe("application/x-capnp");
      expect(response.headers.get("x-capnp-packed")).toBe(packed ? "1" : "0");
      const decoded = decodeV4BinaryMessage(await response.arrayBuffer());
      expect(decoded.kind).toBe("control");
      if (decoded.kind !== "control") throw new Error("expected control frame");
      expect(decoded.frame).toEqual(frame);
    }
  });

  it("carries an ArrayBuffer through a workerd WebSocketPair", async () => {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    client.binaryType = "arraybuffer";
    server.binaryType = "arraybuffer";
    client.accept();
    server.accept();
    server.addEventListener("message", (event) => server.send(event.data));

    const encoded = encodeV4ControlMessage(frames[0], { packed });
    const echoed = new Promise<ArrayBuffer>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WebSocketPair timeout")), 2_000);
      client.addEventListener("message", (event) => {
        clearTimeout(timeout);
        if (event.data instanceof ArrayBuffer) resolve(event.data);
        else reject(new Error(
          `WebSocketPair delivered ${Object.prototype.toString.call(event.data)} (${event.data?.constructor?.name})`,
        ));
      });
    });
    client.send(encoded);
    const decoded = decodeV4BinaryMessage(await echoed);
    expect(decoded.kind).toBe("control");
    if (decoded.kind !== "control") throw new Error("expected control frame");
    expect(decoded.frame).toEqual(frames[0]);
    client.close(1000, "done");
    server.close(1000, "done");
  });
});
