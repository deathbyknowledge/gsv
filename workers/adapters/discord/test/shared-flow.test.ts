import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { SharedDiscordEnv } from "../src/shared-application";
import type { SharedDiscordChannel } from "../src/shared";
import { discordAccount, discordActor, discordPeerName } from "../src/shared-identity";
import { binaryBodyFromOwnedBytes } from "../../shared/src/media-body";
import type { JsonObject } from "../../../../packages/gsv/src/protocol/json";
import { AdapterPairingClaim, type AdapterPairingClaimRecord } from "../../shared/src/pairing-claim";
import type { AdapterPairingPreparation } from "../../shared/src/types";

// SAFETY: the fixture Wrangler file declares these concrete namespaces and service entrypoints.
const bindings = env as SharedDiscordEnv & { TARGET_ADAPTER: Pick<SharedDiscordChannel, "adapterFrame" | "adapterPairingInspect" | "adapterPairingPrepare" | "adapterPairingActivate" | "adapterPairingFinalize"> };
const adapter = bindings.TARGET_ADAPTER;
const application = bindings.DISCORD_APPLICATION.getByName("application:1000");
type ProviderSent = { id: string; channel: string; body: { content?: string; nonce?: string } };
type GatewayCall = { call: string; installation: { installationId: string }; args?: { deliveryId: string; routeGeneration: string; message: { text: string; actor: { id: string }; surface: { id: string } } }; input?: { expectedGeneration: string }; bytes?: number[] };
async function provider(path: string, data?: JsonObject) {
  return await bindings.DISCORD_API!.fetch(`https://fixture${path}`, data ? { method: "POST", body: JSON.stringify(data) } : undefined);
}
async function sent(): Promise<ProviderSent[]> { return await (await provider("/sent")).json(); }
async function calls(): Promise<GatewayCall[]> { return await (await bindings.GATEWAY.fetch("https://fixture/calls")).json(); }
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) { const value = await read(); if (ready(value)) return value; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("Fixture did not reach expected state");
}
async function start() {
  await application.ensureStarted();
  await until(() => application.getStatus(), (status) => status.connected);
}
async function message(id: string, actor: string, text: string, guild?: string, channel = `8${actor}`) {
  if (guild) await provider("/dispatch", { t: "GUILD_CREATE", d: { id: guild, name: "Fixture server" } });
  const data: JsonObject = { id, channel_id: channel, author: { id: actor, username: `Person ${actor}` }, content: text, mentions: [{ id: "1000" }] };
  if (guild) data.guild_id = guild;
  await provider("/dispatch", { t: "MESSAGE_CREATE", d: data });
}
async function issue(actor: string, id: string, guild?: string): Promise<string> {
  await message(id, actor, "pair", guild);
  const messages = await until(sent, (rows) => rows.some((row) => row.channel === `8${actor}` && row.body.content?.includes("Pairing code:")));
  const code = messages.filter((row) => row.channel === `8${actor}` && row.body.content?.includes("Pairing code:")).at(-1)!.body.content!.match(/Pairing code: ([A-Z2-9-]+)/)![1];
  return code;
}
async function link(code: string, installationId: string): Promise<AdapterPairingPreparation> {
  const installation = { installationId };
  const input = { code, installationId, localUid: 1000, operationId: crypto.randomUUID(), canonicalOrigin: `https://${installationId}.gsv.test` };
  const prepared = await adapter.adapterPairingPrepare(installation, input);
  const activation = { ...input, route: prepared.route };
  await adapter.adapterPairingActivate(installation, activation);
  await adapter.adapterPairingFinalize(installation, activation);
  return prepared;
}

