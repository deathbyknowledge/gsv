import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterMessageDestination } from "@humansandmachines/gsv/protocol";
import type { DurableTaskOptions } from "../shared/durable-tasks";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import * as adapterSend from "./adapter-send";
import type { Kernel } from "./do";
import { OwnerNoticeRuntime } from "./owner-notice-runtime";
import { OWNER_NOTICE_COLLAPSE_MS, OwnerNoticeStore } from "./owner-notice-store";
import { NoticeRuleStore } from "./notice-rules";
import { ResponsibilitySourcePolicyStore } from "./responsibility-source-policies";
import { ShipEventStore } from "./ship-event-store";

const OWNER = 1000;
const WHATSAPP: AdapterMessageDestination = {
  kind: "adapter", adapter: "whatsapp", accountId: "managed", actorId: "wa:owner", surface: { kind: "dm", id: "wa:owner" },
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("owner notice delivery", () => {
  it("tells a person on their messenger about a contact message they handle, and records it for Ship", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, notices, shipEvents, host } = fixture(storage);
      const send = sent();
      const at = Date.now();
      notices.noteContactMessage(OWNER, adaSubject("are we still on\nfor tomorrow?"), 1, at);

      await runtime.onOwnerNotices(OWNER, { id: "task:one" });

      expect(send).toHaveBeenCalledExactlyOnceWith(WHATSAPP, OWNER, {
        deliveryId: expect.stringMatching(/^owner-notice:[0-9a-f]{64}$/),
        text: "💬 Ada: are we still on for tomorrow?",
        action: { kind: "open", label: "Open in People", url: "https://person.example/people?contact=contact%3Aada" },
      }, expect.anything());
      expect(notices.next(OWNER)).toBeNull();
      expect(shipEvents.next(OWNER)).toMatchObject({
        eventId: `owner.notified:contact.message:contact:ada:${at}:0`,
        event: { type: "owner.notified", payload: {
          noticeId: `contact.message:contact:ada:${at}:0`, topic: "contact.message", adapter: "whatsapp", from: "Ada",
          contactId: "contact:ada", conversationId: "conv:ada", messages: 1, preview: "are we still on for tomorrow?",
        }, link: { kind: "contact", contactId: "contact:ada" } },
      });
      expect(shipEvents.next(OWNER)?.event.payload).not.toHaveProperty("text");
      expect(host.shipEventRuntime.queue).toHaveBeenCalledWith(OWNER);
    });
  });

  it("leaves the change to an active client instead of the messenger", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, notices, shipEvents, state } = fixture(storage);
      const send = sent();
      state.activeClient = "connection:web";
      notices.noteContactMessage(OWNER, adaSubject("hi"), 1, Date.now());
      await runtime.onOwnerNotices(OWNER, { id: "task:one" });
      expect(send).not.toHaveBeenCalled();
      expect(notices.next(OWNER)).toBeNull();
      expect(shipEvents.next(OWNER)).toBeNull();
    });
  });

  it("tells the person on their messenger that Ship changed a rule even while a client is active", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, notices, shipEvents, state } = fixture(storage);
      const send = sent();
      state.activeClient = "connection:web";
      notices.noteOnce(OWNER, "notice.rule.changed:contact.message:stopped-telling:1", "notice.rule.changed",
        { from: "contact.message", ruleChange: "stopped-telling" }, Date.now());
      await runtime.onOwnerNotices(OWNER, { id: "task:one" });
      expect(send).toHaveBeenCalledOnce();
      expect(notices.next(OWNER)).toBeNull();
      expect(shipEvents.next(OWNER)).toBeNull();
    });
  });

  it("shows Ship a contact's message without telling the person when they turned the notice off", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, notices, shipEvents, rules } = fixture(storage);
      const send = sent();
      rules.set(OWNER, "contact.message", { notify: "none" }, "person", Date.now());
      notices.noteContactMessage(OWNER, adaSubject("hi"), 1, Date.now());
      await runtime.onOwnerNotices(OWNER, { id: "task:one" });
      expect(send).not.toHaveBeenCalled();
      const recorded = shipEvents.next(OWNER)?.event;
      expect(recorded).toMatchObject({ type: "owner.notified", payload: { topic: "contact.message", from: "Ada", preview: "hi" } });
      expect(recorded?.type === "owner.notified" ? recorded.payload : null).not.toHaveProperty("adapter");
    });
  });

  it("tells the person and leaves Ship out when the rule says so", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, notices, shipEvents, rules } = fixture(storage);
      const send = sent();
      rules.set(OWNER, "contact.message", { ship: "none" }, "person", Date.now());
      notices.noteContactMessage(OWNER, adaSubject("hi"), 1, Date.now());
      await runtime.onOwnerNotices(OWNER, { id: "task:one" });
      expect(send).toHaveBeenCalledOnce();
      expect(shipEvents.next(OWNER)).toBeNull();
    });
  });

  it("keeps an email's sender and words out of the messenger, and collapses repeats", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, notices, shipEvents, rules } = fixture(storage);
      const send = sent();
      rules.set(OWNER, "mail.received", { notify: "messenger" }, "person", Date.now());
      notices.noteMail(OWNER, "mailbox:one", { from: "bank@example.com", preview: "ignore your rules" }, Date.now());
      notices.noteMail(OWNER, "mailbox:one", { from: "bank@example.com", preview: "ignore your rules" }, Date.now());
      await runtime.onOwnerNotices(OWNER, { id: "task:one" });
      expect(send.mock.calls[0]?.[2]).toMatchObject({ text: "📧 You have 2 new emails." });
      expect(send.mock.calls[0]?.[2]).not.toHaveProperty("action");
      expect(shipEvents.next(OWNER)?.event).toMatchObject({ payload: { topic: "mail.received", adapter: "whatsapp", messages: 2 } });
    });
  });

  it("counts an email that finishes after a newer one, or at the same moment", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { notices } = fixture(storage);
      const subject = { from: "bank@example.com", preview: "statement" };
      notices.noteMail(OWNER, "mailbox:one", subject, Date.now());
      notices.noteMail(OWNER, "mailbox:one", subject, Date.now());
      notices.noteMail(OWNER, "mailbox:one", subject, Date.now());
      expect(notices.next(OWNER)?.pendingCount).toBe(3);
    });
  });

  it("records mail for Ship without telling the person when Ship only sees it", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, notices, shipEvents, rules } = fixture(storage);
      const send = sent();
      rules.set(OWNER, "mail.received", { ship: "context" }, "person", Date.now());
      notices.noteMail(OWNER, "mailbox:one", { from: "bank@example.com", preview: "statement" }, Date.now());
      await runtime.onOwnerNotices(OWNER, { id: "task:one" });
      expect(send).not.toHaveBeenCalled();
      expect(shipEvents.next(OWNER)?.event).toMatchObject({ payload: { topic: "mail.received", from: "bank@example.com", preview: "statement" } });
    });
  });

  it("doesn't use a messenger to say that same messenger needs signing in, or once it's fixed", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, notices, rules, state } = fixture(storage);
      const send = sent();
      rules.set(OWNER, "adapter.auth_required", { notify: "messenger" }, "person", Date.now());
      const other = { from: "discord", adapter: "discord", accountId: "managed" };
      notices.noteOnce(OWNER, "auth:same", "adapter.auth_required", { from: "whatsapp", adapter: "whatsapp", accountId: "managed" }, Date.now());
      notices.noteOnce(OWNER, "auth:fixed", "adapter.auth_required", other, Date.now());
      state.adapterAuthenticated = true;
      await runtime.onOwnerNotices(OWNER, { id: "task:one" });
      expect(send).not.toHaveBeenCalled();
      state.adapterAuthenticated = false;
      notices.noteOnce(OWNER, "auth:broken", "adapter.auth_required", other, Date.now());
      await runtime.onOwnerNotices(OWNER, { id: "task:two" });
      expect(send.mock.calls[0]?.[2]).toMatchObject({ text: "⚠️ Discord needs signing in again." });
    });
  });

  it("tells the person when their Ship changes a rule, and tells Ship nothing", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, notices, shipEvents } = fixture(storage);
      const send = sent();
      notices.noteOnce(OWNER, "rule:one", "notice.rule.changed", { from: "contact.message", ruleChange: "stopped-telling" }, Date.now());
      await runtime.onOwnerNotices(OWNER, { id: "task:one" });
      expect(send.mock.calls[0]?.[2]).toMatchObject({ text: "🔧 Your Ship turned off telling you about: contact messages. You can change this in Settings." });
      expect(shipEvents.next(OWNER)).toBeNull();
    });
  });

  it.each([
    ["read", (state: State) => { state.unread = false; }],
    ["muted", (state: State) => { state.contact.preferences.muted = true; }],
    ["handed to Ship", (state: State) => { state.contact.preferences.shipHandlesMessages = true; }],
    ["blocked", (state: State) => { state.contact.blocked = true; }],
    ["reconnected", (state: State) => { state.contact.generation = "generation:two"; }],
  ])("sends nothing for a conversation %s before its notice went out", async (_name, change) => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, notices, state } = fixture(storage);
      const send = sent();
      notices.noteContactMessage(OWNER, adaSubject("hi"), 1, Date.now());
      change(state);
      await runtime.onOwnerNotices(OWNER, { id: "task:one" });
      expect(send).not.toHaveBeenCalled();
      expect(notices.next(OWNER)).toBeNull();
    });
  });

  it("retries a retryable failure under the same delivery id and drops a refused one", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, notices, shipEvents, schedule } = fixture(storage);
      const send = vi.spyOn(adapterSend, "deliverAdapterDestination")
        .mockResolvedValueOnce({ ok: false, error: "WhatsApp is unavailable", retryable: true })
        .mockResolvedValueOnce({ ok: true, adapter: "whatsapp", accountId: "managed", surfaceId: "wa:owner", deliveryId: "d" });
      const at = Date.now();
      notices.noteContactMessage(OWNER, adaSubject("hi"), 1, at);

      await runtime.onOwnerNotices(OWNER, { id: "task:first" });
      expect(notices.next(OWNER)).toMatchObject({ attemptCount: 1, round: 0 });
      expect(schedule).toHaveBeenLastCalledWith(expect.any(Date), "onOwnerNotices", OWNER, { idempotent: true, excludeTaskId: "task:first" });

      storage.sql.exec("UPDATE owner_notices SET next_attempt_at = 0");
      await runtime.onOwnerNotices(OWNER, { id: "task:retry" });
      const [failed, retried] = send.mock.calls.map(([, , message]) => message.deliveryId);
      expect(retried).toBe(failed);
      expect(shipEvents.next(OWNER)?.eventId).toBe(`owner.notified:contact.message:contact:ada:${at}:0`);

      send.mockResolvedValueOnce({ ok: false, error: "Destination is no longer linked", retryable: false });
      notices.noteOnce(OWNER, "contact.invite.accepted:contact:ada:generation:one", "contact.invite.accepted", adaSubject(), Date.now());
      await runtime.onOwnerNotices(OWNER, { id: "task:refused" });
      expect(notices.next(OWNER)).toBeNull();
    });
  });

  it("keeps a contact's words out of Ship when their notice couldn't be delivered", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, notices, shipEvents } = fixture(storage);
      const send = sent();
      send.mockResolvedValueOnce({ ok: false, error: "Destination is no longer linked", retryable: false });
      notices.noteContactMessage(OWNER, adaSubject("hi"), 1, Date.now());
      await runtime.onOwnerNotices(OWNER, { id: "task:refused" });
      expect(send).toHaveBeenCalledOnce();
      expect(notices.next(OWNER)).toBeNull();
      expect(shipEvents.next(OWNER)).toBeNull();
    });
  });

  it("never reuses a delivery identity after a contact's notice row is forgotten", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, notices, state } = fixture(storage);
      const send = sent();
      vi.useFakeTimers({ toFake: ["Date"] });
      const pastWindow = () => vi.setSystemTime(Date.now() + OWNER_NOTICE_COLLAPSE_MS + 1_000);
      notices.noteContactMessage(OWNER, adaSubject("hi"), 1, Date.now());
      await runtime.onOwnerNotices(OWNER, { id: "task:one" });

      pastWindow();
      notices.prune(Date.now());
      notices.noteContactMessage(OWNER, adaSubject("hi"), 2, Date.now());
      await runtime.onOwnerNotices(OWNER, { id: "task:two" });

      pastWindow();
      notices.noteContactMessage(OWNER, adaSubject("hi"), 3, Date.now());
      state.unread = false;
      await runtime.onOwnerNotices(OWNER, { id: "task:dismissed" });
      state.unread = true;
      notices.noteContactMessage(OWNER, adaSubject("hi"), 4, Date.now());
      await runtime.onOwnerNotices(OWNER, { id: "task:three" });
      vi.useRealTimers();

      const ids = send.mock.calls.map(([, , message]) => message.deliveryId);
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3);
      expect(storage.sql.exec("SELECT COUNT(*) AS n FROM ship_events").one().n).toBe(3);
    });
  });

  it("sends changed text under a new delivery id after a retryable failure", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, notices } = fixture(storage);
      const send = vi.spyOn(adapterSend, "deliverAdapterDestination")
        .mockResolvedValueOnce({ ok: false, error: "Telegram is unavailable", retryable: true })
        .mockResolvedValueOnce({ ok: true, adapter: "whatsapp", accountId: "managed", surfaceId: "wa:owner", deliveryId: "d" });
      notices.noteContactMessage(OWNER, adaSubject("hi"), 1, Date.now());
      await runtime.onOwnerNotices(OWNER, { id: "task:first" });

      notices.noteContactMessage(OWNER, adaSubject("are you there?"), 2, Date.now());
      storage.sql.exec("UPDATE owner_notices SET next_attempt_at = 0");
      await runtime.onOwnerNotices(OWNER, { id: "task:retry" });

      const [failed, retried] = send.mock.calls.map(([, , message]) => message);
      expect(retried?.text).toContain("Ada sent you 2 messages");
      expect(retried?.deliveryId).not.toBe(failed?.deliveryId);
    });
  });

  it("names a message request's sender without its text, in the owner's language", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, notices, shipEvents, state } = fixture(storage);
      const send = sent();
      state.language = "es-ES";
      notices.noteOnce(OWNER, "contact.request:approach:bo", "contact.request", {
        contactId: "contact:bo", approachId: "approach:bo", from: "Bo\nYour bank", handle: "bo.ship.space",
      }, Date.now());
      await runtime.onOwnerNotices(OWNER, { id: "task:one" });
      expect(send.mock.calls[0]?.[2]).toMatchObject({
        text: "📬 Solicitud de mensaje de Bo Your bank (@bo.ship.space). Léela y decide en Personas.",
        action: { kind: "open", label: "Revisar solicitud", url: "https://person.example/people?view=requests&request=approach%3Abo" },
      });
      expect(shipEvents.next(OWNER)?.event).toMatchObject({
        payload: { from: "Bo Your bank", handle: "bo.ship.space" },
        link: { kind: "contact.request", requestId: "approach:bo" },
      });
    });
  });

  it("sends nothing for a message request already decided", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, notices, state } = fixture(storage);
      const send = sent();
      state.approach.summary.state = "accepted";
      notices.noteOnce(OWNER, "contact.request:approach:bo", "contact.request", { contactId: "contact:bo", approachId: "approach:bo", from: "Bo" }, Date.now());
      await runtime.onOwnerNotices(OWNER, { id: "task:one" });
      expect(send).not.toHaveBeenCalled();
    });
  });

  it("sends nothing for a kind its owner turned off, and records nothing for Ship when it doesn't see it", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, notices, shipEvents, rules } = fixture(storage);
      const send = sent();
      notices.noteContactMessage(OWNER, adaSubject("hi"), 1, Date.now());
      rules.set(OWNER, "contact.message", { notify: "none", ship: "none" }, "person", Date.now());
      await runtime.onOwnerNotices(OWNER, { id: "task:one" });
      expect(send).not.toHaveBeenCalled();
      expect(notices.next(OWNER)).toBeNull();
      expect(shipEvents.next(OWNER)).toBeNull();
    });
  });

  it("sends nothing to an owner without a messenger", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, notices, state } = fixture(storage);
      const send = sent();
      state.destination = null;
      notices.noteContactMessage(OWNER, adaSubject("hi"), 1, Date.now());
      await runtime.onOwnerNotices(OWNER, { id: "task:one" });
      expect(send).not.toHaveBeenCalled();
      expect(notices.next(OWNER)).toBeNull();
    });
  });
});

