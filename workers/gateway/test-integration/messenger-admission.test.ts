import { createHmac } from "node:crypto";
import type { JsonObject, JsonValue, AdapterPairConfirmResult } from "@humansandmachines/gsv/protocol";
import type { TestHarness } from "wrangler";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { adapterWorkers, createMessengerHarness, messengerGate, messengerGateway, messengers, providerWorkers, type Messenger } from "./messenger-harness";
import type { AdmissionRecord } from "./fixtures/messenger-gate";
import type { DiscordApplication } from "../../adapters/discord/src/shared-application";

type Worker = ReturnType<TestHarness["getWorker"]>;
type Socket = NonNullable<Awaited<ReturnType<Worker["fetch"]>>["webSocket"]>;
type ResponseFrame = { type: "res"; id: string; ok: boolean; data?: JsonValue; error?: { message: string; code: number } };
type ObservedAdmission = Omit<AdmissionRecord, "response"> & { response?: ResponseFrame | null };
type ProviderMessage = { body: { text?: string; content?: string; channel?: string; chat_id?: string | number }; channel?: string; method?: string };
type Handle = "first" | "second";
const installation = (handle: Handle) => `inst_integration_${handle}`;
let sequence = 10000;

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Composed messenger contract did not reach the expected state");
}

async function rpc(socket: Socket, call: string, args: JsonObject): Promise<ResponseFrame> {
  const id = crypto.randomUUID();
  const response = new Promise<ResponseFrame>((resolve, reject) => {
    const listener = (event: { data: unknown }) => {
      // SAFETY: Test-owned sockets receive the Gateway frame protocol.
      const frame = JSON.parse(String(event.data)) as ResponseFrame;
      if (frame.type !== "res" || frame.id !== id) return;
      clearTimeout(timeout); socket.removeEventListener("message", listener); resolve(frame);
    };
    const timeout = setTimeout(() => { socket.removeEventListener("message", listener); reject(new Error(`Timed out waiting for ${call}`)); }, 20_000);
    socket.addEventListener("message", listener);
  });
  socket.send(JSON.stringify({ type: "req", id, call, args }));
  return await response;
}
async function ok(socket: Socket, call: string, args: JsonObject): Promise<JsonValue | undefined> {
  const response = await rpc(socket, call, args);
  expect(response, call).toMatchObject({ ok: true });
  return response.data;
}