describe("shared Discord provider → peer → Gateway", () => {
  beforeEach(async () => { await provider("/reset"); await bindings.GATEWAY.fetch("https://fixture/calls", { method: "DELETE" }); });
  it("starts a clean operator connection, accepts control frames, and keeps credentials out of durable state", async () => {
    await start();
    const frames = await (await provider("/received")).json<Array<{ op: number; intents?: number; tokenCorrect?: boolean }>>();
    expect(frames.find((frame) => frame.op === 2)).toMatchObject({ tokenCorrect: true, intents: 4609 });
    await runInDurableObject(application, async (_instance, state) => {
      expect((await state.storage.get<{ botToken: string | null }>("state"))?.botToken).toBeNull();
    });
    await runInDurableObject(application, async (instance) => { await expect(instance.start()).rejects.toThrow("operator-owned"); });
    expect((await SELF.fetch("https://discord.test/start", { method: "POST" })).status).toBe(404);
    expect((await SELF.fetch("https://discord.test/webhook", { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("pairs two people through the shared contract and never accepts a provider-chosen space", async () => {
    await start();
    const first = await issue("2101", "3101");
    expect((await calls()).filter((row) => row.call === "adapter.inbound")).toHaveLength(0);
    const candidate = await adapter.adapterPairingInspect({ installationId: "space-a" }, first);
    expect(candidate).toMatchObject({ actorId: "discord:user:2101", routeScope: "actor", linked: false });
    await expect((async () => await adapter.adapterPairingPrepare({ installationId: "space-a" }, { code: first, installationId: "space-b", localUid: 1000, operationId: "wrong", canonicalOrigin: "https://space-b.gsv.test" }))()).rejects.toThrow("does not match");
    const a = await link(first, "space-a");
    const b = await link(await issue("2102", "3102"), "space-b");
    await provider("/dispatch", { t: "MESSAGE_CREATE", d: { id: "3201", channel_id: "82101", author: { id: "2101", username: "Person A" }, content: "hello", installationId: "space-b", localUid: 0 } });
    await message("3202", "2102", "hello");
    const ingress = (await until(calls, (rows) => rows.filter((row) => row.call === "adapter.inbound").length === 2)).filter((row) => row.call === "adapter.inbound");
    expect(ingress.map((row) => [row.installation.installationId, row.args?.routeGeneration])).toEqual([["space-a", a.route.generation], ["space-b", b.route.generation]]);
    await message("3201", "2101", "duplicate");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await calls()).filter((row) => row.args?.deliveryId === "3201")).toHaveLength(1);
  });

  it("keeps each person in a server separate and delivers pairing codes privately", async () => {
    await start();
    const a = await link(await issue("2201", "3301", "4001"), "server-a");
    const b = await link(await issue("2202", "3302", "4001"), "server-b");
    expect(a.candidate.accountId).toBe(b.candidate.accountId);
    expect(a.candidate.actorId).not.toBe(b.candidate.actorId);
    await message("3401", "2201", "<@1000> hello", "4001", "5001");
    await message("3402", "2202", "<@1000> hello", "4001", "5001");
    const ingress = (await until(calls, (rows) => rows.filter((row) => row.call === "adapter.inbound").length === 2)).filter((row) => row.call === "adapter.inbound");
    expect(new Set(ingress.map((row) => row.installation.installationId))).toEqual(new Set(["server-a", "server-b"]));
    expect((await sent()).filter((row) => row.body.content?.includes("Pairing code:")).every((row) => ["82201", "82202"].includes(row.channel))).toBe(true);
  });

  it("fences a delayed outbound body when a person moves to another space", async () => {
    await start();
    const old = await link(await issue("2301", "3501"), "old-space");
    const peer = bindings.DISCORD_PEER.getByName(discordPeerName(discordAccount("1000"), discordActor("2301")));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const body = binaryBodyFromOwnedBytes(new Uint8Array([1, 2, 3]));
    body.stream = new ReadableStream({ async start(controller) { await gate; controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } });
    const pending = peer.sendMessage("old-space", { deliveryId: "delayed-media", surface: { kind: "dm", id: "82301" }, actorId: "discord:user:2301", routeGeneration: old.route.generation, text: "old-space-private", media: [{ type: "document", mimeType: "application/octet-stream", filename: "fixture.bin", body: { offset: 0, length: 3 } }] }, body);
    await message("3502", "2301", "pair");
    const rows = await until(sent, (values) => values.filter((row) => row.body.content?.includes("Pairing code:")).length === 2);
    const code = rows.filter((row) => row.body.content?.includes("Pairing code:")).at(-1)!.body.content!.match(/Pairing code: ([A-Z2-9-]+)/)![1];
    const replacement = await link(code, "new-space");
    expect(replacement.previousRoute).toEqual(old.route);
    release();
    expect(await pending).toMatchObject({ ok: false, error: "Discord route changed before delivery" });
    expect((await sent()).some((row) => row.body.content === "old-space-private")).toBe(false);
    expect((await calls()).some((row) => row.call === "unlink" && row.input?.expectedGeneration === old.route.generation)).toBe(true);
    await message("3503", "2301", "new hello");
    const current = await until(calls, (values) => values.some((row) => row.args?.deliveryId === "3503"));
    expect(current.find((row) => row.args?.deliveryId === "3503")?.installation.installationId).toBe("new-space");
  });

  it("resumes from the last accepted provider dispatch after a malformed event", async () => {
    await start();
    const before = (await application.getStatus()).extra?.seq;
    await provider("/dispatch", { t: "MESSAGE_CREATE", d: { content: "missing provider identity" } });
    await until(() => application.getStatus(), (status) => !status.connected);
    expect((await application.getStatus()).extra?.seq).toBe(before);
    await runInDurableObject(application, async (instance) => { await instance.alarm(); });
    await until(() => application.getStatus(), (status) => status.connected);
    const frames = await (await provider("/received")).json<Array<{ op: number; seq?: number }>>();
    expect(frames.find((frame) => frame.op === 6)?.seq).toBe(before);
  });

  it("drops durable ingress captured before a relink and keeps the replacement route live", async () => {
    await start();
    const old = await link(await issue("2401", "3601"), "queued-old");
    const peer = bindings.DISCORD_PEER.getByName(discordPeerName(discordAccount("1000"), discordActor("2401")));
    await message("3602", "2401", "pair");
    const rows = await until(sent, (values) => values.filter((row) => row.body.content?.includes("Pairing code:")).length === 2);
    const code = rows.filter((row) => row.body.content?.includes("Pairing code:")).at(-1)!.body.content!.match(/Pairing code: ([A-Z2-9-]+)/)![1];
    await link(code, "queued-new");
    await runInDurableObject(peer, async (_instance, state) => {
      await state.storage.put("discord_peer:inbound:queued-old-message", {
        state: "provider", createdAt: Date.now(), payload: {
          accountId: old.candidate.accountId, actorId: old.candidate.actorId, generation: old.route.generation, mentioned: true,
          message: { id: "3701", channel_id: "82401", author: { id: "2401", username: "Person" }, content: "old queued work" },
        },
      });
    });
    await runInDurableObject(peer, async (instance) => { await instance.alarm(); });
    expect((await calls()).some((row) => row.args?.deliveryId === "3701")).toBe(false);
    await message("3702", "2401", "new work");
    const current = await until(calls, (values) => values.some((row) => row.args?.deliveryId === "3702"));
    expect(current.find((row) => row.args?.deliveryId === "3702")?.installation.installationId).toBe("queued-new");
  });


  it("delivers child approval notices to the linked human with an actionable GSV link", async () => {
    await start();
    const linked = await link(await issue("2501", "3801"), "approval-space");
    const surface = { kind: "dm" as const, id: "82501" };
    const deliveryId = "child-run:hil:approval-1";
    const result = await adapter.adapterFrame({ installationId: "approval-space" }, {
      deliveryId, accountId: linked.candidate.accountId, actorId: linked.candidate.actorId, surface, routeGeneration: linked.route.generation,
      processId: "child", runId: "child-run", processMode: "work",
      hil: { pid: "child", requestId: "approval-1", runId: "child-run", callId: "call-1", toolName: "Shell", syscall: "shell.exec", target: "gsv", args: { input: "fixture command" }, createdAt: Date.now() },
    }, { type: "req", id: "approval-send", call: "adapter.send", args: { adapter: "discord", accountId: linked.candidate.accountId, surface, deliveryId, text: "" } });
    expect(result).toMatchObject({ ok: true, data: { ok: true, deliveryState: "sent" } });
    const approval = (await sent()).find((row) => row.body.content?.includes("fixture command"));
    expect(approval?.channel).toBe("82501");
    expect(approval?.body.content).toContain("https://approval-space.gsv.test");
    expect(await calls()).toHaveLength(0);
  });

  it("keeps finalized claim state when a prior prepare response arrives late", async () => {
    const object = bindings.DISCORD_PAIRING.getByName("pair:ABCDEFGHJKLM");
    await runInDurableObject(object, async (_instance, context) => {
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { started = resolve; });
      const preparation: AdapterPairingPreparation = { candidate: { accountId: "application:1000", actorId: "discord:user:2601", surfaceId: "82601", expiresAt: Date.now() + 60_000, linked: false }, route: { installationId: "race-space", localUid: 1000, generation: "new-generation" } };
      const peer = {
        inspectPairing: async () => preparation.candidate,
        preparePairing: async () => { started(); await gate; return preparation; },
        activatePairing: async () => preparation,
        finalizePairing: async () => preparation,
        sendPairingConfirmation: async () => undefined,
      };
      const owner = new AdapterPairingClaim(context.storage, "claim-fixture", () => peer, { unlinkManagedAdapterIdentity: async () => ({ removed: true }) }, (task) => context.waitUntil(task));
      await owner.initialize({ version: 1, peerName: "fixture-peer", claimId: "fixture-claim", expiresAt: Date.now() + 60_000 });
      const input = { code: "ABCDEFGHJKLM", operationId: "fixture-operation", installationId: "race-space", localUid: 1000, canonicalOrigin: "https://race-space.gsv.test" };
      const pending = owner.prepare(input);
      await entered;
      await owner.activate({ ...input, route: preparation.route });
      await owner.finalize({ ...input, route: preparation.route });
      release();
      await pending;
      expect(await context.storage.get<AdapterPairingClaimRecord>("claim-fixture")).toMatchObject({ operationId: "fixture-operation", stage: "finalized", cleanupComplete: true });
    });
  });


  it("rejects a same-operation prepare replay with another space or local person", async () => {
    await start();
    const code = await issue("2701", "3901");
    const installation = { installationId: "replay-space" };
    const input = { code, ...installation, localUid: 1000, operationId: "stable-operation", canonicalOrigin: "https://replay-space.gsv.test" };
    const prepared = await adapter.adapterPairingPrepare(installation, input);
    await expect((async () => await adapter.adapterPairingPrepare(installation, { ...input, localUid: 1001 }))()).rejects.toThrow("identity changed");
    await expect((async () => await adapter.adapterPairingPrepare({ installationId: "other-space" }, { ...input, installationId: "other-space" }))()).rejects.toThrow("identity changed");
    expect(await adapter.adapterPairingPrepare(installation, input)).toEqual(prepared);
  });

  it("cancels an accepted media body when its peer has no owned state", async () => {
    const peer = bindings.DISCORD_PEER.getByName(discordPeerName(discordAccount("1000"), discordActor("2801")));
    await runInDurableObject(peer, async (instance) => {
      let cancelled = false;
      const body = { length: 3, stream: new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }) };
      await expect(instance.sendMessage("empty-space", { deliveryId: "empty-peer", surface: { kind: "dm", id: "82801" }, actorId: "discord:user:2801", routeGeneration: "generation", text: "fixture" }, body)).rejects.toThrow("not initialized");
      expect(cancelled).toBe(true);
    });
  });

  it("refuses READY for another application before admitting its provider messages", async () => {
    await start();
    await provider("/dispatch", { t: "READY", d: { session_id: "wrong-app", application: { id: "9999" }, resume_gateway_url: "wss://discord.fixture/gateway", user: { id: "9999", username: "Wrong bot" } } });
    await provider("/dispatch", { t: "MESSAGE_CREATE", d: { id: "3951", channel_id: "82901", author: { id: "2901", username: "Person" }, content: "pair" } });
    await until(() => application.getStatus(), (status) => !status.connected);
    expect(await calls()).toHaveLength(0);
    expect(await sent()).toHaveLength(0);
    await runInDurableObject(application, async (_instance, state) => {
      expect(await state.storage.get("botUser")).toEqual({ id: "1000", username: "GSV fixture" });
    });
  });

});