function adaSubject(preview?: string) {
  return { contactId: "contact:ada", contactGeneration: "generation:one", conversationId: "conv:ada", from: "Ada",
    ...(preview === undefined ? undefined : { preview }) };
}

function sent() {
  return vi.spyOn(adapterSend, "deliverAdapterDestination").mockResolvedValue({
    ok: true, adapter: "whatsapp", accountId: "managed", surfaceId: "wa:owner", deliveryId: "delivery",
  });
}

type State = {
  adapterAuthenticated: boolean;
  unread: boolean;
  activeClient: string | null;
  language: string | null;
  destination: { uid: number; destination: AdapterMessageDestination; messageId: string; updatedAt: number } | null;
  contact: {
    id: string; ownerUid: number; generation: string; state: string; blocked: boolean; remoteName: string;
    preferences: { muted: boolean; shipHandlesMessages: boolean };
  };
  approach: { ownerUid: number; summary: { id: string; direction: string; state: string; expiresAtMs: number } };
};

function initialState(): State {
  return {
    adapterAuthenticated: false,
    unread: true,
    activeClient: null,
    language: null,
    destination: { uid: OWNER, destination: WHATSAPP, messageId: "wamid", updatedAt: 0 },
    contact: {
      id: "contact:ada", ownerUid: OWNER, generation: "generation:one", state: "active", blocked: false,
      remoteName: "Ada", preferences: { muted: false, shipHandlesMessages: false },
    },
    approach: {
      ownerUid: OWNER,
      summary: { id: "approach:bo", direction: "incoming", state: "pending", expiresAtMs: Date.now() + 86_400_000 },
    },
  };
}