describe("W6 real messenger → Gateway → Kernel admission", () => {
  let harness: TestHarness;
  let removeFixtures: () => void;
  const sockets: Socket[] = [];
  beforeAll(async () => {
    ({ harness, removeFixtures } = createMessengerHarness());
    await harness.listen();
  });
  afterEach(async () => { sockets.splice(0).forEach((socket) => socket.close(1000, "fixture complete")); await harness.reset(); });
  afterAll(async () => { await harness.close(); removeFixtures(); });

  const worker = () => harness.getWorker(messengerGateway);
  async function socket(handle: Handle): Promise<Socket> {
    const response = await worker().fetch(`https://${handle}.gsv.space/ws`, { headers: { Upgrade: "websocket" } });
    expect(response.status).toBe(101);
    if (!response.webSocket) throw new Error("Gateway did not return a socket");
    response.webSocket.accept(); sockets.push(response.webSocket); return response.webSocket;
  }
  async function setup(handle: Handle) {
    await harness.getWorker("gsv-test-dependencies").fetch(`https://fixture/__test/provisioning?handle=${handle}`, { method: "POST" });
    const owner = await socket(handle);
    await ok(owner, "sys.setup", { username: "person", password: "person-password", rootPassword: "root-password", onboardingToken: `integration-onboarding-${handle}` });
    await ok(owner, "sys.connect", { protocol: 4, peer: { id: `${handle}-human`, version: "1", platform: "test" }, auth: { username: "person", password: "person-password" } });
    const root = await socket(handle);
    await ok(root, "sys.connect", { protocol: 4, peer: { id: `${handle}-root`, version: "1", platform: "test" }, auth: { username: "root", password: "root-password" } });
    return { owner, root };
  }
  async function control(command: { hold?: string; release?: string; loseFinalize?: string }) {
    expect((await harness.getWorker(messengerGate).fetch("https://fixture/control", { method: "POST", body: JSON.stringify(command) })).status).toBe(204);
  }
  async function records(): Promise<ObservedAdmission[]> {
    // SAFETY: The owned messenger gate returns its recorded frame projection.
    const rows = await (await harness.getWorker(messengerGate).fetch("https://fixture/records")).json() as AdmissionRecord[];
    return rows.map((row) => {
      const { response, ...record } = row;
      if (response === undefined) return record;
      // SAFETY: The gate serializes real Gateway responses verbatim for the assertion side.
      return { ...record, response: JSON.parse(response) as ResponseFrame | null };
    });
  }
  async function received(text: string, complete = true): Promise<ObservedAdmission> {
    const rows = await until(records, (rows) => rows.some((row) => row.direction === "inbound" && row.text === text && (!complete || row.response !== undefined)));
    return rows.find((row) => row.direction === "inbound" && row.text === text)!;
  }
  async function provider(adapter: Messenger, path: string, body?: JsonObject) {
    return await harness.getWorker(providerWorkers[adapter]).fetch(`https://fixture${path}`, body ? { method: "POST", body: JSON.stringify(body) } : undefined);
  }
  async function messages(adapter: Messenger): Promise<ProviderMessage[]> {
    // SAFETY: Each owned provider fixture exposes its synthetic delivery log.
    return await (await provider(adapter, adapter === "telegram" ? "/messages" : adapter === "slack" ? "/calls" : "/sent")).json() as ProviderMessage[];
  }
  function actor(adapter: Messenger, index: 0 | 1) { return adapter === "telegram" ? ["12345", "54321"][index]! : adapter === "slack" ? ["UALICE01", "UBOB0001"][index]! : ["2101", "2102"][index]!; }
  async function start(adapter: Messenger) {
    if (adapter === "slack") {
      const start = await harness.getWorker(adapterWorkers.slack).fetch("https://slack.test/slack/install", { redirect: "manual" });
      expect(start.status).toBe(302);
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const cookie = start.headers.get("set-cookie")!.split(";", 1)[0]!;
      expect((await harness.getWorker(adapterWorkers.slack).fetch(`https://slack.test/slack/oauth/callback?code=test-code&state=${encodeURIComponent(state)}`, { headers: { cookie } })).status).toBe(200);
    } else if (adapter === "discord") {
      const env = await harness.getWorker<{ DISCORD_APPLICATION: DurableObjectNamespace<DiscordApplication> }>(adapterWorkers.discord).getEnv();
      const application = env.DISCORD_APPLICATION.getByName("application:1000");
      await application.ensureStarted();
      await until(() => application.getStatus(), (status) => status.connected);
    }
  }
  async function send(adapter: Messenger, index: 0 | 1, text: string, options: { id?: string; group?: boolean; invalidProof?: boolean; forge?: boolean } = {}) {
    const id = options.id ?? String(++sequence);
    const who = actor(adapter, index);
    const forged: JsonObject = options.forge ? { installationId: installation(index === 0 ? "second" : "first"), localUid: 0 } : {};
    if (adapter === "discord") {
      if (options.invalidProof) {
        await provider(adapter, "/dispatch", { t: "READY", d: { session_id: "forged", application: { id: "9999" }, user: { id: "9999" } } });
        const env = await harness.getWorker<{ DISCORD_APPLICATION: DurableObjectNamespace<DiscordApplication> }>(adapterWorkers.discord).getEnv();
        await until(() => env.DISCORD_APPLICATION.getByName("application:1000").getStatus(), (status) => !status.connected);
        return id;
      }
      if (options.group) await provider(adapter, "/dispatch", { t: "GUILD_CREATE", d: { id: "4001", name: "Shared server" } });
      const message: JsonObject = { id, channel_id: options.group ? "5001" : `8${who}`, author: { id: who, username: "person" }, content: text, mentions: [{ id: "1000" }], ...forged };
      if (options.group) message.guild_id = "4001";
      await provider(adapter, "/dispatch", { t: "MESSAGE_CREATE", d: message });
    } else if (adapter === "telegram") {
      const response = await harness.getWorker(adapterWorkers.telegram).fetch("https://telegram.test/webhook", { method: "POST", headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": options.invalidProof ? "forged" : "test_webhook_secret_123" }, body: JSON.stringify({ update_id: Number(id), message: { message_id: Number(id), date: Math.floor(Date.now() / 1000), text, chat: { id: Number(who), type: "private" }, from: { id: Number(who), is_bot: false, first_name: "Person" }, ...forged } }) });
      expect(response.status).toBe(options.invalidProof ? 403 : 200);
    } else {
      const event: JsonObject = { type: options.group ? "app_mention" : "message", user: who, channel: options.group ? "CGENERAL1" : index === 0 ? "DALICE01" : "DBOB0001", text, ts: `${id}.000100`, ...forged };
      if (!options.group) event.channel_type = "im";
      const body = JSON.stringify({ type: "event_callback", team_id: "TWORK123", api_app_id: "AGSV1234", event_id: `Ev${id}`, event_time: Math.floor(Date.now() / 1000), event });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", "signing_secret_123456789").update(`v0:${timestamp}:${body}`).digest("hex");
      const response = await harness.getWorker(adapterWorkers.slack).fetch("https://slack.test/slack/events", { method: "POST", headers: { "content-type": "application/json", "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${options.invalidProof ? "0".repeat(64) : signature}` }, body });
      expect(response.status).toBe(options.invalidProof ? 403 : 200);
    }
    return id;
  }
  async function issue(adapter: Messenger, index: 0 | 1, group = false) {
    const before = (await messages(adapter)).length;
    await send(adapter, index, adapter === "telegram" ? "/start" : adapter === "slack" ? "connect" : "pair", { group });
    const rows = await until(() => messages(adapter), (rows) => rows.slice(before).some((row) => /[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){2}/.test(row.body.text ?? row.body.content ?? "")));
    const text = rows.slice(before).map((row) => row.body.text ?? row.body.content ?? "").find((text) => /[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){2}/.test(text))!;
    return text.match(/[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){2}/)![0];
  }
  async function pair(adapter: Messenger, index: 0 | 1, owner: Socket, group = false): Promise<AdapterPairConfirmResult> {
    const code = await issue(adapter, index, group);
    // SAFETY: This successful syscall returns the public pairing confirmation contract.
    return await ok(owner, "adapter.pair.confirm", { adapter, code }) as AdapterPairConfirmResult;
  }
  async function assertAdmitted(text: string, handle: Handle) {
    const record = await received(text);
    expect(record.installationId).toBe(installation(handle));
    expect(record.response).toMatchObject({ ok: true, data: { ok: true, delivered: { uid: 1000, pid: expect.any(String), runId: expect.any(String) } } });
    const { data: { delivered } } = z.object({ data: z.object({ delivered: z.object({ uid: z.literal(1000), pid: z.string(), runId: z.string() }) }) }).parse(record.response);
    const storage = await worker().getDurableObjectStorage("KERNEL", { name: installation(handle) });
    const rows = await storage.exec("SELECT state, result_json FROM adapter_ingress_receipts WHERE json_extract(result_json, '$.delivered.runId') = ?", delivered.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("completed");
    expect(JSON.parse(String(rows[0]?.result_json))).toMatchObject({ delivered });
    expect(await storage.exec("SELECT owner_uid FROM processes WHERE process_id = ?", delivered.pid)).toEqual([{ owner_uid: 1000 }]);
  }
  async function admittedCount(handle: Handle) {
    const storage = await worker().getDurableObjectStorage("KERNEL", { name: installation(handle) });
    return Number((await storage.exec("SELECT count(*) AS total FROM adapter_ingress_receipts WHERE json_extract(result_json, '$.delivered') IS NOT NULL"))[0]?.total ?? 0);
  }
  function outbound(adapter: Messenger, linked: AdapterPairConfirmResult, text: string, deliveryId = crypto.randomUUID()): JsonObject {
    return { adapter, accountId: linked.accountId, surface: { kind: "dm", id: linked.surfaceId }, text, deliveryId };
  }
  async function attempts(adapter: Messenger): Promise<{ text: string; destination: string; nonce?: string }[]> {
    // SAFETY: The owned provider wrapper emits this allowlisted attempt projection.
    return await (await provider(adapter, "/__test/attempts")).json() as { text: string; destination: string; nonce?: string }[];
  }

  it("unknown wildcard hosts allocate no Kernel before messenger setup", async () => {
    expect((await worker().fetch("https://arbitrary.gsv.space/ws", { headers: { Upgrade: "websocket" } })).status).toBe(404);
    expect(await worker().listDurableObjectIds("KERNEL")).toEqual([]);
  });

  for (const adapter of messengers) {
    it(`${adapter}: invalid proof and an unpaired actor select no Kernel`, async () => {
      await start(adapter);
      await send(adapter, 0, "unpaired human work", { forge: true });
      await until(() => messages(adapter), (rows) => rows.some((row) => /[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){2}/.test(row.body.text ?? row.body.content ?? "")));
      expect(await records()).toEqual([]);
      expect(await worker().listDurableObjectIds("KERNEL")).toEqual([]);
      await send(adapter, 1, "invalid provider proof", { invalidProof: true, forge: true });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await records()).toEqual([]);
      expect(await worker().listDurableObjectIds("KERNEL")).toEqual([]);
    });

    it(`${adapter}: real human confirmation recovers a lost response and isolates two colliding accounts`, async () => {
      const a = await setup("first"); const b = await setup("second"); await start(adapter);
      const code = await issue(adapter, 0);
      const anonymous = await socket("first");
      expect(await rpc(anonymous, "adapter.pair.confirm", { adapter, code })).toMatchObject({ ok: false });
      await control({ loseFinalize: adapter });
      expect(await rpc(a.owner, "adapter.pair.confirm", { adapter, code })).toMatchObject({ ok: false });
      const storage = await worker().getDurableObjectStorage("KERNEL", { name: installation("first") });
      const selected = await storage.exec("SELECT account_id, actor_id, uid, json_extract(metadata_json, '$.routeGeneration') AS generation FROM identity_links WHERE adapter = ?", adapter);
      expect(selected).toHaveLength(1);
      const linked = await ok(a.owner, "adapter.pair.confirm", { adapter, code });
      expect(linked).toMatchObject({ paired: true, uid: 1000 });
      expect(await storage.exec("SELECT account_id, actor_id, uid, json_extract(metadata_json, '$.routeGeneration') AS generation FROM identity_links WHERE adapter = ?", adapter)).toEqual(selected);
      expect(await rpc(b.owner, "adapter.pair.confirm", { adapter, code })).toMatchObject({ ok: false });
      await pair(adapter, 1, b.owner);
      await send(adapter, 0, "first owned request", { forge: true }); await assertAdmitted("first owned request", "first");
      await send(adapter, 1, "second owned request", { forge: true }); await assertAdmitted("second owned request", "second");
      if (adapter !== "telegram") {
        if (adapter === "discord") { await pair(adapter, 0, a.owner, true); await pair(adapter, 1, b.owner, true); }
        await send(adapter, 0, "first shared room", { group: true }); await assertAdmitted("first shared room", "first");
        await send(adapter, 1, "second shared room", { group: true }); await assertAdmitted("second shared room", "second");
      }
    });

    for (const change of ["restricted", "account removed", "disconnected"] as const) {
      it(`${adapter}: refuses held ingress after ${change} while the other space remains usable`, async () => {
        const a = await setup("first"); const b = await setup("second"); await start(adapter);
        const link = await pair(adapter, 0, a.owner); await pair(adapter, 1, b.owner);
        const text = `held ${change}`;
        await control({ hold: text }); await send(adapter, 0, text); await received(text, false);
        const before = await admittedCount("first");
        if (change === "restricted") {
          expect((await harness.getWorker("gsv-test-dependencies").fetch("https://fixture/__test/installation-state?handle=first&state=restricted", { method: "POST" })).status).toBe(204);
        } else if (change === "account removed") {
          await ok(a.root, "account.remove", { uid: 1000 });
        } else {
          await ok(a.owner, "adapter.pair.disconnect", { adapter, accountId: link.accountId, actorId: link.actorId });
        }
        await send(adapter, 1, "other actor stays usable"); await assertAdmitted("other actor stays usable", "second");
        await control({ release: text });
        const held = await received(text);
        expect(held.installationId).toBe(installation("first"));
        if (change === "restricted") expect(held.response).toMatchObject({ ok: false, error: { code: 423 } });
        else expect(held.response).toMatchObject({ ok: true, data: { ok: true, droppedReason: "stale_route_generation" } });
        expect(await admittedCount("first")).toBe(before);
      });
    }

    it(`${adapter}: relink fences held ingress and outbound delivery without removing either current actor`, async () => {
      const a = await setup("first"); const b = await setup("second"); await start(adapter);
      const oldLink = await pair(adapter, 0, a.owner); await pair(adapter, 1, b.owner);
      expect(await rpc(a.owner, "adapter.send", outbound(adapter, oldLink, "delivery before relink"))).toMatchObject({ ok: true, data: { ok: true, deliveryState: "sent" } });
      const moveCode = await issue(adapter, 0);
      await control({ hold: "old ingress" }); await control({ hold: "old outbound" });
      await send(adapter, 0, "old ingress"); await received("old ingress", false);
      const sending = rpc(a.owner, "adapter.send", outbound(adapter, oldLink, "old outbound"));
      try {
        await until(records, (rows) => rows.some((row) => row.direction === "outbound" && row.text === "old outbound"));
        await ok(b.owner, "adapter.pair.confirm", { adapter, code: moveCode });
        await control({ release: "old ingress" }); await control({ release: "old outbound" });
        expect((await received("old ingress")).response).toMatchObject({ ok: true, data: { droppedReason: "stale_route_generation" } });
        const sent = await sending;
        // SAFETY: adapter.send returns an AdapterSendResult when its syscall succeeds.
        expect(sent.ok && (sent.data as { ok?: boolean })?.ok).not.toBe(true);
        expect((await attempts(adapter)).some((entry) => entry.text === "old outbound")).toBe(false);
        expect(await admittedCount("first")).toBe(0);
        await ok(a.owner, "adapter.pair.disconnect", { adapter, accountId: oldLink.accountId, actorId: oldLink.actorId });
        await send(adapter, 0, "moved actor reaches replacement"); await assertAdmitted("moved actor reaches replacement", "second");
        await send(adapter, 1, "existing actor remains linked"); await assertAdmitted("existing actor remains linked", "second");
      } finally {
        await control({ release: "old ingress" }); await control({ release: "old outbound" });
        await sending.catch(() => undefined);
      }
    });

    it(`${adapter}: provider retries admit once and retain delivery identity through retry and ambiguous acceptance`, async () => {
      const a = await setup("first"); await setup("second"); await start(adapter);
      const linked = await pair(adapter, 0, a.owner);
      const id = await send(adapter, 0, "unique inbound"); await assertAdmitted("unique inbound", "first");
      await send(adapter, 0, "unique inbound", { id });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await admittedCount("first")).toBe(1);
      expect((await records()).filter((row) => row.direction === "inbound" && row.text === "unique inbound")).toHaveLength(1);

      const retry = outbound(adapter, linked, "safely retryable send");
      await provider(adapter, "/__test/outcome", { text: "safely retryable send", kind: "retryable" });
      const first = await rpc(a.owner, "adapter.send", retry);
      expect(first, JSON.stringify(first)).toMatchObject({ ok: true, data: { ok: false, retryable: true } });
      const retriedResponse = await rpc(a.owner, "adapter.send", retry);
      expect(retriedResponse, JSON.stringify(retriedResponse)).toMatchObject({ ok: true, data: { ok: true } });
      const retried = (await attempts(adapter)).filter((entry) => entry.text === "safely retryable send");
      expect(retried).toHaveLength(2);
      expect(new Set(retried.map((entry) => entry.destination)).size).toBe(1);
      expect(new Set(retried.map((entry) => entry.nonce)).size).toBe(1);
      const wires = (await records()).filter((row) => row.direction === "outbound" && row.text === "safely retryable send");
      expect(new Set(wires.map((row) => row.deliveryId)).size).toBe(1);

      const ambiguous = outbound(adapter, linked, "provider accepted but response lost");
      await provider(adapter, "/__test/outcome", { text: "provider accepted but response lost", kind: "ambiguous" });
      expect(await rpc(a.owner, "adapter.send", ambiguous)).toMatchObject({ ok: true, data: { ok: true, deliveryState: "ambiguous" } });
      expect(await rpc(a.owner, "adapter.send", ambiguous)).toMatchObject({ ok: true, data: { ok: true, deliveryState: "ambiguous" } });
      expect((await attempts(adapter)).filter((entry) => entry.text === "provider accepted but response lost")).toHaveLength(1);
    });
  }
});
