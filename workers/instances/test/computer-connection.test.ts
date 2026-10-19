import { describe, expect, it, vi } from "vitest";
import { BinaryBodyChannel } from "@humansandmachines/gsv/protocol/binary-body-channel";
import { wireFrameSchemas } from "@humansandmachines/gsv/protocol";
import { ComputerConnection } from "../src/computer-connection";

function fixture() {
  const pair = new WebSocketPair();
  pair[1].binaryType = "arraybuffer";
  pair[1].accept();
  const events = vi.fn();
  const connection = new ComputerConnection(pair[0], events);
  const bodyChannel = new BinaryBodyChannel({ role: "acceptor", sendFrame: frame => pair[1].send(frame) });
  const requests: unknown[] = [];
  pair[1].addEventListener("message", message => {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The test peer receives the WebSocket text/binary union.
    if (typeof message.data !== "string") bodyChannel.handleFrame(message.data);
    else requests.push(JSON.parse(message.data));
  });
  return { connection, peer: pair[1], bodyChannel, requests, events, close() { connection.close(); bodyChannel.close(); } };
}

describe("private computer protocol", () => {
  it("streams response bodies across credit windows and forwards execution metadata", async () => {
    const f = fixture();
    try {
      const response = f.connection.execute({ type: "req", id: "read", call: "fs.read", args: { path: "/workspace/out" } }, Date.now() + 5000);
      const bytes = new Uint8Array(6 * 1024 * 1024).fill(37);
      const outgoing = f.bodyChannel.prepare({ stream: new Blob([bytes]).stream(), length: bytes.length });
      f.peer.send(JSON.stringify({ type: "res", id: "read", ok: true, data: { ok: true }, body: outgoing.descriptor }));
      const sent = outgoing.send();
      const result = await response;
      expect(result.ok).toBe(true);
      if (!result.ok || !result.body) throw new Error("Missing response body");
      const received = await new Response(result.body.stream).arrayBuffer();
      expect(received.byteLength).toBe(bytes.length);
      expect(await crypto.subtle.digest("SHA-256", received)).toEqual(await crypto.subtle.digest("SHA-256", bytes));
      await sent;
      f.peer.send(JSON.stringify({ type: "sig", signal: "exec.status", payload: { event: "finished", sessionId: "shell", exitCode: 0 } }));
      await vi.waitFor(() => expect(f.events).toHaveBeenCalledWith({ event: "finished", sessionId: "shell", exitCode: 0 }));
    } finally { f.close(); }
  });

  it("cancels an upload when the machine responds before consuming it", async () => {
    const f = fixture();
    const cancelled = vi.fn();
    try {
      const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(65536)); }, cancel: cancelled });
      const response = f.connection.execute({ type: "req", id: "write", call: "fs.write", args: { path: "/workspace/out" }, body: { stream } }, Date.now() + 5000);
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      f.peer.send(JSON.stringify({ type: "res", id: "write", ok: false, error: { code: 403, message: "Denied" } }));
      expect((await response).ok).toBe(false);
      await vi.waitFor(() => expect(cancelled).toHaveBeenCalled());
    } finally { f.close(); }
  });

  it("keeps cancellation attached to a returned body until its consumer finishes", async () => {
    const f = fixture();
    try {
      const response = f.connection.execute({ type: "req", id: "read", call: "fs.read", args: { path: "/workspace/out" } }, Date.now() + 5000);
      f.peer.send(JSON.stringify({ type: "res", id: "read", ok: true, data: { ok: true }, body: { streamId: 2 } }));
      const result = await response;
      if (!result.ok || !result.body) throw new Error("Missing response body");
      f.connection.cancel("read");
      await expect(new Response(result.body.stream).arrayBuffer()).rejects.toThrow("cancelled");
      await vi.waitFor(() => expect(f.requests).toContainEqual({ type: "sig", signal: "request.cancel", payload: { id: "read" } }));
    } finally { f.close(); }
  });

  it("cancels connection-owned requests on disconnect without replay", async () => {
    const f = fixture();
    try {
      const response = f.connection.execute({ type: "req", id: "start", call: "shell.exec", args: { input: "sleep 30", start: true, sessionId: "durable" } }, Date.now() + 5000);
      const failed = expect(response).rejects.toThrow("closed");
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      f.peer.close(1000, "Lost connection");
      await failed;
      expect(f.requests.filter(value => wireFrameSchemas.request.safeParse(value).success)).toHaveLength(1);
    } finally { f.close(); }
  });
});
