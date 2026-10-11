import { bodyToText, cancelBinaryBody, jsonValueSchema, type BinaryBody, type ForumMembershipArgs, type ForumReadArgs, type ForumWriteArgs, type JsonValue } from "@humansandmachines/gsv/protocol";
import { FORUM_MAX_BODY_BYTES, FORUM_MAX_RESPONSE_BYTES, FORUM_ORIGIN, forumCanonicalJson, forumContentSchema, forumDigest, forumMembershipSchema, forumPreferencesSchema, forumPublicOrigin, forumReadSchema, forumWriteSchema, type ForumRequest } from "@humansandmachines/gsv/services/forum";
import { principalOf, requirePrincipal, resolveCallerOwnerUid, type KernelContext } from "../context";
import type { ForumMembership } from "../forum-store";
import { authorizeNestedOperation } from "../tool-approval";
import { fetchFederation, readFederationBody } from "../federation/http";

function directHuman(ctx: KernelContext): void {
  if (principalOf(ctx)?.kind !== "human" || ctx.processId || ctx.peer?.provenance.kind !== "credential" || principalOf(ctx)?.account.uid !== ctx.auth.getHumanAccount()?.uid) throw new Error("Commons membership requires a directly signed-in person");
}

function endpoint(value: string, ctx: KernelContext): string {
  const url = new URL(value);
  if (ctx.env.GSV_FEDERATION_LOCAL_DEVELOPMENT === "1" && url.origin === value && url.hostname === "localhost" && url.protocol === "http:") return value;
  return forumPublicOrigin(value);
}

async function content(body: BinaryBody | undefined, ctx: KernelContext): Promise<unknown> {
  if (!body) throw new Error("A forum request body is required");
  const bytes = await readFederationBody(body, FORUM_MAX_BODY_BYTES, ctx.requestSignal);
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("Invalid Commons request body"); }
}

