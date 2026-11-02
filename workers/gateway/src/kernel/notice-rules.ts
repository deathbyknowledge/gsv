import type {
  NoticeDelivery,
  NoticeKind,
  NoticeRule,
  NotifyRuleListResult,
  NotifyRuleResetArgs,
  NotifyRuleResetResult,
  NotifyRuleSetArgs,
  NotifyRuleSetResult,
  ShipOutcome,
} from "@humansandmachines/gsv/protocol";
import * as z from "zod/mini";
import type { KernelContext } from "./context";
import { requireContactCaller } from "./federation/authority";
import type { ResponsibilitySourcePolicyStore } from "./responsibility-source-policies";

const CONTACT_KINDS = ["contact.request", "contact.message", "contact.invite.accepted"] as const satisfies readonly NoticeKind[];
const SOURCE_KINDS = ["mail.received", "machine.added", "adapter.connected", "adapter.auth_required"] as const satisfies readonly NoticeKind[];
const NOTICE_KINDS = [...CONTACT_KINDS, ...SOURCE_KINDS] as const satisfies readonly NoticeKind[];

type SourceKind = typeof SOURCE_KINDS[number];
const isSourceKind = (kind: NoticeKind): kind is SourceKind => SOURCE_KINDS.some((source) => source === kind);

/** What each kind does until its owner changes it: what already happens without a rule. */
const defaults = (kind: NoticeKind): { notify: NoticeDelivery; ship: ShipOutcome } =>
  isSourceKind(kind) ? { notify: "none", ship: "wake" } : { notify: "messenger", ship: "context" };

/** A contact's words never start a run by rule; a person hands a contact to Ship instead. */
const shipChoices = (kind: NoticeKind): ShipOutcome[] =>
  isSourceKind(kind) ? ["none", "context", "wake"] : ["none", "context"];

const kindSchema = z.enum(NOTICE_KINDS);
const setArgsSchema = z.strictObject({
  kind: kindSchema,
  notify: z.optional(z.enum(["none", "messenger"])),
  ship: z.optional(z.enum(["none", "context", "wake"])),
});
const resetArgsSchema = z.strictObject({ kind: kindSchema });

type NoticeRuleRow = {
  kind: string;
  notify: NoticeDelivery;
  ship: "none" | "context" | null;
  changed_by: "person" | "ship";
  updated_at: number;
};

/** Each owner's changes to what happens for each kind. Waking stays with the kind's responsibility source. */
export class NoticeRuleStore {
  private readonly sql: SqlStorage;
  constructor(storage: DurableObjectStorage, private readonly sources: ResponsibilitySourcePolicyStore, private readonly onChange?: (ownerUid: number) => void) { this.sql = storage.sql; }

  /** Where the owner's notices of `kind` go now. */
  notifies(ownerUid: number, kind: NoticeKind): NoticeDelivery {
    return this.rule(ownerUid, kind).notify;
  }

  /** What Ship does about `kind` now. */
  ship(ownerUid: number, kind: NoticeKind): ShipOutcome {
    return this.rule(ownerUid, kind).ship;
  }

  /** Whether `kind` needs a notice row: to tell the person, or to record it for Ship. */
  wantsNotice(ownerUid: number, kind: NoticeKind): boolean {
    const rule = this.rule(ownerUid, kind);
    return rule.notify !== "none" || rule.ship === "context";
  }

  list(ownerUid: number): NoticeRule[] {
    return NOTICE_KINDS.map((kind) => this.rule(ownerUid, kind));
  }

  set(
    ownerUid: number,
    kind: NoticeKind,
    change: { notify?: NoticeDelivery; ship?: ShipOutcome },
    changedBy: "person" | "ship",
    now: number,
  ): NoticeRule {
    const current = this.rule(ownerUid, kind);
    const ship = change.ship ?? current.ship;
    if (!current.shipChoices.includes(ship)) throw new Error(`notify.rule.set: Ship can't ${ship} on ${kind}`);
    this.sql.exec(
      `INSERT INTO notice_rules (owner_uid, kind, notify, ship, changed_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner_uid, kind) DO UPDATE SET notify = excluded.notify, ship = excluded.ship,
         changed_by = excluded.changed_by, updated_at = excluded.updated_at`,
      ownerUid, kind, change.notify ?? current.notify, ship === "wake" ? null : ship, changedBy, now,
    );
    if (isSourceKind(kind)) this.sources.set(ownerUid, kind, ship === "wake", now);
    this.onChange?.(ownerUid);
    return this.rule(ownerUid, kind);
  }

