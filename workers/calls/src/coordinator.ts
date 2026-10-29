import { DurableObject, RpcTarget } from "cloudflare:workers";
import type { PhoneCall, PhoneUsage, SysPhoneAnswerArgs, SysPhoneCallArgs, SysPhoneListArgs, SysPhoneNoteArgs } from "@humansandmachines/gsv/protocol";
import {
  phoneActorSchema, phoneAnswerSchema, phoneCallSchema, phoneInstructionsSchema, phoneListSchema, phoneNoteSchema, phoneSelectorSchema,
  type InstallationPhone, type PhoneActor,
} from "@humansandmachines/gsv/services/phone";
import { z } from "zod";
import { PhonePolicy, routesSchema, type Environment, type PhoneLimits } from "./config";
import { callObjectName, newCallId, type ReportedChange } from "./call";
import { routeDestination } from "./numbers";
import { diagnosticDetail, migrateCoordinator } from "./schema";

const NOTIFY_RETRY_MS = 20_000;
const LIST_LIMIT = 50;
const pathSchema = z.string().trim().min(1).max(512);

type CallRow = { id: string; owner_uid: number; request_id: string; fingerprint: string; record: string; revision: number; active: number; created_at: number; location_hint: string | null };
type PendingRow = { call_id: string; event: ReportedChange["event"]; owner_uid: number; revision: number };
// SAFETY: This private column is written only from PhoneCall records reported by this installation's call objects.
const record = (row: Pick<CallRow, "record">): PhoneCall => JSON.parse(row.record) as PhoneCall;
const dayStart = (now: number): number => { const date = new Date(now); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()); };

