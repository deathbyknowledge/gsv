import { listDurableObjectIds, runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { parseResult, resFrameSchema, type JsonValue, type ResFrame } from "@gsv/catalog";
import { migrate } from "../src/schema.ts";
import { sessionSchema } from "../src/token.ts";

type Socket = { ws: WebSocket; protocol: string | null; next(): Promise<ResFrame>; closed: Promise<{ code: number; reason: string }> };

async function openSocket(host: string, token: string | undefined): Promise<Socket> {
  const protocols = ["gsv.5", ...(token ? [`gsv.token.${token}`] : [])];
  const response = await SELF.fetch(`https://${host}/_gsv/socket`, { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": protocols.join(", ") } });
  const ws = response.webSocket;
  if (!ws) throw new Error(`No socket: ${response.status}`);
  const messages: ResFrame[] = [];
  const waiting: ((frame: ResFrame) => void)[] = [];
  ws.addEventListener("message", event => {
    const frame = resFrameSchema.parse(JSON.parse(String(event.data)));
    const resolve = waiting.shift();
    if (resolve) resolve(frame); else messages.push(frame);
  });
  const closed = new Promise<{ code: number; reason: string }>(resolve => ws.addEventListener("close", event => resolve({ code: event.code, reason: event.reason }), { once: true }));
  ws.accept();
  return {
    ws,
    protocol: response.headers.get("Sec-WebSocket-Protocol"),
    next: () => {
      const frame = messages.shift();
      return frame ? Promise.resolve(frame) : new Promise(resolve => waiting.push(resolve));
    },
    closed,
  };
}

function request(socket: Socket, id: string, op: string, args: JsonValue): Promise<ResFrame> {
  socket.ws.send(JSON.stringify({ t: "req", id, op, args }));
  return socket.next();
}

const CONNECT = { protocol: 5, client: { name: "test", version: "0", platform: "workerd" } };

async function setup(code: string): Promise<Response> {
  return SELF.fetch("https://ops.gsv.test/_gsv/setup", { method: "POST", body: JSON.stringify({ code, name: "Ana" }) });
}

describe("first space", () => {
  let token = "";

  beforeAll(async () => {
    const response = await setup(env.GSV_TEST_SETUP_CODE);
    expect(response.status).toBe(200);
    const body = await response.json<{ host: string; token: string; expiresAt: number }>();
    expect(body.host).toBe("ops.gsv.test");
    token = body.token;
  });

  it("redeems the setup link only once", async () => {
    const again = await setup(env.GSV_TEST_SETUP_CODE);
    expect(again.status).toBe(403);
    expect(await again.json()).toMatchObject({ error: { code: "forbidden", retryable: false } });
    expect((await setup("not-the-code-0123456789")).status).toBe(403);
  });

  it("connects the person's owner socket and answers connect", async () => {
    const socket = await openSocket("ops.gsv.test", token);
    expect(socket.protocol).toBe("gsv.5");
    const response = await request(socket, "op-connect-1", "connect", CONNECT);
    expect(response).toMatchObject({ t: "res", id: "op-connect-1", ok: true, result: { resumed: true, minVersion: {}, deprecations: [] } });
    if (!response.ok) throw new Error("connect failed");
    const result = parseResult("connect", response.result);
    expect(result.owner).toBe(result.person);
    expect(await request(socket, "op-connect-2", "connect", { ...CONNECT, since: { events: 3 } })).toMatchObject({ ok: true, result: { resumed: "reset" } });
    socket.ws.close(1000);
  });

  it("answers a client's close so the connection ends", async () => {
    const socket = await openSocket("ops.gsv.test", token);
    await request(socket, "op-close-1", "connect", CONNECT);
    socket.ws.close(1000, "done");
    const unanswered = new Promise(resolve => setTimeout(() => resolve("no close from the owner"), 2_000));
    expect(await Promise.race([socket.closed, unanswered])).toEqual({ code: 1000, reason: "done" });
  });

  it("answers bad_request with the failing fields, and for an unknown operation", async () => {
    const socket = await openSocket("ops.gsv.test", token);
    expect(await request(socket, "op-bad-args1", "connect", { protocol: 4 })).toMatchObject({
      ok: false,
      error: { code: "bad_request", retryable: false, details: { issues: expect.arrayContaining([expect.objectContaining({ path: "protocol" })]) } },
    });
    expect(await request(socket, "op-unknown-1", "nope.op", {})).toMatchObject({ ok: false, error: { code: "bad_request" } });
    socket.ws.close(1000);
  });

  it("refuses a token on another hostname or with an edited space", async () => {
    expect(await (await openSocket("gsv.test", token)).closed).toEqual({ code: 4401, reason: "unauthorized" });
    const [body, signature] = token.split(".");
    const claims = sessionSchema.parse(JSON.parse(atob((body ?? "").replace(/-/g, "+").replace(/_/g, "/"))));
    const edited = btoa(JSON.stringify({ ...claims, space: crypto.randomUUID() })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await (await openSocket("ops.gsv.test", `${edited}.${signature}`)).closed).toEqual({ code: 4401, reason: "unauthorized" });
    expect(await (await openSocket("ops.gsv.test", undefined)).closed).toEqual({ code: 4401, reason: "unauthorized" });
  });
});

async function objectCounts(): Promise<number[]> {
  const lists = await Promise.all([
    listDurableObjectIds(env.SPACE), listDurableObjectIds(env.OWNER), listDurableObjectIds(env.PROCESS), listDurableObjectIds(env.VOLUME), listDurableObjectIds(env.TARGET),
  ]);
  return lists.map(ids => ids.length);
}

describe("edge routing", () => {
  it("answers 404 for hostnames nobody claimed and creates no space or owner objects", async () => {
    const before = await objectCounts();
    for (const url of ["https://evil.example/", "https://a.b.gsv.test/", "https://nobody.gsv.test/", "https://nobody.gsv.test/_gsv/setup"]) {
      expect((await SELF.fetch(url)).status, url).toBe(404);
    }
    const after = await objectCounts();
    expect(after).toEqual(before);
  });

  it("serves the setup page and its files on the operator host before the first space exists", async () => {
    for (const [url, text] of [["https://ops.gsv.test/setup", "test ui"], ["https://ops.gsv.test/app.js", "test script"]] as const) {
      const response = await SELF.fetch(url);
      expect(response.status, url).toBe(200);
      expect(await response.text()).toContain(text);
    }
  });

  it("serves the UI at the domain and at a claimed space, with app routes falling back to the page", async () => {
    await setup(env.GSV_TEST_SETUP_CODE);
    for (const url of ["https://gsv.test/", "https://gsv.test/sign-in", "https://ops.gsv.test/setup"]) {
      const response = await SELF.fetch(url);
      expect(response.status, url).toBe(200);
      expect(await response.text()).toContain("test ui");
    }
  });
});

describe("objects", () => {
  it("boots every class at its schema", async () => {
    const name = crypto.randomUUID();
    const described = await Promise.all([
      env.DIRECTORY.getByName(name).describe(),
      env.SPACE.getByName(name).describe(),
      env.OWNER.getByName(name).describe(),
      env.PROCESS.getByName(`${name}/p`).describe(),
      env.VOLUME.getByName(`${name}/v`).describe(),
      env.TARGET.getByName(`${name}/t`).describe(),
    ]);
    expect(described.map(entry => entry.class)).toEqual(["Directory", "Space", "Owner", "Process", "Volume", "Target"]);
    expect(described.every(entry => entry.schema >= 1)).toBe(true);
  });

  it("refuses to run code older than an object's recorded schema", async () => {
    await runInDurableObject(env.PROCESS.getByName(`${crypto.randomUUID()}/p`), async (_object, ctx) => {
      ctx.storage.sql.exec("UPDATE _schema SET version = 99 WHERE id = 1");
      expect(() => migrate(ctx.storage, [{ version: 1, sql: "SELECT 1" }])).toThrow(expect.objectContaining({ code: "unavailable" }));
    });
  });

  it("refuses calls that carry an older space-link generation", async () => {
    const owner = crypto.randomUUID();
    const volume = env.VOLUME.getByName(`${owner}/home`);
    await volume.init({ owner, volume: "home", space: "s2", generation: 2 });
    // Settle the RPC promise directly: `expect().rejects` leaves vitest-pool-workers reporting it unhandled.
    const refused = await volume.init({ owner, volume: "home", space: "s1", generation: 1 }).then(() => null, (cause: unknown) => cause);
    expect(refused).toMatchObject({ code: "moved" });
  });
});
