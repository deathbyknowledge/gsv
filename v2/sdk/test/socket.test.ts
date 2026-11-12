import { describe, expect, it } from "vitest";
import { connect, GsvRequestError } from "../src/index.ts";

type Req = { t: "req"; id: string; op: string; args: unknown };
type Script = (req: Req, socket: FakeSocket) => void;

/** A scripted server behind a WebSocket-shaped object. */
class FakeSocket extends EventTarget {
  static opened: FakeSocket[] = [];
  static script: Script = () => {};
  readyState = 0;
  readonly sent: Req[] = [];
  readonly url: string;
  readonly protocols: string[];
  constructor(url: string, protocols: string[]) {
    super();
    this.url = url;
    this.protocols = protocols;
    FakeSocket.opened.push(this);
    setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
  }
  send(data: string): void {
    if (data === "ping") return;
    const req = JSON.parse(data) as Req;
    this.sent.push(req);
    queueMicrotask(() => FakeSocket.script(req, this));
  }
  reply(req: Req, body: { result: unknown } | { error: { code: string; message: string; retryable: boolean; retryAfterMs?: number } }): void {
    const frame = "result" in body ? { t: "res", id: req.id, ok: true, result: body.result } : { t: "res", id: req.id, ok: false, error: body.error };
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }
  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code }));
  }
}

const connected = { owner: "o1", person: "o1", resumed: true, minVersion: {}, deprecations: [] };
const options = (token: string | (() => Promise<string>) = "tok") => ({
  host: "ana.gsv.test",
  token,
  insecure: true,
  WebSocket: FakeSocket as unknown as typeof WebSocket,
  backoff: { baseMs: 1, maxMs: 2, random: () => 0.5 },
});

function serve(handle: (req: Req, socket: FakeSocket) => void): void {
  FakeSocket.opened = [];
  // The first request on each socket is the handshake.
  FakeSocket.script = (req, socket) => socket.sent.length === 1 ? socket.reply(req, { result: connected }) : handle(req, socket);
}

describe("sdk socket", () => {
  it("sends the token as a subprotocol and answers connect", async () => {
    serve(() => {});
    const gsv = await connect(options());
    expect(gsv.info).toEqual(connected);
    expect(FakeSocket.opened[0]?.url).toBe("ws://ana.gsv.test/_gsv/socket");
    expect(FakeSocket.opened[0]?.protocols).toEqual(["gsv.5", "gsv.token.tok"]);
    gsv.close();
  });

  it("retries an error the server marks retryable, with the same op id", async () => {
    let calls = 0;
    serve((req, socket) => {
      calls += 1;
      if (calls === 1) socket.reply(req, { error: { code: "unavailable", message: "busy", retryable: true, retryAfterMs: 1 } });
      else socket.reply(req, { result: connected });
    });
    const gsv = await connect(options());
    await gsv.call("connect", { protocol: 5, client: { name: "t", version: "0", platform: "node" } }, { opId: "op-retry-1" });
    const ids = FakeSocket.opened[0]?.sent.filter(req => req.id === "op-retry-1").map(req => req.id);
    expect(ids).toEqual(["op-retry-1", "op-retry-1"]);
    gsv.close();
  });

  it("never retries what the server marks final", async () => {
    serve((req, socket) => socket.reply(req, { error: { code: "forbidden", message: "no", retryable: false } }));
    const gsv = await connect(options());
    const failure = await gsv.call("connect", { protocol: 5, client: { name: "t", version: "0", platform: "node" } }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(GsvRequestError);
    expect(failure).toMatchObject({ code: "forbidden", retryable: false });
    gsv.close();
  });

  it("re-sends a call lost with its socket after reconnecting, under the same op id", async () => {
    let dropped = false;
    serve((req, socket) => {
      if (!dropped) { dropped = true; socket.close(1006); return; }
      socket.reply(req, { result: connected });
    });
    const gsv = await connect(options());
    await gsv.call("connect", { protocol: 5, client: { name: "t", version: "0", platform: "node" } }, { opId: "op-lost-1" });
    expect(FakeSocket.opened).toHaveLength(2);
    expect(FakeSocket.opened[1]?.sent.map(req => req.op)).toEqual(["connect", "connect"]);
    expect(FakeSocket.opened[1]?.sent[1]?.id).toBe("op-lost-1");
    gsv.close();
  });

  it("stops on unauthorized with a fixed token, and refreshes once with a token function", async () => {
    FakeSocket.opened = [];
    FakeSocket.script = (_req, socket) => socket.close(4401);
    await expect(connect(options())).rejects.toMatchObject({ code: "unauthorized" });
    expect(FakeSocket.opened).toHaveLength(1);

    let refreshes = 0;
    FakeSocket.opened = [];
    FakeSocket.script = (req, socket) => socket.protocols.includes("gsv.token.fresh") ? socket.reply(req, { result: connected }) : socket.close(4401);
    const gsv = await connect(options(async () => (refreshes++ === 0 ? "stale" : "fresh")));
    expect(gsv.info).toEqual(connected);
    expect(refreshes).toBe(2);
    gsv.close();
  });
});