  reset(ownerUid: number, kind: NoticeKind): NoticeRule {
    this.sql.exec("DELETE FROM notice_rules WHERE owner_uid = ? AND kind = ?", ownerUid, kind);
    if (isSourceKind(kind)) this.sources.set(ownerUid, kind, true);
    this.onChange?.(ownerUid);
    return this.rule(ownerUid, kind);
  }

  private rule(ownerUid: number, kind: NoticeKind): NoticeRule {
    const row = this.sql.exec<NoticeRuleRow>(
      "SELECT kind, notify, ship, changed_by, updated_at FROM notice_rules WHERE owner_uid = ? AND kind = ?",
      ownerUid, kind,
    ).toArray()[0];
    const { notify: defaultNotify, ship: defaultShip } = defaults(kind);
    const ship: ShipOutcome = isSourceKind(kind)
      ? this.sources.isEnabled(ownerUid, kind) ? "wake" : row?.ship ?? "none"
      : row?.ship ?? defaultShip;
    const fixed = { kind, ship, defaultNotify, defaultShip, shipChoices: shipChoices(kind) };
    return row
      ? { ...fixed, notify: row.notify, changedBy: row.changed_by, updatedAtMs: row.updated_at }
      : { ...fixed, notify: defaultNotify };
  }
}

/** The owner a rule belongs to, and whether their Ship or they themselves are changing it. */
function caller(ctx: KernelContext) {
  const ownerUid = requireContactCaller(ctx, true);
  const changedBy: "person" | "ship" = ctx.processId ? "ship" : "person";
  return { ownerUid, changedBy };
}

export function handleNotifyRuleList(ctx: KernelContext): NotifyRuleListResult {
  return { rules: ctx.noticeRules.list(caller(ctx).ownerUid) };
}

export function handleNotifyRuleSet(args: NotifyRuleSetArgs, ctx: KernelContext): NotifyRuleSetResult {
  const { kind, notify, ship } = parseArgs(setArgsSchema, args, "notify.rule.set");
  if (notify === undefined && ship === undefined) throw new Error("notify.rule.set: choose notify or ship");
  const { ownerUid, changedBy } = caller(ctx);
  const now = Date.now();
  const previous = currentRule(ctx, ownerUid, kind);
  const rule = ctx.noticeRules.set(ownerUid, kind, {
    ...(notify === undefined ? undefined : { notify }),
    ...(ship === undefined ? undefined : { ship }),
  }, changedBy, now);
  if (changedBy === "ship") tellOwnerOfShipChange(ctx, ownerUid, previous, rule, now);
  return { rule };
}

export function handleNotifyRuleReset(args: NotifyRuleResetArgs, ctx: KernelContext): NotifyRuleResetResult {
  const { kind } = parseArgs(resetArgsSchema, args, "notify.rule.reset");
  const { ownerUid, changedBy } = caller(ctx);
  const previous = currentRule(ctx, ownerUid, kind);
  const rule = ctx.noticeRules.reset(ownerUid, kind);
  if (changedBy === "ship") tellOwnerOfShipChange(ctx, ownerUid, previous, rule, Date.now());
  return { rule };
}

function currentRule(ctx: KernelContext, ownerUid: number, kind: NoticeKind): NoticeRule {
  const rule = ctx.noticeRules.list(ownerUid).find((candidate) => candidate.kind === kind);
  if (!rule) throw new Error(`Notice kind has no rule: ${kind}`);
  return rule;
}

/** Ship can't quietly take its owner out of the loop or give itself a reason to run. */
function tellOwnerOfShipChange(ctx: KernelContext, ownerUid: number, previous: NoticeRule, rule: NoticeRule, now: number): void {
  const changes = [
    ...(previous.notify !== "none" && rule.notify === "none" ? ["stopped-telling" as const] : []),
    ...(previous.ship !== "wake" && rule.ship === "wake" ? ["started-acting" as const] : []),
  ];
  for (const ruleChange of changes) {
    ctx.ownerNotices.noteOnce(ownerUid, `notice.rule.changed:${rule.kind}:${ruleChange}:${now}`, "notice.rule.changed",
      { from: rule.kind, ruleChange }, now);
  }
  if (changes.length > 0) ctx.defer(ctx.queueOwnerNotices(ownerUid));
}

function parseArgs<T>(schema: z.ZodMiniType<T>, value: T, call: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${call}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