/** One per installation: admission, the call index, usage, and change notifications to the Kernel. */
export class CallCoordinator extends DurableObject<Environment> {
  readonly #installationId: string;
  readonly #policy: PhonePolicy;
  #notifying: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Environment) {
    super(ctx, env);
    if (!ctx.id.name) throw new Error("Calls require a named installation identity");
    this.#installationId = ctx.id.name;
    migrateCoordinator(ctx.storage);
    this.#policy = new PhonePolicy(env, this.#installationId);
  }

  getTarget(): InstallationPhone { return new PhoneCapability(this); }

  get sql(): SqlStorage { return this.ctx.storage.sql; }

  async call(rawActor: PhoneActor, rawArgs: SysPhoneCallArgs, rawInstructions: string) {
    const actor = phoneActorSchema.parse(rawActor), args = phoneCallSchema.parse(rawArgs), instructions = phoneInstructionsSchema.parse(rawInstructions);
    const fingerprint = JSON.stringify([args.brief, args.responsibilityId ?? null]);
    const existing = this.#byRequest(actor.ownerUid, args.requestId);
    if (existing) return { call: await this.#resume(existing, fingerprint) };
    await this.#policy.requireActive();
    const limits = await this.#policy.limits();
    if (!limits.enabled) throw new Error("Phone calls are not available for this space");
    const destination = routeDestination(args.brief.to, routesSchema.parse(this.env.PHONE_ROUTES));
    const maxSeconds = Math.min(limits.maxCallSeconds, (args.brief.maxMinutes ?? Infinity) * 60);
    const now = Date.now();
    const row = this.ctx.storage.transactionSync(() => {
      const raced = this.#byRequest(actor.ownerUid, args.requestId);
      if (raced) return raced;
      const usage = this.#usage(limits, now);
      if (usage.activeCalls >= limits.concurrentCalls) throw new Error("Another call is already in progress");
      if (usage.callsToday >= limits.dailyCalls) throw new Error("The daily call limit has been reached");
      const call: PhoneCall = {
        callId: newCallId(), requestId: args.requestId, ownerUid: actor.ownerUid,
        ...(actor.processId ? { processId: actor.processId } : {}),
        ...(args.responsibilityId ? { responsibilityId: args.responsibilityId } : {}),
        brief: { ...args.brief, to: destination.to }, state: "queued", revision: 1, createdAt: now,
      };
      this.sql.exec(`INSERT INTO calls (id, owner_uid, request_id, fingerprint, record, revision, active, created_at, location_hint)
        VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)`, call.callId, actor.ownerUid, args.requestId, fingerprint, JSON.stringify(call), now, destination.locationHint ?? null);
      // The call object keeps its own copy; the coordinator needs these only to start it after a lost reply.
      this.ctx.storage.kv.put(`start:${call.callId}`, { instructions, from: destination.from, maxSeconds });
      return this.sql.exec<CallRow>("SELECT * FROM calls WHERE id = ?", call.callId).one();
    });
    return { call: await this.#resume(row, fingerprint) };
  }

  /** Starting is idempotent in the call object, so a retried request can finish a start a lost reply left queued. */
  async #resume(row: CallRow, fingerprint: string): Promise<PhoneCall> {
    if (row.fingerprint !== fingerprint) throw new Error("This requestId was already used for a different call");
    const call = record(row);
    const start = this.ctx.storage.kv.get<{ instructions: string; from: string; maxSeconds: number }>(`start:${row.id}`);
    if (!start) return call;
    if (call.state !== "queued") { this.ctx.storage.kv.delete(`start:${row.id}`); return call; }
    try {
      const started = await this.#object(row).start({ installationId: this.#installationId, call, ...start });
      this.ctx.storage.kv.delete(`start:${row.id}`);
      return started;
    } catch (cause) {
      this.#diagnostic(row.id, cause);
      await this.ctx.storage.setAlarm(Date.now() + NOTIFY_RETRY_MS);
      throw new Error("The call could not be started", { cause });
    }
  }

  async list(rawActor: PhoneActor, rawArgs: SysPhoneListArgs) {
    const actor = phoneActorSchema.parse(rawActor), args = phoneListSchema.parse(rawArgs);
    const rows = this.sql.exec<CallRow>(`SELECT * FROM calls WHERE owner_uid = ? ${args.includeEnded ? "" : "AND active = 1"} ORDER BY created_at DESC LIMIT ?`, actor.ownerUid, LIST_LIMIT).toArray();
    return { calls: rows.map(record), usage: this.#usage(await this.#policy.limits(), Date.now()) };
  }

  async get(rawActor: PhoneActor, callId: string) {
    const actor = phoneActorSchema.parse(rawActor);
    return this.#owned(actor, callId).get(actor);
  }
  async answer(rawActor: PhoneActor, rawArgs: SysPhoneAnswerArgs) {
    const actor = phoneActorSchema.parse(rawActor), args = phoneAnswerSchema.parse(rawArgs);
    return { call: await this.#owned(actor, args.callId).answer(actor, args) };
  }
  async note(rawActor: PhoneActor, rawArgs: SysPhoneNoteArgs) {
    const actor = phoneActorSchema.parse(rawActor), args = phoneNoteSchema.parse(rawArgs);
    return { call: await this.#owned(actor, args.callId).note(actor, args) };
  }
  async end(rawActor: PhoneActor, callId: string) {
    const actor = phoneActorSchema.parse(rawActor);
    return { call: await this.#owned(actor, callId).end(actor) };
  }
  async watch(rawActor: PhoneActor, callId: string) {
    const actor = phoneActorSchema.parse(rawActor);
    return this.#owned(actor, callId).watch(actor);
  }
  async join(rawActor: PhoneActor, callId: string) {
    const actor = phoneActorSchema.parse(rawActor);
    return this.#owned(actor, callId).join(actor);
  }
  async transcriptFiled(rawActor: PhoneActor, callId: string, rawPath: string) {
    const actor = phoneActorSchema.parse(rawActor), path = pathSchema.parse(rawPath);
    await this.#owned(actor, callId).transcriptFiled(actor, path);
  }

  /** Reported by this installation's call objects; stale revisions never overwrite newer ones. */
  async recordCall(call: PhoneCall, changes: ReportedChange[]): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      const row = this.sql.exec<CallRow>("SELECT * FROM calls WHERE id = ?", call.callId).toArray()[0];
      if (!row || row.owner_uid !== call.ownerUid) throw new Error("Unknown call");
      if (call.revision > row.revision) {
        this.sql.exec("UPDATE calls SET record = ?, revision = ?, active = ? WHERE id = ?", JSON.stringify(call), call.revision, call.state === "ended" ? 0 : 1, call.callId);
      }
      for (const change of changes) {
        this.sql.exec(`INSERT INTO pending_changes (call_id, event, owner_uid, revision) VALUES (?, ?, ?, ?)
          ON CONFLICT(call_id, event) DO UPDATE SET revision = MAX(revision, excluded.revision)`, call.callId, change.event, call.ownerUid, change.revision);
      }
    });
    this.ctx.waitUntil(this.#publish());
  }

  async alarm(): Promise<void> {
    for (const [key] of this.ctx.storage.kv.list({ prefix: "start:" })) {
      const row = this.sql.exec<CallRow>("SELECT * FROM calls WHERE id = ?", key.slice("start:".length)).toArray()[0];
      if (row) await this.#resume(row, row.fingerprint).catch(() => {});
      else this.ctx.storage.kv.delete(key);
    }
    await this.#publish();
  }

  #publish(): Promise<void> {
    this.#notifying ??= (async () => {
      const pending = this.sql.exec<PendingRow>("SELECT * FROM pending_changes ORDER BY revision").toArray();
      if (!pending.length) return;
      await this.ctx.storage.setAlarm(Date.now() + NOTIFY_RETRY_MS);
      let failed = false;
      for (const change of pending) {
        try {
          await this.env.PHONE_EVENTS.phoneChanged({ installationId: this.#installationId, ownerUid: change.owner_uid, callId: change.call_id, revision: change.revision, event: change.event });
          this.sql.exec("DELETE FROM pending_changes WHERE call_id = ? AND event = ? AND revision = ?", change.call_id, change.event, change.revision);
        } catch (cause) {
          failed = true;
          this.#diagnostic(change.call_id, new Error("Call change notification failed", { cause }));
        }
      }
      const idle = !this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM pending_changes").one().count
        && [...this.ctx.storage.kv.list({ prefix: "start:", limit: 1 })].length === 0;
      if (!failed && idle) await this.ctx.storage.deleteAlarm();
    })().finally(() => { this.#notifying = undefined; });
    return this.#notifying;
  }

  #usage(limits: PhoneLimits, now: number): PhoneUsage {
    const start = dayStart(now);
    const active = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM calls WHERE active = 1").one().count;
    const today = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM calls WHERE created_at >= ?", start).one().count;
    return {
      enabled: limits.enabled, dayStartsAt: start, callsToday: today, dailyLimit: limits.dailyCalls,
      activeCalls: active, concurrentLimit: limits.concurrentCalls, maxCallSeconds: limits.maxCallSeconds,
    };
  }

  #byRequest(ownerUid: number, requestId: string): CallRow | undefined {
    return this.sql.exec<CallRow>("SELECT * FROM calls WHERE owner_uid = ? AND request_id = ?", ownerUid, requestId).toArray()[0];
  }

  #owned(actor: PhoneActor, callId: string) {
    const id = phoneSelectorSchema.parse({ callId }).callId;
    const row = this.sql.exec<CallRow>("SELECT * FROM calls WHERE id = ? AND owner_uid = ?", id, actor.ownerUid).toArray()[0];
    if (!row) throw new Error("Call does not exist");
    return this.#object(row);
  }

  #object(row: CallRow) {
    const hint = row.location_hint as DurableObjectLocationHint | null;
    return this.env.CALLS.getByName(callObjectName(this.#installationId, row.id), hint ? { locationHint: hint } : undefined);
  }

  #diagnostic(callId: string | null, cause: unknown): string {
    const id = crypto.randomUUID();
    this.sql.exec("INSERT INTO diagnostics (id, call_id, occurred_at, detail) VALUES (?, ?, ?, ?)", id, callId, Date.now(), diagnosticDetail(cause));
    console.warn(`[Calls] coordinator operation failed; diagnostic ${id}`);
    return id;
  }
}

class PhoneCapability extends RpcTarget implements InstallationPhone {
  readonly #owner: CallCoordinator;
  constructor(owner: CallCoordinator) { super(); this.#owner = owner; }
  call(...args: Parameters<InstallationPhone["call"]>) { return this.#owner.call(...args); }
  get(...args: Parameters<InstallationPhone["get"]>) { return this.#owner.get(...args); }
  list(...args: Parameters<InstallationPhone["list"]>) { return this.#owner.list(...args); }
  answer(...args: Parameters<InstallationPhone["answer"]>) { return this.#owner.answer(...args); }
  note(...args: Parameters<InstallationPhone["note"]>) { return this.#owner.note(...args); }
  end(...args: Parameters<InstallationPhone["end"]>) { return this.#owner.end(...args); }
  watch(...args: Parameters<InstallationPhone["watch"]>) { return this.#owner.watch(...args); }
  join(...args: Parameters<InstallationPhone["join"]>) { return this.#owner.join(...args); }
  transcriptFiled(...args: Parameters<InstallationPhone["transcriptFiled"]>) { return this.#owner.transcriptFiled(...args); }
}
