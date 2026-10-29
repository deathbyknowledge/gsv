import { z } from "zod";
import type {
  NoticeDelivery,
  NoticeKind,
  NoticeRule,
  NotifyRuleListResult,
  NotifyRuleResetResult,
  NotifyRuleSetResult,
} from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "./context";
import { requireContactCaller } from "./federation/authority";

/** Every kind of notice and where it goes until its owner changes it. */
const DEFAULT_NOTIFY: Readonly<Record<NoticeKind, NoticeDelivery>> = {
  "contact.request": "messenger",
  "contact.message": "messenger",
  "contact.invite.accepted": "messenger",
};

const NOTICE_KINDS = Object.keys(DEFAULT_NOTIFY) as NoticeKind[];
const kindSchema = z.enum(NOTICE_KINDS as [NoticeKind, ...NoticeKind[]]);
const deliverySchema = z.enum(["none", "messenger"]);
const setArgsSchema = z.strictObject({ kind: kindSchema, notify: deliverySchema });
const resetArgsSchema = z.strictObject({ kind: kindSchema });

type NoticeRuleRow = { kind: string; notify: NoticeDelivery; changed_by: "person" | "ship"; updated_at: number };

/** Each owner's changes to where their notices go. */
export class NoticeRuleStore {
  private readonly sql: SqlStorage;
  constructor(storage: DurableObjectStorage) { this.sql = storage.sql; }

  /** Where the owner's notices of `kind` go now. */
  notifies(ownerUid: number, kind: NoticeKind): NoticeDelivery {
    return this.rule(ownerUid, kind).notify;
  }

  list(ownerUid: number): NoticeRule[] {
    return NOTICE_KINDS.map((kind) => this.rule(ownerUid, kind));
  }

  set(ownerUid: number, kind: NoticeKind, notify: NoticeDelivery, changedBy: "person" | "ship", now: number): NoticeRule {
    this.sql.exec(
      `INSERT INTO notice_rules (owner_uid, kind, notify, changed_by, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (owner_uid, kind) DO UPDATE SET notify = excluded.notify, changed_by = excluded.changed_by,
         updated_at = excluded.updated_at`,
      ownerUid, kind, notify, changedBy, now,
    );
    return this.rule(ownerUid, kind);
  }

  reset(ownerUid: number, kind: NoticeKind): NoticeRule {
    this.sql.exec("DELETE FROM notice_rules WHERE owner_uid = ? AND kind = ?", ownerUid, kind);
    return this.rule(ownerUid, kind);
  }

  private rule(ownerUid: number, kind: NoticeKind): NoticeRule {
    const row = this.sql.exec<NoticeRuleRow>(
      "SELECT kind, notify, changed_by, updated_at FROM notice_rules WHERE owner_uid = ? AND kind = ?",
      ownerUid, kind,
    ).toArray()[0];
    const defaultNotify = DEFAULT_NOTIFY[kind];
    return row
      ? { kind, notify: row.notify, defaultNotify, changedBy: row.changed_by, updatedAtMs: row.updated_at }
      : { kind, notify: defaultNotify, defaultNotify };
  }
}

/** The owner a rule belongs to, and whether their Ship or they themselves are changing it. */
function caller(ctx: KernelContext): { ownerUid: number; changedBy: "person" | "ship" } {
  const ownerUid = requireContactCaller(ctx, true);
  return { ownerUid, changedBy: ctx.processId ? "ship" : "person" };
}

export function handleNotifyRuleList(_args: unknown, ctx: KernelContext): NotifyRuleListResult {
  return { rules: ctx.noticeRules.list(caller(ctx).ownerUid) };
}

export function handleNotifyRuleSet(args: unknown, ctx: KernelContext): NotifyRuleSetResult {
  const { kind, notify } = parseArgs(setArgsSchema, args, "notify.rule.set");
  const { ownerUid, changedBy } = caller(ctx);
  return { rule: ctx.noticeRules.set(ownerUid, kind, notify, changedBy, Date.now()) };
}

export function handleNotifyRuleReset(args: unknown, ctx: KernelContext): NotifyRuleResetResult {
  const { kind } = parseArgs(resetArgsSchema, args, "notify.rule.reset");
  return { rule: ctx.noticeRules.reset(caller(ctx).ownerUid, kind) };
}

function parseArgs<T>(schema: z.ZodType<T>, value: unknown, call: string): T {
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) throw new Error(`${call}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
