import { contactDisplayName } from "@humansandmachines/gsv/protocol";
import type { DurableTaskOptions } from "../shared/durable-tasks";
import { stableOpaqueId } from "../shared/stable-id";
import { MANAGED_LIFECYCLE_RECHECK_MS } from "../installation/lifecycle";
import { deliverAdapterDestination } from "./adapter-send";
import { identityLinkRouteGeneration } from "./adapter-destinations";
import type { KernelContext } from "./context";
import type { Kernel } from "./do";
import type { OwnerNotice } from "./owner-notice-store";
import { messengerNoticeAction, noticeLanguage, ownerNoticeLink, ownerNoticeParts, renderOwnerNotice } from "./owner-notice-text";
import type { OwnerNotifiedShipEvent } from "./ship-event-store";

const MAX_RETRY_DELAY_MS = 5 * 60_000;

/**
 * Sends each owner's notices to their private messenger, unless a client of theirs is active
 * and already shows the change, then records each sent notice for Ship without waking it.
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
    const preferred = this.host.adapters.privateDestinations.get(notice.ownerUid);
    if (!current || !preferred || this.host.shipReplies.activeConnection(notice.ownerUid, this.host.connections)) {
      this.host.ownerNotices.dismissed(notice, Date.now());
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
        this.host.ownerNotices.dismissed(notice, now);
        return true;
      }
      const retryAt = now + Math.min(MAX_RETRY_DELAY_MS, 1_000 * (2 ** Math.min(8, notice.attemptCount + 1)));
      this.host.ownerNotices.failed(notice, result.error, retryAt, now);
      await this.schedule(notice.ownerUid, retryAt, task.id);
      return false;
    }
    const event: OwnerNotifiedShipEvent = {
      type: "owner.notified",
      payload: {
        noticeId,
        topic: current.topic,
        adapter: destination.adapter,
        ...ownerNoticeParts(current),
        contactId: current.subject.contactId,
        ...(current.subject.conversationId ? { conversationId: current.subject.conversationId } : undefined),
        ...(current.topic === "contact.message" ? { messages: current.pendingCount } : undefined),
        sentAtMs: now,
      },
      link,
    };
    this.host.ctx.storage.transactionSync(() => {
      this.host.ownerNotices.sent(notice, now);
      this.host.shipEvents.enqueue(notice.ownerUid, `owner.notified:${noticeId}`, event, now);
    });
    await this.host.shipEventRuntime.queue(notice.ownerUid);
    return true;
  }

  /** The notice as it stands now, or null once its owner turned its kind off or its subject was read, decided, muted or ended. */
  private admit(notice: OwnerNotice, ctx: KernelContext): OwnerNotice | null {
    if (ctx.noticeRules.notifies(notice.ownerUid, notice.topic) === "none") return null;
    const { subject } = notice;
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
