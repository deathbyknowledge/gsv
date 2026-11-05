import {
  contactDisplayName, procHistoryEventLinkSchema, procHistoryEventPayloadSchemas,
  type NoticeDelivery, type ProcHistoryEventLink, type ProcHistoryEventPayload, type ShipOutcome,
} from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import type { DurableTaskOptions } from "../shared/durable-tasks";
import { stableOpaqueId } from "../shared/stable-id";
import { MANAGED_LIFECYCLE_RECHECK_MS } from "../installation/lifecycle";
import { deliverAdapterDestination } from "./adapter-send";
import { identityLinkRouteGeneration } from "./adapter-destinations";
import type { KernelContext } from "./context";
import type { Kernel } from "./do";
import { shipConsumer } from "./events/consumers";
import type { EventDefinition } from "./events/registry";
import type { OwnerNotice } from "./owner-notice-store";
import { messengerNoticeAction, noticeLanguage, ownerNoticeLink, ownerNoticeParts, renderOwnerNotice } from "./owner-notice-text";

const MAX_RETRY_DELAY_MS = 5 * 60_000;

const ownerNotifiedBodySchema = z.object({
  payload: z.custom<ProcHistoryEventPayload<"owner.notified">>(
    (value) => procHistoryEventPayloadSchemas["owner.notified"].safeParse(value).success,
  ),
  /** Set for a card in the person's conversation; otherwise it follows whether a messenger carried the notice. */
  audience: z.enum(["person", "both"]).optional(),
  link: z.custom<ProcHistoryEventLink>((value) => procHistoryEventLinkSchema.safeParse(value).success).optional(),
});

/**
 * A notice the owner received, recorded in Ship's history. It joins an active run like
 * any runtime event; otherwise it waits, without starting a run, for the owner's reply
 * that needs it. The owner already has the notice, so nothing withdraws Ship's record.
 */
export const ownerNotifiedEvent: EventDefinition = {
  routes: (event) => [{ consumer: shipConsumer(event.ownerUid), lane: "background" }],
  admit(event) {
    const { payload, audience, link } = ownerNotifiedBodySchema.parse(event.body);
    return {
      event: {
        kind: "owner.notified", payload, severity: "info", audience: audience ?? (payload.adapter ? "both" : "model"),
        ...(link ? { link } : undefined),
      },
      admission: { idle: "record", busy: "join" },
    };
  },
};

const isSourceNotice = (notice: OwnerNotice): boolean => notice.topic === "event.received" || notice.topic === "event.silent";

const outcome = (notify: NoticeDelivery, ship: ShipOutcome) => ({ notify, ship });

/** What the notice's rule or source says to do with it. Ship changing a rule is always told, and Ship already knows. */
function noticeOutcome(notice: OwnerNotice, ctx: KernelContext) {
  if (notice.topic === "notice.rule.changed") return outcome("messenger", "none");
  if (notice.topic !== "event.received" && notice.topic !== "event.silent") {
    return outcome(ctx.noticeRules.notifies(notice.ownerUid, notice.topic), ctx.noticeRules.ship(notice.ownerUid, notice.topic));
  }
  const source = notice.subject.sourceId ? ctx.eventSources.byId(notice.subject.sourceId) : null;
  return outcome(source?.notify ?? "none", source?.ship ?? "none");
}

/**
 * Sends each owner's notices to their private messenger, unless a client of theirs is active
 * and already shows the change. Records each one for Ship without waking it, as its rule says,
 * including whether the person was told.
 */
export class OwnerNoticeRuntime {
  constructor(readonly host: Kernel) {}

  async queue(ownerUid: number): Promise<void> {
    const next = this.host.ownerNotices.next(ownerUid);
    if (next) await this.schedule(ownerUid, next.nextAttemptAtMs);
  }

  async recover(): Promise<void> {
    for (const ownerUid of this.host.ownerNotices.ownersWithPending()) await this.queue(ownerUid);
  }

  async onOwnerNotices(ownerUid: number, task: { id: string }): Promise<void> {
    if (this.host.auth.isAccountDisabled(ownerUid)) return;
    const gate = await this.host.onboarding.managedWorkGate();
    if (!gate.allowed) {
      await this.schedule(ownerUid, Date.now() + MANAGED_LIFECYCLE_RECHECK_MS, task.id);
      return;
    }
    this.host.ownerNotices.prune(Date.now());
    for (let notice = this.host.ownerNotices.next(ownerUid); notice; notice = this.host.ownerNotices.next(ownerUid)) {
      if (notice.nextAttemptAtMs > Date.now()) {
        await this.schedule(ownerUid, notice.nextAttemptAtMs, task.id);
        return;
      }
      if (!await this.deliver(notice, task)) return;
    }
  }

