import { afterEach, describe, expect, it, vi } from "vitest";
import { bodyFromText, type JsonValue } from "@humansandmachines/gsv/protocol";
import { FORUM_TERMS_VERSION, forumCanonicalJson, forumDigest, forumBase64Url, forumEnvelopeSchema, verifyForumEnvelope, type ForumEnvelope } from "@humansandmachines/gsv/services/forum";
import { testPeer } from "../../test-support/peers";
import type { KernelContext } from "../context";
import { processPeerContext } from "../peer";
import { ForumStore, type ForumMembership } from "../forum-store";
import * as transport from "../../shared/utils";
import * as http from "../federation/http";
import { handleForumMembership, handleForumRead, handleForumWrite } from "./forum";

async function fixture() {
  const values = new Map<string, ForumMembership>();
  // The opaque record is cloned on storage reads/writes, as Durable Object KV does.
  // SAFETY: ForumStore only uses synchronous kv.get and kv.put with its owned record.
  const forum = new ForumStore({ kv: { get: (key: string) => structuredClone(values.get(key)), put: (key: string, value: ForumMembership) => values.set(key, structuredClone(value)) } } as DurableObjectStorage);
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicKey = { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! };
  const shipId = `ship:${await forumDigest(forumCanonicalJson(publicKey))}`;
  const identity = { origin: "https://test.gsv.space", shipId, publicKey };
  const account = { uid: 1000, gid: 1000, gids: [100], username: "owner", home: "/home/owner", cwd: "/home/owner" };
  // SAFETY: fixture supplies the exact owning boundaries these handlers consume.
  const ctx = { installationId: "inst_forum", installationIdentity: { canonicalOrigin: identity.origin },
    forum, peer: testPeer({ account }), auth: { getHumanAccount: () => account }, procs: { getOwnerUid: () => 1000 },
    federationIdentity: { ensure: async () => identity, sign: async (value: JsonValue) => forumBase64Url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(forumCanonicalJson(value)))) },
    env: {}, defer: (promise: Promise<unknown>) => { void promise; },
  } as KernelContext;
  const sent: ForumEnvelope[] = [];
  const fetch = vi.spyOn(http, "fetchFederation").mockImplementation(async (_url, init) => {
    if (init.body) sent.push(forumEnvelopeSchema.parse(JSON.parse(String(init.body))));
    return Response.json({ ok: true });
  });
  const preferences = { displayName: "My space", about: "", allowAgents: true, agentUids: [1001], postsPerDay: 2, datasetConsent: false, termsVersion: FORUM_TERMS_VERSION };
  const prefsBody = () => bodyFromText(JSON.stringify(preferences));
  async function join() { await handleForumMembership({ action: "join" }, ctx, prefsBody()); }
  function agent(uid = 1001) {
    ctx.processId = "proc:ship";
    ctx.peer = processPeerContext({ installationId: ctx.installationId, processId: ctx.processId, identity: { ...account, uid, username: "ship" }, calls: ["*"] });
  }
  function post(id = crypto.randomUUID()) { return handleForumWrite({ id, action: "post", board: "building" }, ctx, bodyFromText(JSON.stringify({ title: "Example", text: "Public contribution" }))); }
  return { ctx, forum, preferences, prefsBody, sent, fetch, join, agent, post };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Commons owner boundary", () => {
  it("does not enroll or publish before an explicit owner choice", async () => {
    const f = await fixture();
    await expect(f.post()).rejects.toThrow("owner must join");
    await handleForumRead({ action: "boards" }, f.ctx);
    expect(f.sent).toHaveLength(0);
    expect(await handleForumMembership({ action: "status" }, f.ctx)).toMatchObject({ state: "left" });
    f.agent();
    await expect(handleForumMembership({ action: "join" }, f.ctx, f.prefsBody())).rejects.toThrow("directly signed-in");
  });

  it("signs only explicitly supplied public content and keeps authorship distinct", async () => {
    const f = await fixture(); await f.join(); f.agent(); await f.post();
    expect(f.sent).toHaveLength(2);
    expect(f.sent[0].request).toMatchObject({ actor: { kind: "person" }, membershipRevision: 1 });
    expect(f.sent[1].request).toMatchObject({ actor: { kind: "agent", name: "ship" }, operation: { kind: "write", content: { text: "Public contribution" } } });
    expect(await verifyForumEnvelope(f.sent[1], "https://commons.gsv.space")).toBe(true);
    expect(f.forum.get(1000)?.preferences.datasetConsent).toBe(false);
  });

  it("enrolls the durable onboarding choice once and limits participation to chosen agents", async () => {
    const f = await fixture(); f.forum.seed(1000, "owner", 1001); f.agent(1002);
    await expect(f.post()).rejects.toThrow("no Commons publishing permission");
    expect(f.fetch).not.toHaveBeenCalled();
    f.agent(); await f.post();
    expect(f.forum.get(1000)?.state).toBe("joined");
    expect(f.sent.filter(item => item.request.operation.kind === "membership")).toHaveLength(1);
    f.forum.seed(1000, "changed", 1002);
    expect(f.forum.get(1000)?.preferences.agentUids).toEqual([1001]);
  });

  it("fences a revoked publication while its owning Process waits for approval", async () => {
    const f = await fixture(); await f.join(); f.agent();
    f.ctx.toolOwner = { runId: "run", requestId: "tool" };
    let approve!: () => void;
    const send = vi.spyOn(transport, "sendFrameToProcess").mockImplementation(async () => {
      await new Promise<void>(resolve => { approve = resolve; });
      return { type: "res", id: "approval", ok: true, data: { approved: true } };
    });
    const pending = f.post();
    const rejected = expect(pending).rejects.toThrow("permission changed");
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith("inst_forum", "proc:ship", expect.objectContaining({ args: expect.objectContaining({ args: expect.objectContaining({ origin: "https://commons.gsv.space" }) }) }));
    const record = f.forum.get(1000)!;
    f.forum.set(1000, { ...record, state: "left", revision: record.revision + 1 });
    approve(); await rejected;
    expect(f.sent).toHaveLength(1);
  });

  it("blocks a selected Process when its owner disables agent publishing", async () => {
    const f = await fixture(); await f.join(); f.agent();
    const record = f.forum.get(1000)!;
    f.forum.set(1000, { ...record, preferences: { ...record.preferences, allowAgents: false } });
    await expect(f.post()).rejects.toThrow("no Commons publishing permission");
    expect(f.sent).toHaveLength(1);
  });

  it("counts simultaneous publications without double charging an idempotent retry", async () => {
    const f = await fixture(); await f.join();
    const id = crypto.randomUUID();
    await Promise.all([f.post(id), f.post(id)]);
    expect(Object.keys(f.forum.get(1000)!.usage.ids)).toHaveLength(1);
    const results = await Promise.allSettled([f.post(), f.post(), f.post()]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(Object.keys(f.forum.get(1000)!.usage.ids)).toHaveLength(2);
  });

  it("disables publishing locally even when remote leave fails", async () => {
    const f = await fixture(); await f.join();
    f.fetch.mockRejectedValueOnce(new Error("Offline"));
    await expect(handleForumMembership({ action: "leave" }, f.ctx)).rejects.toThrow("Offline");
    expect(f.forum.get(1000)).toMatchObject({ state: "leaving", preferences: { allowAgents: false, datasetConsent: false } });
    await expect(f.post()).rejects.toThrow("owner must join");
    await handleForumMembership({ action: "leave" }, f.ctx);
    expect(f.forum.get(1000)?.state).toBe("left");
  });

  it("bounds uploads, cancels bodies and does not echo malformed private content", async () => {
    const f = await fixture(); await f.join();
    await expect(handleForumWrite({ id: crypto.randomUUID(), action: "post", board: "building" }, f.ctx, bodyFromText("PRIVATE invalid JSON"))).rejects.toThrow(/^Invalid Commons request body$/);
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = { stream: new ReadableStream<Uint8Array>({ cancel }) };
    const rejected = expect(handleForumWrite({ id: crypto.randomUUID(), action: "post", board: "building" }, f.ctx, body)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10_000); await rejected;
    expect(cancel).toHaveBeenCalledOnce(); expect(body.stream.locked).toBe(false);
  });
});
