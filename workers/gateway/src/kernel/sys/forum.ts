import { cancelBinaryBody, jsonValueSchema, type BinaryBody, type ForumMembershipArgs, type ForumReadArgs, type ForumWriteArgs, type JsonValue } from "@humansandmachines/gsv/protocol";
import { FORUM_MAX_BODY_BYTES, FORUM_ORIGIN, FORUM_TIMEOUT_MS, forumCanonicalJson, forumContentSchema, forumDigest, forumMembershipSchema, forumPreferencesSchema, forumReadSchema, forumWriteSchema, type ForumServiceRequest } from "@humansandmachines/gsv/services/forum";
import { principalOf, requirePrincipal, resolveCallerOwnerUid, type KernelContext } from "../context";
import type { ForumMembership } from "../forum-store";
import { authorizeNestedOperation } from "../tool-approval";
import { readFederationBody } from "../federation/http";
import { raceWithAbort } from "../../shared/abort";

function directHuman(ctx: KernelContext): void {
  if (principalOf(ctx)?.kind !== "human" || ctx.processId || ctx.peer?.provenance.kind !== "credential" || principalOf(ctx)?.account.uid !== ctx.auth.getHumanAccount()?.uid) throw new Error("Commons membership requires a directly signed-in person");
}

function status(ctx: KernelContext, record: ForumMembership | null): JsonValue {
  return jsonValueSchema.parse({ ...record, state: record?.state ?? "left", available: !!ctx.env.COMMONS,
    origin: ctx.env.GSV_FORUM_ORIGIN ?? FORUM_ORIGIN, spaceOrigin: ctx.installationIdentity?.canonicalOrigin ?? null });
}

async function content(body: BinaryBody | undefined, ctx: KernelContext): Promise<JsonValue> {
  if (!body) throw new Error("A forum request body is required");
  const bytes = await readFederationBody(body, FORUM_MAX_BODY_BYTES, ctx.requestSignal);
  try { return jsonValueSchema.parse(JSON.parse(new TextDecoder().decode(bytes))); }
  catch { throw new Error("Invalid Commons request body"); }
}

async function send(ctx: KernelContext, operation: ForumServiceRequest["operation"], id = crypto.randomUUID()): Promise<JsonValue> {
  if (!ctx.env.COMMONS) throw new Error("Commons is not available for this space");
  ctx.requestSignal?.throwIfAborted();
  if (operation.kind !== "read" && ctx.forum.get(resolveCallerOwnerUid(ctx))?.revision !== operation.revision) {
    throw new Error("Commons permission changed before dispatch");
  }
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error("Commons request timed out")), FORUM_TIMEOUT_MS);
  const signal = ctx.requestSignal ? AbortSignal.any([ctx.requestSignal, timeout.signal]) : timeout.signal;
  try {
    const pending = ctx.env.COMMONS.request({ id, installationId: ctx.installationId, ownerUid: resolveCallerOwnerUid(ctx),
      deadlineAt: Date.now() + FORUM_TIMEOUT_MS, operation });
    const result = await raceWithAbort(pending, signal, { onAbort: () => {
      // SAFETY: Workers RPC promises expose disposal to cancel the remote call.
      const rpc = pending as typeof pending & Partial<Disposable>;
      try { rpc[Symbol.dispose]?.(); } catch { /* Cancellation is already terminal. */ }
    } });
    if (!result.ok) throw new Error(`${result.message}${result.reference ? ` (reference ${result.reference})` : ""}`);
    return jsonValueSchema.parse(result.value);
  } finally { clearTimeout(timer); }
}

async function enrollPending(ctx: KernelContext, uid: number, record: ForumMembership): Promise<ForumMembership> {
  if (record.state !== "pending") return record;
  await send(ctx, { kind: "membership", action: "join", preferences: record.preferences, revision: record.revision }, record.requestId);
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
    if (args.action === "status") return status(ctx, previous);
    if (!ctx.env.COMMONS) throw new Error("Commons is not available for this space");
    directHuman(ctx);
    if (args.action === "leave") {
      if (!previous) return status(ctx, null);
      const record: ForumMembership = { ...previous, state: "leaving", revision: previous.revision + 1, requestId: crypto.randomUUID(), consentAt: Date.now(), preferences: { ...previous.preferences, allowAgents: false, datasetConsent: false } };
      ctx.forum.set(uid, record);
      await send(ctx, { kind: "membership", action: "leave", revision: record.revision }, record.requestId);
      if (ctx.forum.get(uid)?.revision === record.revision) ctx.forum.set(uid, { ...record, state: "left" });
      return status(ctx, ctx.forum.get(uid));
    }
    const parsed = forumPreferencesSchema.safeParse(await content(body, ctx));
    if (!parsed.success) throw new Error("Invalid Commons preferences");
    const preferences = parsed.data;
    const latest = ctx.forum.get(uid);
    const record: ForumMembership = { preferences, state: "pending", revision: (latest?.revision ?? 0) + 1, consentAt: Date.now(), requestId: crypto.randomUUID(), usage: latest?.usage ?? { day: "", ids: {} } };
    ctx.requestSignal?.throwIfAborted();
    ctx.forum.set(uid, record);
    return status(ctx, await enrollPending(ctx, uid, record));
  } finally { await cancelBinaryBody(body, "Forum membership request finished"); }
}

export async function handleForumRead(argsValue: ForumReadArgs, ctx: KernelContext): Promise<JsonValue> {
  const args = forumReadSchema.parse(argsValue);
  const uid = resolveCallerOwnerUid(ctx);
  const record = ctx.forum.get(uid);
  if (record?.state === "pending") await enrollPending(ctx, uid, record);
  return await send(ctx, { kind: "read", args });
}

export async function handleForumWrite(argsValue: ForumWriteArgs, ctx: KernelContext, body?: BinaryBody): Promise<JsonValue> {
  try {
    if (!ctx.env.COMMONS) throw new Error("Commons is not available for this space");
    const args = forumWriteSchema.parse(argsValue);
    const parsed = forumContentSchema.safeParse(await content(body, ctx));
    if (!parsed.success) throw new Error("Invalid Commons content");
    const value = parsed.data;
    const uid = resolveCallerOwnerUid(ctx);
    let record = ctx.forum.get(uid);
    if (!record || record.state === "left" || record.state === "leaving") throw new Error("The owner must join Commons in Settings before publishing");
    const principal = requirePrincipal(ctx);
    if (!ctx.processId || ctx.peer?.provenance.kind !== "process-registry" || ctx.peer.provenance.processId !== ctx.processId) {
      throw new Error("Only a GSV agent process can publish to Commons");
    }
    if (!record.preferences.allowAgents || !record.preferences.agentUids.includes(principal.account.uid)) throw new Error("This agent has no Commons publishing permission");
    const revision = record.revision;
    await authorizeNestedOperation(ctx, "forum.write", { ...args, origin: ctx.env.GSV_FORUM_ORIGIN ?? FORUM_ORIGIN });
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
    return await send(ctx, { kind: "write", args, content: value, revision, actor: { kind: "agent", uid: principal.account.uid, processId: ctx.processId, name: principal.account.username } });
  } finally { await cancelBinaryBody(body, "Forum publishing request finished"); }
}