  /** Returns false when delivery stopped for a retry. */
  private async deliver(notice: OwnerNotice, task: { id: string }): Promise<boolean> {
    const ctx = this.host.buildKernelContext({ callerOwnerUid: notice.ownerUid });
    const current = this.admit(notice, ctx);
    if (!current) {
      this.host.ownerNotices.dismissed(notice, Date.now());
      return true;
    }
    const preferred = this.host.adapters.privateDestinations.get(notice.ownerUid);
    const silenced = noticeOutcome(notice, ctx).notify === "none";
    // A messenger that needs signing in can't carry the notice saying so.
    const brokenCarrier = notice.topic === "adapter.auth_required" && preferred?.destination.adapter === notice.subject.adapter
      && preferred?.destination.accountId === notice.subject.accountId;
    // Ship changing a rule is told even to someone who is online: they may be looking elsewhere.
    // A source going quiet is rare and easy to miss on a card, so it's told the same way.
    const leftToClient = notice.topic !== "notice.rule.changed" && notice.topic !== "event.silent" && this.host.shipReplies.activeConnection(notice.ownerUid, this.host.connections);
    if (silenced || brokenCarrier || !preferred || leftToClient) {
      await this.finishUnsent(notice, current, silenced);
      return true;
    }
    const { destination } = preferred;
    const identityLink = ctx.adapters.identityLinks.get(destination.adapter, destination.accountId, destination.actorId);
    const routeGeneration = identityLink ? identityLinkRouteGeneration(identityLink, destination.surface) : undefined;
    const language = noticeLanguage(ctx.config.get(`users/${notice.ownerUid}/locale/language`));
    const line = renderOwnerNotice(current, language);
    const link = ownerNoticeLink(current);
    const action = messengerNoticeAction(link, language, ctx.installationIdentity?.canonicalOrigin ?? null);
    // A forgotten row comes back with a new creation time, so a round is never named twice.
    const noticeId = `${notice.key}:${notice.createdAtMs}:${notice.round}`;
    // Adapters bind a delivery id to its content: a retry after the text changed is a new delivery.
    const deliveryId = await stableOpaqueId("owner-notice", [noticeId, line, action?.label ?? "", action?.url ?? ""]);
    const result = await deliverAdapterDestination(destination, notice.ownerUid, {
      deliveryId,
      text: line,
      ...(action === undefined ? undefined : { action }),
      ...(routeGeneration === undefined ? undefined : { routeGeneration }),
    }, ctx);
    const now = Date.now();
    if (!result.ok) {
      if (result.retryable !== true) {
        console.warn(`[Kernel] Owner notice ${notice.key} was not delivered:`, result.error);
        await this.finishUnsent(notice, current, false);
        return true;
      }
      const retryAt = now + Math.min(MAX_RETRY_DELAY_MS, 1_000 * (2 ** Math.min(8, notice.attemptCount + 1)));
      this.host.ownerNotices.failed(notice, result.error, retryAt, now);
      await this.schedule(notice.ownerUid, retryAt, task.id);
      return false;
    }
    await this.recordForShip(current, now, () => this.host.ownerNotices.sent(notice, now), destination.adapter);
    return true;
  }

  private async finishUnsent(notice: OwnerNotice, current: OwnerNotice, silenced: boolean): Promise<void> {
    const finish = () => this.host.ownerNotices.dismissed(notice, Date.now());
    // Nothing else shows a source's events, so one they weren't sent appears as a card in their conversation.
    if (isSourceNotice(notice) && !silenced) {
      await this.recordForShip(current, Date.now(), finish, undefined, true);
      return;
    }
    // Someone's words reach Ship unsent only when its owner chose that, not because they couldn't be reached.
    if (notice.topic.startsWith("contact.") && !silenced) finish();
    else await this.recordForShip(current, Date.now(), finish);
  }