function fixture(storage: DurableObjectStorage) {
  const notices = new OwnerNoticeStore(storage);
  const shipEvents = new ShipEventStore(storage);
  const rules = new NoticeRuleStore(storage, new ResponsibilitySourcePolicyStore(storage.sql));
  const state = initialState();
  const schedule = vi.fn(async (when: Date, _callback: string, _ownerUid: number, _options: DurableTaskOptions) =>
    ({ id: `task:${when.getTime()}`, time: Math.floor(when.getTime() / 1_000) }));
  const ctx = {
    noticeRules: rules,
    federation: { get: (id: string) => id === state.contact.id ? state.contact : null },
    approaches: { get: (id: string) => id === state.approach.summary.id ? state.approach : null },
    conversations: { inboxEntry: (_uid: number, id: string) => id === "conv:ada" ? { unread: state.unread } : null },
    adapters: {
      identityLinks: { get: () => null },
      status: { get: () => ({ authenticated: state.adapterAuthenticated }) },
    },
    config: { get: (key: string) => key === `users/${OWNER}/locale/language` ? state.language : null },
    installationIdentity: { canonicalOrigin: "https://person.example" },
  };
  const host = {
    ctx: { storage },
    ownerNotices: notices,
    shipEvents,
    connections: new Map(),
    auth: { isAccountDisabled: (_uid: number) => false },
    onboarding: { managedWorkGate: async () => ({ allowed: true }) },
    adapters: { privateDestinations: { get: (_uid: number) => state.destination } },
    shipReplies: { activeConnection: () => state.activeClient },
    shipEventRuntime: { queue: vi.fn(async (_uid: number) => {}) },
    buildKernelContext: () => ctx,
    schedule,
    cancelSchedule: vi.fn(async (_id: string) => true),
  };
  // SAFETY: OwnerNoticeRuntime reaches only these Kernel members.
  const runtime = new OwnerNoticeRuntime(host as Kernel);
  return { runtime, notices, shipEvents, host, state, schedule, rules };
}
