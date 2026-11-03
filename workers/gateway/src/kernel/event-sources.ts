import type {
  EventEmitArgs,
  EventEmitResult,
  EventInput,
  EventListArgs,
  EventListResult,
  EventRecord,
  EventSource,
  EventSourceAddArgs,
  EventSourceListResult,
  EventSourceRemoveArgs,
  EventSourceRemoveResult,
  EventSourceRotateArgs,
  EventSourceSecretResult,
  EventSourceUpdateArgs,
  EventSourceUpdateResult,
  EventSourceWebhook,
  JsonObject,
  ShipOutcome,
  WebhookHmac,
} from "@humansandmachines/gsv/protocol";
import * as z from "zod/mini";
import { sha256 } from "./account-recovery";
import type { KernelContext } from "./context";
import { resolveCallerOwnerUid } from "./context";
import { MAX_WEBHOOK_BYTES, newWebhookSecret, verifyWebhook, webhookEvent } from "./event-webhook";
import { requireContactCaller } from "./federation/authority";
import type { OwnerNoticeStore } from "./owner-notice-store";
import { authorizeProcessTool } from "../shared/utils";
import { authorizeNestedOperation, nestedToolOwner } from "./tool-approval";

const MAX_TITLE = 200;
const MAX_PREVIEW = 1_000;
const MAX_BODY = 64 * 1024;
const MAX_EVENTS_PER_CALL = 100;
const BUCKET_BURST = 120;
const BUCKET_PER_MS = 60 / 60_000;
const OWNER_EVENTS_PER_MINUTE = 600;
const BODY_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** Longer than bodies, so a poller re-reading an old item doesn't fire it again. */
const ID_RETENTION_MS = 180 * 24 * 60 * 60_000;
const SECRET_OVERLAP_MS = 24 * 60 * 60_000;
const MIN_EXPECT_MS = 60_000;

type Emitter = EventRecord["emittedBy"];

type SourceRow = {
  source_id: string;
  owner_uid: number;
  name: string;
  label: string;
  notify: "none" | "messenger";
  ship: ShipOutcome;
  webhook: EventSourceWebhook;
  hmac_json: string | null;
  sender_secret: number;
  secret: string | null;
  previous_secret: string | null;
  previous_secret_until: number | null;
  enabled: number;
  expect_every_ms: number | null;
  last_event_at: number | null;
  silence_noted_at: number | null;
  bucket_tokens: number;
  bucket_at: number;
  created_by: "person" | "ship";
  changed_by: "person" | "ship" | null;
  created_at: number;
  updated_at: number;
};

type LogRow = {
  source_id: string;
  event_id: string;
  title: string;
  preview: string | null;
  body: string | null;
  emitted_by: Emitter;
  received_at: number;
};

const shipChoices = (webhook: EventSourceWebhook): ShipOutcome[] =>
  webhook === "url" ? ["none", "context"] : ["none", "context", "wake"];

function hmacOf(row: SourceRow): WebhookHmac | null {
  return row.hmac_json === null ? null : hmacSchema.parse(JSON.parse(row.hmac_json));
}

function publicSource(row: SourceRow): EventSource {
  const hmac = hmacOf(row);
  return {
    sourceId: row.source_id,
    name: row.name,
    label: row.label,
    notify: row.notify,
    ship: row.ship,
    shipChoices: shipChoices(row.webhook),
    webhook: row.webhook,
    ...(hmac ? { hmac } : undefined),
    ...(row.sender_secret === 1 ? { senderSecret: true } : undefined),
    ...(row.sender_secret === 1 && row.secret === null ? { awaitingSecret: true } : undefined),
    enabled: row.enabled === 1,
    ...(row.expect_every_ms === null ? undefined : { expectEveryMs: row.expect_every_ms }),
    ...(row.last_event_at === null ? undefined : { lastEventAtMs: row.last_event_at }),
    createdBy: row.created_by,
    ...(row.changed_by === null ? undefined : { changedBy: row.changed_by }),
    updatedAtMs: row.updated_at,
  };
}