  /** Finish the round and, unless its rule says Ship doesn't see this kind, record it for Ship in one transaction. */
  private async recordForShip(notice: OwnerNotice, now: number, finish: () => void, adapter?: string, shownInClient = false): Promise<void> {
    const { topic } = notice;
    const ctx = this.host.buildKernelContext({ callerOwnerUid: notice.ownerUid });
    // Ship made a rule change itself, so it has nothing to learn from the notice about it.
    const { ship } = noticeOutcome(notice, ctx);
    const shipSees = topic !== "notice.rule.changed" && (adapter ? ship !== "none" : ship === "context");
    if (!shipSees && !shownInClient) {
      finish();
      return;
    }
    const noticeId = `${notice.key}:${notice.createdAtMs}:${notice.round}`;
    const link = ownerNoticeLink(notice);
    if (topic === "notice.rule.changed") throw new Error("Ship's own rule changes are never recorded for it");
    const body: z.infer<typeof ownerNotifiedBodySchema> = {
      ...(shownInClient ? { audience: shipSees ? "both" as const : "person" as const } : undefined),
      payload: {
        noticeId,
        topic,
        ...(shownInClient ? { shownInClient } : undefined),
        ...(adapter ? { adapter } : undefined),
        ...(adapter || shownInClient ? { sentAtMs: now } : undefined),
        ...ownerNoticeParts(notice),
        ...(notice.subject.contactId ? { contactId: notice.subject.contactId } : undefined),
        ...(notice.subject.conversationId ? { conversationId: notice.subject.conversationId } : undefined),
        ...(topic === "contact.message" || topic === "mail.received" || topic === "event.received" ? { messages: notice.pendingCount } : undefined),
      },
      ...(link ? { link } : undefined),
    };
    this.host.ctx.storage.transactionSync(() => {
      finish();
      this.host.eventRuntime.append({
        type: "owner.notified", ownerUid: notice.ownerUid, subject: `notice:${noticeId}`, actor: { kind: "kernel" }, key: noticeId, body,
      });
    });
    await this.host.eventRuntime.kick();
  }

  /** The notice as it stands now, or null once its subject was read, decided, muted, fixed or ended. */
  private admit(notice: OwnerNotice, ctx: KernelContext): OwnerNotice | null {
    const { subject } = notice;
    if (isSourceNotice(notice)) {
      const source = subject.sourceId ? ctx.eventSources.byId(subject.sourceId) : null;
      if (source?.enabled !== 1 || source.owner_uid !== notice.ownerUid) return null;
      // A quiet spell is noted with its notice; once an event or a change ends it, that notice is stale.
      if (notice.topic === "event.silent" && (source.expect_every_ms === null || source.silence_noted_at !== notice.createdAtMs)) return null;
      return { ...notice, subject: { ...subject, from: source.label } };
    }
    if (notice.topic === "notice.rule.changed" || notice.topic === "mail.received" || notice.topic === "machine.added"
      || notice.topic === "adapter.connected") return notice;
    if (notice.topic === "adapter.auth_required") {
      const status = subject.adapter && subject.accountId ? ctx.adapters.status.get(subject.adapter, subject.accountId) : null;
      return status && !status.authenticated ? notice : null;
    }
    if (!subject.contactId) return null;
    if (notice.topic === "contact.request") {
      const approach = subject.approachId ? ctx.approaches.get(subject.approachId) : null;
      if (!approach || approach.ownerUid !== notice.ownerUid || approach.summary.direction !== "incoming"
        || approach.summary.state !== "pending" || approach.summary.expiresAtMs <= Date.now()) return null;
      return notice;
    }
    const contact = ctx.federation.get(subject.contactId);
    if (!contact || contact.ownerUid !== notice.ownerUid || contact.state !== "active" || contact.blocked
      || contact.generation !== subject.contactGeneration) return null;
    const from = contactDisplayName(contact);
    if (notice.topic === "contact.invite.accepted") return { ...notice, subject: { ...subject, from } };
    if (contact.preferences.muted || contact.preferences.shipHandlesMessages) return null;
    const entry = subject.conversationId ? ctx.conversations.inboxEntry(notice.ownerUid, subject.conversationId) : null;
    if (!entry?.unread) return null;
    return { ...notice, subject: { ...subject, from } };
  }

  /** One pending task per owner, moved earlier when the next notice becomes due sooner. */
  private async schedule(ownerUid: number, at: number, excludeTaskId?: string): Promise<void> {
    const due = Math.max(Date.now(), at);
    const options: DurableTaskOptions = { idempotent: true };
    if (excludeTaskId) options.excludeTaskId = excludeTaskId;
    const existing = await this.host.schedule(new Date(due), "onOwnerNotices", ownerUid, options);
    // Task times are whole seconds; a pending task due no later than this one stands.
    if (existing.time * 1_000 <= due + 1_000) return;
    await this.host.cancelSchedule(existing.id);
    await this.host.schedule(new Date(due), "onOwnerNotices", ownerUid, options);
  }
}