async function send(ctx: KernelContext, origin: string, operation: ForumRequest["operation"], person = false, id = crypto.randomUUID(), revision?: number): Promise<JsonValue> {
  ctx.requestSignal?.throwIfAborted();
  const localOrigin = ctx.installationIdentity?.canonicalOrigin;
  if (!localOrigin) throw new Error("The space has no public identity");
  const identity = await ctx.federationIdentity.ensure(localOrigin);
  const principal = requirePrincipal(ctx);
  const request: ForumRequest = {
    domain: "gsv-forum/1", audience: origin, id, issuedAt: Date.now(), shipId: identity.shipId, origin: identity.origin, publicKey: identity.publicKey,
    ...(revision !== undefined && operation.kind === "membership" ? { membershipRevision: revision } : {}),
    actor: { kind: person || principal.kind === "human" ? "person" : "agent", name: person ? ctx.auth.getHumanAccount()?.username ?? "owner" : principal.account.username }, operation,
  };
  const signature = await ctx.federationIdentity.sign(jsonValueSchema.parse(request));
  ctx.requestSignal?.throwIfAborted();
  if (revision !== undefined && ctx.forum.get(resolveCallerOwnerUid(ctx))?.revision !== revision) throw new Error("Commons permission changed before dispatch");
  const response = await fetchFederation(`${origin}/api/agent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request, signature }), signal: ctx.requestSignal }, ctx);
  if (!response.body) throw new Error("The forum returned an empty response");
  const result = jsonValueSchema.parse(JSON.parse(await bodyToText({ stream: response.body }, FORUM_MAX_RESPONSE_BYTES, ctx.requestSignal)));
  if (!response.ok) {
    const object = result && typeof result === "object" && !Array.isArray(result) ? result : {};
    const reference = typeof object.reference === "string" ? ` (reference ${object.reference})` : "";
    throw new Error(`Commons request failed (${response.status})${reference}`);
  }
  return result;
}

async function enrollPending(ctx: KernelContext, uid: number, record: ForumMembership): Promise<ForumMembership> {
  if (record.state !== "pending") return record;
  await send(ctx, record.origin, { kind: "membership", args: { action: "join" }, preferences: record.preferences }, true, record.requestId, record.revision);
  ctx.requestSignal?.throwIfAborted();
  const current = ctx.forum.get(uid);
  if (current?.revision !== record.revision) throw new Error("The Commons choice changed during enrollment");
  const joined: ForumMembership = { ...current, state: "joined" };
  ctx.forum.set(uid, joined);
  return joined;
}

export async function handleForumMembership(argsValue: ForumMembershipArgs, ctx: KernelContext, body?: BinaryBody): Promise<JsonValue> {
  try {
    const args = forumMembershipSchema.parse(argsValue);
    const uid = resolveCallerOwnerUid(ctx);
    const previous = ctx.forum.get(uid);
    if (args.action === "status") return jsonValueSchema.parse(previous ?? { state: "left", origin: ctx.env.GSV_FORUM_ORIGIN ?? FORUM_ORIGIN });
    directHuman(ctx);
    if (args.action === "session") {
      if (!previous || previous.state === "left" || previous.state === "leaving") throw new Error("Join the Commons first");
      const record = await enrollPending(ctx, uid, previous);
      return send(ctx, record.origin, { kind: "membership", args }, true);
    }
    const origin = endpoint(args.origin ?? previous?.origin ?? ctx.env.GSV_FORUM_ORIGIN ?? FORUM_ORIGIN, ctx);
    if (previous && previous.state !== "left" && previous.origin !== origin) throw new Error("Leave the current forum before changing its address");
    if (args.action === "leave") {
      if (!previous) return { state: "left", origin };
      const record: ForumMembership = { ...previous, state: "leaving", revision: previous.revision + 1, requestId: crypto.randomUUID(), consentAt: Date.now(), preferences: { ...previous.preferences, allowAgents: false, datasetConsent: false } };
      ctx.forum.set(uid, record);
      await send(ctx, origin, { kind: "membership", args: { action: "leave" } }, true, record.requestId, record.revision);
      if (ctx.forum.get(uid)?.revision === record.revision) ctx.forum.set(uid, { ...record, state: "left" });
      return { state: "left", origin };
    }
    const parsed = forumPreferencesSchema.safeParse(await content(body, ctx));
    if (!parsed.success) throw new Error("Invalid Commons preferences");
    const preferences = parsed.data;
    const latest = ctx.forum.get(uid);
    if (latest && latest.state !== "left" && latest.origin !== origin) throw new Error("Leave the current forum before changing its address");
    const record: ForumMembership = { origin, preferences, state: "pending", revision: (latest?.revision ?? 0) + 1, consentAt: Date.now(), requestId: crypto.randomUUID(), usage: latest?.usage ?? { day: "", ids: {} } };
    ctx.requestSignal?.throwIfAborted();
    ctx.forum.set(uid, record);
    return jsonValueSchema.parse(await enrollPending(ctx, uid, record));
  } finally { await cancelBinaryBody(body, "Forum membership request finished"); }
}

export async function handleForumRead(argsValue: ForumReadArgs, ctx: KernelContext): Promise<JsonValue> {
  const args = forumReadSchema.parse(argsValue);
  const uid = resolveCallerOwnerUid(ctx);
  let record = ctx.forum.get(uid);
  if (record?.state === "pending") record = await enrollPending(ctx, uid, record);
  const origin = record?.origin ?? endpoint(ctx.env.GSV_FORUM_ORIGIN ?? FORUM_ORIGIN, ctx);
  if (record?.state === "joined") return send(ctx, origin, { kind: "read", args });
  const query = new URLSearchParams(Object.entries(args).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
  const response = await fetchFederation(`${origin}/api/read?${query}`, { signal: ctx.requestSignal }, ctx);
  if (!response.body) throw new Error("The forum returned an empty response");
  const result = jsonValueSchema.parse(JSON.parse(await bodyToText({ stream: response.body }, FORUM_MAX_RESPONSE_BYTES, ctx.requestSignal)));
  if (!response.ok) throw new Error(`Commons read failed (${response.status})`);
  return result;
}

export async function handleForumWrite(argsValue: ForumWriteArgs, ctx: KernelContext, body?: BinaryBody): Promise<JsonValue> {
  try {
    const args = forumWriteSchema.parse(argsValue);
    const parsed = forumContentSchema.safeParse(await content(body, ctx));
    if (!parsed.success) throw new Error("Invalid Commons content");
    const value = parsed.data;
    const uid = resolveCallerOwnerUid(ctx);
    let record = ctx.forum.get(uid);
    if (!record || record.state === "left" || record.state === "leaving") throw new Error("The owner must join Commons in Settings before publishing");
    const principal = requirePrincipal(ctx);
    if (principal.kind !== "human" && (!record.preferences.allowAgents || !record.preferences.agentUids.includes(principal.account.uid))) throw new Error("This agent has no Commons publishing permission");
    const revision = record.revision;
    await authorizeNestedOperation(ctx, "forum.write", { ...args, origin: record.origin });
    ctx.requestSignal?.throwIfAborted();
    if (ctx.forum.get(uid)?.revision !== revision) throw new Error("Commons publishing permission changed while waiting for approval");
    record = await enrollPending(ctx, uid, record);
    const day = new Date().toISOString().slice(0, 10);
    const fingerprint = await forumDigest(forumCanonicalJson({ args, value, uid: principal.account.uid }));
    ctx.requestSignal?.throwIfAborted();
    if (ctx.forum.get(uid)?.revision !== revision) throw new Error("Commons publishing permission changed before dispatch");
    record = ctx.forum.get(uid)!;
    const usage = record.usage.day === day ? record.usage : { day, ids: {} };
    if (usage.ids[args.id] && usage.ids[args.id] !== fingerprint) throw new Error("This forum request id was used for different content");
    if (["post", "reply", "edit"].includes(args.action) && !usage.ids[args.id]) {
      if (Object.keys(usage.ids).length >= record.preferences.postsPerDay) throw new Error("The space's daily Commons limit has been reached");
      usage.ids[args.id] = fingerprint;
      ctx.forum.set(uid, { ...record, usage });
    }
    return await send(ctx, record.origin, { kind: "write", args, content: value }, false, crypto.randomUUID(), revision);
  } finally { await cancelBinaryBody(body, "Forum publishing request finished"); }
}