/** An owner's event sources and what has arrived from them. */
export class EventSourceStore {
  private readonly sql: SqlStorage;
  constructor(storage: DurableObjectStorage, private readonly onChange?: (ownerUid: number) => void) { this.sql = storage.sql; }

  list(ownerUid: number): EventSource[] {
    return this.sql.exec<SourceRow>("SELECT * FROM event_sources WHERE owner_uid = ? ORDER BY created_at, name", ownerUid)
      .toArray().map(publicSource);
  }

  row(ownerUid: number, name: string): SourceRow | null {
    return this.sql.exec<SourceRow>("SELECT * FROM event_sources WHERE owner_uid = ? AND name = ?", ownerUid, name).toArray()[0] ?? null;
  }

  byId(sourceId: string): SourceRow | null {
    return this.sql.exec<SourceRow>("SELECT * FROM event_sources WHERE source_id = ?", sourceId).toArray()[0] ?? null;
  }

  add(
    ownerUid: number,
    input: {
      name: string; label: string; notify: "none" | "messenger"; ship: ShipOutcome; webhook: EventSourceWebhook;
      hmac: WebhookHmac | null; senderSecret: boolean; secret: string | null; expectEveryMs: number | null;
    },
    createdBy: "person" | "ship",
    now: number,
  ): SourceRow {
    if (this.row(ownerUid, input.name)) throw new Error(`event.source.add: "${input.name}" already exists`);
    const sourceId = `src_${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    this.sql.exec(
      `INSERT INTO event_sources (source_id, owner_uid, name, label, notify, ship, webhook, hmac_json, sender_secret, secret,
        expect_every_ms, bucket_tokens, bucket_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sourceId, ownerUid, input.name, input.label, input.notify, input.ship, input.webhook,
      input.hmac ? JSON.stringify(input.hmac) : null, input.senderSecret ? 1 : 0, input.secret, input.expectEveryMs,
      BUCKET_BURST, now, createdBy, now, now,
    );
    this.onChange?.(ownerUid);
    const row = this.byId(sourceId);
    if (!row) throw new Error("Event source disappeared after it was added");
    return row;
  }

  update(row: SourceRow, change: EventSourceUpdateArgs, changedBy: "person" | "ship", now: number): SourceRow {
    this.sql.exec(
      `UPDATE event_sources SET label = ?, notify = ?, ship = ?, enabled = ?, expect_every_ms = ?, changed_by = ?, updated_at = ?
       WHERE source_id = ?`,
      change.label ?? row.label, change.notify ?? row.notify, change.ship ?? row.ship,
      change.enabled === undefined ? row.enabled : change.enabled ? 1 : 0,
      change.expectEveryMs === undefined ? row.expect_every_ms : change.expectEveryMs,
      changedBy, now, row.source_id,
    );
    this.onChange?.(row.owner_uid);
    const updated = this.byId(row.source_id);
    if (!updated) throw new Error("Event source disappeared after it was updated");
    return updated;
  }

  rotate(row: SourceRow, secret: string, now: number): void {
    this.sql.exec(
      "UPDATE event_sources SET secret = ?, previous_secret = ?, previous_secret_until = ?, updated_at = ? WHERE source_id = ?",
      secret, row.secret, now + SECRET_OVERLAP_MS, now, row.source_id,
    );
    this.onChange?.(row.owner_uid);
  }

  remove(row: SourceRow): void {
    this.sql.exec("DELETE FROM event_log WHERE source_id = ?", row.source_id);
    this.sql.exec("DELETE FROM event_sources WHERE source_id = ?", row.source_id);
    this.onChange?.(row.owner_uid);
  }

  /** Spend one token, refilled over time. A source can't be made to flood its owner, or a Kernel. */
  admit({ source_id: sourceId, owner_uid: ownerUid }: SourceRow, now: number): boolean {
    // Read here, not from the caller's copy: a delivery may have waited on its signature check.
    const current = this.byId(sourceId);
    if (!current) return false;
    const tokens = Math.min(BUCKET_BURST, current.bucket_tokens + Math.max(0, now - current.bucket_at) * BUCKET_PER_MS);
    const recent = this.sql.exec<{ count: number }>(
      "SELECT count(*) AS count FROM event_log WHERE owner_uid = ? AND received_at > ?", ownerUid, now - 60_000,
    ).one().count;
    if (tokens < 1 || recent >= OWNER_EVENTS_PER_MINUTE) return false;
    this.sql.exec("UPDATE event_sources SET bucket_tokens = ?, bucket_at = ? WHERE source_id = ?", tokens - 1, now, sourceId);
    return true;
  }

  seen(row: SourceRow, eventId: string): boolean {
    return this.sql.exec("SELECT 1 FROM event_log WHERE source_id = ? AND event_id = ?", row.source_id, eventId).toArray().length > 0;
  }

  /** False when the sender already delivered this id. */
  record(row: SourceRow, event: EventInput & { id: string }, emittedBy: Emitter, now: number): boolean {
    const inserted = this.sql.exec(
      `INSERT OR IGNORE INTO event_log (source_id, event_id, owner_uid, title, preview, body, emitted_by, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      row.source_id, event.id, row.owner_uid, event.title, event.preview ?? null, event.body ?? null, emittedBy, now,
    ).rowsWritten > 0;
    if (!inserted) return false;
    this.sql.exec(
      "UPDATE event_sources SET last_event_at = ?, silence_noted_at = NULL WHERE source_id = ?", now, row.source_id,
    );
    return true;
  }

  /** Open pages refresh once per delivery, however many events it brought. */
  arrived(ownerUid: number): void {
    this.onChange?.(ownerUid);
  }

  events(ownerUid: number, sourceId: string | null, limit: number): EventRecord[] {
    const rows = sourceId
      ? this.sql.exec<LogRow>("SELECT * FROM event_log WHERE source_id = ? ORDER BY received_at DESC LIMIT ?", sourceId, limit)
      : this.sql.exec<LogRow>("SELECT * FROM event_log WHERE owner_uid = ? ORDER BY received_at DESC LIMIT ?", ownerUid, limit);
    return rows.toArray().map((row) => ({
      sourceId: row.source_id,
      eventId: row.event_id,
      title: row.title,
      ...(row.preview === null ? undefined : { preview: row.preview }),
      ...(row.body === null ? undefined : { body: row.body }),
      emittedBy: row.emitted_by,
      receivedAtMs: row.received_at,
    }));
  }

  /** Sources that have stopped arriving and whose silence nobody has been told about. */
  silent(now: number): SourceRow[] {
    return this.sql.exec<SourceRow>(
      `SELECT * FROM event_sources WHERE enabled = 1 AND expect_every_ms IS NOT NULL AND silence_noted_at IS NULL
         AND COALESCE(last_event_at, created_at) + expect_every_ms <= ?`, now,
    ).toArray();
  }

  noteSilence(row: SourceRow, now: number): void {
    this.sql.exec("UPDATE event_sources SET silence_noted_at = ? WHERE source_id = ?", now, row.source_id);
  }

  /** Forget what has been kept long enough, whether or not its source still sends. */
  prune(now: number): void {
    this.sql.exec("UPDATE event_log SET body = NULL WHERE received_at <= ? AND body IS NOT NULL", now - BODY_RETENTION_MS);
    this.sql.exec("DELETE FROM event_log WHERE received_at <= ?", now - ID_RETENTION_MS);
  }

  /** When the next source would go silent or the next body or id is due to be forgotten. */
  nextUpkeepAt(): number | null {
    return this.sql.exec<{ due: number | null }>(
      `SELECT MIN(due) AS due FROM (
         SELECT COALESCE(last_event_at, created_at) + expect_every_ms AS due FROM event_sources
           WHERE enabled = 1 AND expect_every_ms IS NOT NULL AND silence_noted_at IS NULL
         UNION ALL SELECT MIN(received_at) + ? FROM event_log WHERE body IS NOT NULL
         UNION ALL SELECT MIN(received_at) + ? FROM event_log
       )`, BODY_RETENTION_MS, ID_RETENTION_MS,
    ).one().due;
  }
}

/** Tell owners about sources that stopped arriving; returns who now has a notice waiting. */
export function noteSilentSources(
  sources: EventSourceStore,
  notices: OwnerNoticeStore,
  auth: Pick<KernelContext["auth"], "isAccountDisabled">,
  now: number,
): Set<number> {
  const owners = new Set<number>();
  for (const row of sources.silent(now)) {
    sources.noteSilence(row, now);
    if (auth.isAccountDisabled(row.owner_uid) || (row.notify === "none" && row.ship === "none")) continue;
    notices.noteOnce(row.owner_uid, `event.silent:${row.source_id}:${now}`, "event.silent", { from: row.label, sourceId: row.source_id }, now);
    owners.add(row.owner_uid);
  }
  return owners;
}

/** One event's path, whichever way it arrived. The caller has already proved who it is. */
function ingest(ctx: KernelContext, row: SourceRow, input: EventInput, emittedBy: Emitter, now: number): boolean {
  const event = { ...input, id: input.id ?? crypto.randomUUID() };
  if (!ctx.eventSources.record(row, event, emittedBy, now)) return false;
  if (row.notify === "messenger" || row.ship === "context") {
    ctx.ownerNotices.noteEvent(row.owner_uid, row.source_id, { from: row.label, preview: event.title, sourceId: row.source_id }, now);
    ctx.defer(ctx.queueOwnerNotices(row.owner_uid));
  }
  // A running process has work in hand, and waking on its own events could loop forever.
  if (row.ship === "wake" && emittedBy !== "process") {
    const details: JsonObject = {
      eventType: "event.received",
      source: row.name,
      eventId: event.id,
      title: event.title,
      contentTrust: "untrusted",
      ...(event.preview ? { preview: event.preview } : undefined),
    };
    ctx.responsibilities.create({
      ownerUid: row.owner_uid,
      title: `Review event from ${row.label}`,
      details,
      source: { kind: "event", eventType: "event.received", eventId: `${row.source_id}:${event.id}` },
      assignee: { kind: "ship" },
      state: "open",
      priority: "normal",
      dedupeKey: `event.received:${row.source_id}:${event.id}`,
      actor: { kind: "system", component: "events" },
      observedByShip: false,
      now,
    });
    ctx.defer(ctx.reconcileResponsibilityWake(row.owner_uid).catch((error) => {
      console.warn("[Kernel] Failed to schedule event responsibility:", error);
    }));
  }
  ctx.defer(ctx.queueEventUpkeep());
  return true;
}

/** Ship can't quietly take its owner out of the loop or give itself a reason to run. */
function tellOwnerOfShipChange(ctx: KernelContext, previous: SourceRow | null, row: SourceRow, now: number): void {
  const changes = [
    ...((previous?.notify ?? "messenger") !== "none" && row.notify === "none" ? ["stopped-telling" as const] : []),
    ...(previous?.ship !== "wake" && row.ship === "wake" ? ["started-acting" as const] : []),
  ];
  for (const ruleChange of changes) {
    ctx.ownerNotices.noteOnce(row.owner_uid, `notice.rule.changed:${row.source_id}:${ruleChange}:${now}`, "notice.rule.changed",
      { from: row.label, ruleChange, sourceId: row.source_id }, now);
  }
  if (changes.length > 0) ctx.defer(ctx.queueOwnerNotices(row.owner_uid));
}

const nameSchema = z.string().check(z.regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "use lowercase letters, digits and hyphens"));
const labelSchema = z.string().check(z.minLength(1), z.maxLength(80));
const deliverySchema = z.enum(["none", "messenger"]);
const shipSchema = z.enum(["none", "context", "wake"]);
const expectSchema = z.number().check(z.int(), z.gte(MIN_EXPECT_MS));
const secretSchema = z.string().check(z.minLength(8), z.maxLength(512));
const headerSchema = z.pipe(z.string().check(z.regex(/^[A-Za-z0-9-]{1,64}$/, "use a header name")), z.transform((name) => name.toLowerCase()));
const pairKeySchema = z.string().check(z.regex(/^[A-Za-z0-9_-]{1,16}$/, "use letters, digits, - or _"));
const hmacSchema = z.strictObject({
  header: headerSchema,
  encoding: z.enum(["hex", "base64"]),
  prefix: z.optional(z.string().check(z.regex(/^[\x21-\x7e]{1,32}$/, "use up to 32 visible characters"))),
  pairs: z.optional(z.strictObject({ timestamp: pairKeySchema, signature: pairKeySchema })),
  idHeader: z.optional(headerSchema),
  typeHeader: z.optional(headerSchema),
});
const addSchema = z.strictObject({
  name: nameSchema,
  label: z.optional(labelSchema),
  notify: z.optional(deliverySchema),
  ship: z.optional(shipSchema),
  webhook: z.optional(z.enum(["none", "url", "standard", "hmac"])),
  hmac: z.optional(hmacSchema),
  senderSecret: z.optional(z.boolean()),
  secret: z.optional(secretSchema),
  expectEveryMs: z.optional(expectSchema),
});
const updateSchema = z.strictObject({
  name: nameSchema,
  label: z.optional(labelSchema),
  notify: z.optional(deliverySchema),
  ship: z.optional(shipSchema),
  enabled: z.optional(z.boolean()),
  expectEveryMs: z.optional(z.nullable(expectSchema)),
});
const namedSchema = z.strictObject({ name: nameSchema });
const rotateSchema = z.strictObject({ name: nameSchema, secret: z.optional(secretSchema) });
const eventSchema = z.strictObject({
  id: z.optional(z.string().check(z.minLength(1), z.maxLength(200))),
  title: z.string().check(z.minLength(1), z.maxLength(MAX_TITLE)),
  preview: z.optional(z.string().check(z.maxLength(MAX_PREVIEW))),
  body: z.optional(z.string().check(z.maxLength(MAX_BODY))),
});
const emitSchema = z.strictObject({ source: nameSchema, events: z.array(eventSchema).check(z.minLength(1), z.maxLength(MAX_EVENTS_PER_CALL)) });
const listSchema = z.strictObject({ source: z.optional(nameSchema), limit: z.optional(z.number().check(z.int(), z.gte(1), z.lte(200))) });

function parseArgs<T>(schema: z.ZodMiniType<T>, value: JsonObject | EventEmitArgs | EventListArgs | EventSourceAddArgs | EventSourceUpdateArgs | EventSourceRotateArgs, call: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${call}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

function changer(ctx: KernelContext) {
  const ownerUid = requireContactCaller(ctx, true);
  const changedBy: "person" | "ship" = ctx.processId ? "ship" : "person";
  return { ownerUid, changedBy };
}

function requireSource(ctx: KernelContext, ownerUid: number, name: string, call: string): SourceRow {
  const row = ctx.eventSources.row(ownerUid, name);
  if (!row) throw new Error(`${call}: no source named "${name}"`);
  return row;
}

function requireShipChoice(webhook: EventSourceWebhook, ship: ShipOutcome | undefined, call: string): void {
  if (ship && !shipChoices(webhook).includes(ship)) throw new Error(`${call}: an unsigned webhook can't ${ship} Ship`);
}

/** Someone else's words can start Ship working only once its owner has said so. */
async function askBeforeShipActs(ctx: KernelContext, changedBy: "person" | "ship", name: string, authorize: typeof authorizeProcessTool): Promise<void> {
  if (changedBy !== "ship") return;
  await authorizeNestedOperation({ ...ctx, toolOwner: nestedToolOwner(ctx) }, "event.source.update", { name, ship: "wake" }, authorize);
}

function webhookUrl(ctx: KernelContext, row: SourceRow, token: string | null): string | undefined {
  const origin = ctx.installationIdentity?.canonicalOrigin;
  if (!origin || row.webhook === "none") return undefined;
  return new URL(`/hooks/${row.source_id}${row.webhook === "url" && token ? `/${token}` : ""}`, origin).href;
}

export function handleEventSourceList(ctx: KernelContext): EventSourceListResult {
  return { sources: ctx.eventSources.list(changer(ctx).ownerUid) };
}

export async function handleEventSourceAdd(args: EventSourceAddArgs, ctx: KernelContext, authorize: typeof authorizeProcessTool = authorizeProcessTool): Promise<EventSourceSecretResult> {
  const input = parseArgs(addSchema, args, "event.source.add");
  const { ownerUid, changedBy } = changer(ctx);
  const webhook = input.webhook ?? "none";
  const ship = input.ship ?? "none";
  if ((webhook === "hmac") !== (input.hmac !== undefined)) throw new Error("event.source.add: hmac describes an hmac webhook's signature, and one needs it");
  const senderSecret = input.senderSecret === true || input.secret !== undefined;
  if (senderSecret && webhook !== "standard" && webhook !== "hmac") throw new Error(`event.source.add: a ${webhook} source has no signing secret`);
  if (input.senderSecret === false && input.secret !== undefined) throw new Error("event.source.add: a secret given here is the sender's");
  requireShipChoice(webhook, ship, "event.source.add");
  if (ship === "wake") await askBeforeShipActs(ctx, changedBy, input.name, authorize);
  const secret = senderSecret ? input.secret ?? null : newWebhookSecret(webhook);
  const now = Date.now();
  const row = ctx.eventSources.add(ownerUid, {
    name: input.name,
    label: input.label ?? input.name,
    notify: input.notify ?? "messenger",
    ship,
    webhook,
    hmac: input.hmac ?? null,
    senderSecret,
    // A url source's address is its secret, so only its hash stays here.
    secret: secret && webhook === "url" ? await sha256(secret) : secret,
    expectEveryMs: input.expectEveryMs ?? null,
  }, changedBy, now);
  if (changedBy === "ship") tellOwnerOfShipChange(ctx, null, row, now);
  if (row.expect_every_ms !== null) ctx.defer(ctx.queueEventUpkeep());
  const url = webhookUrl(ctx, row, secret);
  return {
    source: publicSource(row),
    // The sender already has a secret it issued.
    ...(secret && webhook !== "url" && !senderSecret ? { secret } : undefined),
    ...(url ? { webhookUrl: url } : undefined),
  };
}

export async function handleEventSourceUpdate(args: EventSourceUpdateArgs, ctx: KernelContext, authorize: typeof authorizeProcessTool = authorizeProcessTool): Promise<EventSourceUpdateResult> {
  const input = parseArgs(updateSchema, args, "event.source.update");
  const { ownerUid, changedBy } = changer(ctx);
  const previous = requireSource(ctx, ownerUid, input.name, "event.source.update");
  requireShipChoice(previous.webhook, input.ship, "event.source.update");
  if (input.ship === "wake" && previous.ship !== "wake") await askBeforeShipActs(ctx, changedBy, input.name, authorize);
  // The owner may have changed it while that approval waited.
  const current = requireSource(ctx, ownerUid, input.name, "event.source.update");
  if (current.source_id !== previous.source_id) throw new Error(`event.source.update: "${input.name}" changed while waiting for approval`);
  const now = Date.now();
  const row = ctx.eventSources.update(current, input, changedBy, now);
  if (changedBy === "ship") tellOwnerOfShipChange(ctx, current, row, now);
  ctx.defer(ctx.queueEventUpkeep());
  return { source: publicSource(row) };
}

export async function handleEventSourceRotate(args: EventSourceRotateArgs, ctx: KernelContext): Promise<EventSourceSecretResult> {
  const { name, secret: issued } = parseArgs(rotateSchema, args, "event.source.rotate");
  const row = requireSource(ctx, changer(ctx).ownerUid, name, "event.source.rotate");
  if (issued && row.webhook === "url") throw new Error(`event.source.rotate: "${name}" makes its own address`);
  if (!issued && row.sender_secret === 1) throw new Error(`event.source.rotate: "${name}" takes the secret its sender gives you`);
  const secret = issued ?? newWebhookSecret(row.webhook);
  if (!secret) throw new Error(`event.source.rotate: "${name}" has no webhook`);
  ctx.eventSources.rotate(row, row.webhook === "url" ? await sha256(secret) : secret, Date.now());
  const url = webhookUrl(ctx, row, secret);
  return {
    source: publicSource(requireSource(ctx, row.owner_uid, name, "event.source.rotate")),
    ...(row.webhook === "url" || issued ? undefined : { secret }),
    ...(url ? { webhookUrl: url } : undefined),
  };
}

export function handleEventSourceRemove(args: EventSourceRemoveArgs, ctx: KernelContext): EventSourceRemoveResult {
  const { name } = parseArgs(namedSchema, args, "event.source.remove");
  const row = ctx.eventSources.row(changer(ctx).ownerUid, name);
  if (!row) return { removed: false };
  ctx.eventSources.remove(row);
  return { removed: true };
}

export function handleEventEmit(args: EventEmitArgs, ctx: KernelContext): EventEmitResult {
  const { source, events } = parseArgs(emitSchema, args, "event.emit");
  const row = requireSource(ctx, resolveCallerOwnerUid(ctx), source, "event.emit");
  if (row.enabled !== 1) throw new Error(`event.emit: "${source}" is paused`);
  const emittedBy: Emitter = ctx.processId ? "process" : ctx.connection ? "client" : "schedule";
  const now = Date.now();
  let accepted = 0;
  let duplicates = 0;
  try {
    for (const event of events) {
      // A repeat costs nothing, so a poller re-reading old items still has room for new ones.
      if (event.id && ctx.eventSources.seen(row, event.id)) {
        duplicates += 1;
        continue;
      }
      if (!ctx.eventSources.admit(row, now)) throw new Error(`event.emit: "${source}" is sending too fast; ${accepted} accepted`);
      if (ingest(ctx, row, event, emittedBy, now)) accepted += 1;
      else duplicates += 1;
    }
  } finally {
    if (accepted > 0) ctx.eventSources.arrived(row.owner_uid);
  }
  return { accepted, duplicates };
}

export function handleEventList(args: EventListArgs, ctx: KernelContext): EventListResult {
  const { source, limit } = parseArgs(listSchema, args, "event.list");
  const ownerUid = resolveCallerOwnerUid(ctx);
  const row = source ? requireSource(ctx, ownerUid, source, "event.list") : null;
  return { events: ctx.eventSources.events(ownerUid, row?.source_id ?? null, limit ?? 20) };
}

/** A delivery to `/hooks/<sourceId>`. An unknown source and a wrong token look alike. */
export async function receiveWebhook(
  sourceId: string,
  token: string | null,
  headers: Headers,
  body: Uint8Array,
  ctx: KernelContext,
): Promise<{ status: number; retryAfter?: number }> {
  const row = ctx.eventSources.byId(sourceId);
  if (!row || row.webhook === "none" || row.enabled !== 1) return { status: 404 };
  if (body.length > MAX_WEBHOOK_BYTES) return { status: 413 };
  const now = Date.now();
  const secrets = [row.secret, row.previous_secret_until !== null && row.previous_secret_until > now ? row.previous_secret : null]
    .filter((secret) => secret !== null);
  let verified = false;
  if (row.webhook === "url") {
    const hash = token ? await sha256(token) : null;
    verified = hash !== null && secrets.includes(hash);
  } else {
    for (const secret of secrets) {
      if (await verifyWebhook(row.webhook, hmacOf(row), secret, body, headers, now)) verified = true;
    }
  }
  if (!verified) return { status: row.webhook === "url" ? 404 : 401 };
  // The owner may have paused, changed or deleted the source while the signature was checked.
  const current = ctx.eventSources.byId(sourceId);
  if (!current || current.enabled !== 1) return { status: 404 };
  const event = webhookEvent(row.webhook, hmacOf(row), current.label, body, headers);
  if (event.id && ctx.eventSources.seen(current, event.id)) return { status: 200 };
  // Only after proof, so a stranger's guesses can't spend the real sender's allowance.
  if (!ctx.eventSources.admit(current, now)) return { status: 429, retryAfter: 60 };
  const bounded: EventInput = {
    ...event,
    title: Array.from(event.title).slice(0, MAX_TITLE).join(""),
    ...(event.preview ? { preview: Array.from(event.preview).slice(0, MAX_PREVIEW).join("") } : undefined),
    ...(event.body !== undefined && event.body.length > MAX_BODY ? { body: undefined } : undefined),
  };
  if (ingest(ctx, current, bounded, "webhook", now)) ctx.eventSources.arrived(current.owner_uid);
  return { status: 200 };
}
