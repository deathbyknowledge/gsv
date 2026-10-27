import { describe, expect, it, vi } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { MailboxStore, type RecordMailMessageInput } from "./mailbox-store";

function messageInput(
  overrides: Partial<RecordMailMessageInput> = {},
): RecordMailMessageInput {
  return {
    messageId: "mail_aaaaaaaa",
    mailboxId: "mailbox:1000:primary",
    intakeId: "intake-a",
    digest: `sha256:${"a".repeat(64)}`,
    envelopeFrom: "sender@example.com",
    envelopeTo: "hank@gsv.space",
    headerMessageId: "<message-a@example.com>",
    displayFrom: "Sender <sender@example.com>",
    to: ["hank@gsv.space"],
    cc: [],
    replyTo: ["reply@example.com"],
    subject: "Hello",
    sentAt: 1_000,
    receivedAt: 2_000,
    rawPath: "/home/hank/.gsv/mail/inbox/mail_aaaaaaaa/raw.eml",
    textPath: "/home/hank/.gsv/mail/inbox/mail_aaaaaaaa/message.txt",
    sizeBytes: 512,
    attachments: [],
    ...overrides,
  };
}

describe("MailboxStore", () => {
  it("binds a mailbox notification identity once", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new MailboxStore(sql);
      const mailboxId = "mailbox:1000:primary";
      store.ensureMailbox(mailboxId, 1000, "hank@gsv.space");

      store.setNotificationUid(mailboxId, 2000);
      store.setNotificationUid(mailboxId, 2000);

      expect(store.getMailbox(mailboxId)?.notificationUid).toBe(2000);
      expect(() => store.setNotificationUid(mailboxId, 2001))
        .toThrow("notification identity conflicts");
    });
  });

  it("keeps mailboxes and message listings scoped to their local owner", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new MailboxStore(sql);
      store.ensureMailbox("mailbox:1000:primary", 1000, "hank@gsv.space");
      store.ensureMailbox("mailbox:1001:primary", 1001, "sam@gsv.space");
      store.recordMessage(messageInput());
      store.recordMessage(messageInput({
        messageId: "mail_bbbbbbbb",
        mailboxId: "mailbox:1001:primary",
        intakeId: "intake-b",
        digest: `sha256:${"b".repeat(64)}`,
        envelopeTo: "sam@gsv.space",
        to: ["sam@gsv.space"],
        rawPath: "/home/sam/.gsv/mail/inbox/mail_bbbbbbbb/raw.eml",
        textPath: "/home/sam/.gsv/mail/inbox/mail_bbbbbbbb/message.txt",
      }));

      expect(store.list(1000)).toMatchObject({
        messages: [{ messageId: "mail_aaaaaaaa" }],
      });
      expect(store.list(1001)).toMatchObject({
        messages: [{ messageId: "mail_bbbbbbbb" }],
      });
      expect(store.getMessage(1000, "mail_b")).toBeNull();
    });
  });

  it("resolves long message id prefixes without SQLite LIKE patterns", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new MailboxStore(sql);
      const messageId = `mail:${"a".repeat(64)}`;
      store.ensureMailbox("mailbox:1000:primary", 1000, "hank@gsv.space");
      store.recordMessage(messageInput({ messageId }));

      expect(store.getMessage(1000, messageId.slice(0, -4))).toMatchObject({
        messageId,
      });
      expect(store.getMessage(1000, `ail:${"a".repeat(64)}`)).toBeNull();
    });
  });

  it("deduplicates the same intake and the same exact message digest", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new MailboxStore(sql);
      store.ensureMailbox("mailbox:1000:primary", 1000, "hank@gsv.space");

      expect(store.recordMessage(messageInput()).created).toBe(true);
      expect(store.recordMessage(messageInput()).created).toBe(false);
      expect(store.recordMessage(messageInput({
        intakeId: "intake-retry-with-new-id",
      })).created).toBe(false);
      expect(store.list(1000).messages).toHaveLength(1);
      expect(store.getIntake("intake-retry-with-new-id")).toMatchObject({
        messageId: "mail_aaaaaaaa",
        digest: `sha256:${"a".repeat(64)}`,
      });
    });
  });

  it("rejects reusing an intake id for different message bytes", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new MailboxStore(sql);
      store.ensureMailbox("mailbox:1000:primary", 1000, "hank@gsv.space");
      store.recordMessage(messageInput());

      expect(() => store.recordMessage(messageInput({
        messageId: "mail_bbbbbbbb",
        digest: `sha256:${"b".repeat(64)}`,
      }))).toThrow("Mail intake identity conflicts");
      expect(store.list(1000).messages).toHaveLength(1);
      expect(store.getMessageById("mail_bbbbbbbb")).toBeNull();
    });
  });

  it("persists one replay-safe summary and event delivery checkpoint", async () => {
    await runWithRealKernelSql((sql) => {
      vi.spyOn(Date, "now").mockReturnValue(3_000);
      const store = new MailboxStore(sql);
      store.ensureMailbox("mailbox:1000:primary", 1000, "hank@gsv.space");
      store.recordMessage(messageInput());
      const summary = {
        summary: "Mike replied about the contract.",
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        category: "work" as const,
        requiresAttention: true,
        confidence: 0.91,
      };

      expect(store.completeSummary("mail_aaaaaaaa", summary).completed).toBe(true);
      expect(store.completeSummary("mail_aaaaaaaa", summary).completed).toBe(false);
      expect(() => store.completeSummary("mail_aaaaaaaa", {
        ...summary,
        summary: "A conflicting replay.",
      })).toThrow("Mail summary conflicts");

      store.markEventDelivered("mail_aaaaaaaa", 4_000);
      store.markEventDelivered("mail_aaaaaaaa", 5_000);
      expect(store.getMessage(1000, "mail_a")).toMatchObject({
        summary: summary.summary,
        category: "work",
        requiresAttention: true,
        confidence: 0.91,
        summarizedAt: 3_000,
        eventDeliveredAt: 4_000,
      });
    });
  });

  it("searches headers, bodies and summaries by word", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new MailboxStore(sql);
      store.ensureMailbox("mailbox:1000:primary", 1000, "hank@gsv.space");
      store.ensureMailbox("mailbox:1001:primary", 1001, "sam@gsv.space");
      store.recordMessage(messageInput({ bodyText: "Your pumpkin order has shipped." }));
      store.recordMessage(messageInput({
        messageId: "mail_bbbbbbbb",
        intakeId: "intake-b",
        digest: `sha256:${"b".repeat(64)}`,
        envelopeFrom: "billing@example.net",
        displayFrom: "Example Billing",
        subject: "Your receipt",
        receivedAt: 3_000,
        rawPath: "/home/hank/.gsv/mail/inbox/mail_bbbbbbbb/raw.eml",
        textPath: "/home/hank/.gsv/mail/inbox/mail_bbbbbbbb/message.txt",
      }));
      store.recordMessage(messageInput({
        messageId: "mail_cccccccc",
        mailboxId: "mailbox:1001:primary",
        intakeId: "intake-c",
        digest: `sha256:${"c".repeat(64)}`,
        envelopeTo: "sam@gsv.space",
        bodyText: "Another pumpkin.",
        rawPath: "/home/sam/.gsv/mail/inbox/mail_cccccccc/raw.eml",
        textPath: "/home/sam/.gsv/mail/inbox/mail_cccccccc/message.txt",
      }));
      store.completeSummary("mail_bbbbbbbb", {
        summary: "Invoice for the October hosting plan.",
        category: "transactional",
        requiresAttention: false,
        confidence: 0.9,
      });

      const ids = (query: string) => store.search(1000, query).messages.map((message) => message.messageId);
      expect(ids("pumpkin")).toEqual(["mail_aaaaaaaa"]);
      expect(ids("pump")).toEqual(["mail_aaaaaaaa"]);
      expect(ids("billing")).toEqual(["mail_bbbbbbbb"]);
      expect(ids("hosting invoice")).toEqual(["mail_bbbbbbbb"]);
      expect(ids("receipt pumpkin")).toEqual([]);
      expect(ids('"OR" NEAR(-x')).toEqual([]);
    });
  });

  it("pages newest first with a cursor instead of an offset", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new MailboxStore(sql);
      store.ensureMailbox("mailbox:1000:primary", 1000, "hank@gsv.space");
      for (const [index, letter] of ["a", "b", "c"].entries()) {
        store.recordMessage(messageInput({
          messageId: `mail_${letter.repeat(8)}`,
          intakeId: `intake-${letter}`,
          digest: `sha256:${letter.repeat(64)}`,
          subject: "Weekly digest",
          receivedAt: 2_000 + index * 1_000,
        }));
      }

      const first = store.list(1000, { limit: 2 });
      expect(first.messages.map((message) => message.messageId)).toEqual(["mail_cccccccc", "mail_bbbbbbbb"]);
      expect(first.next).toBeDefined();
      const second = store.list(1000, { limit: 2, before: first.next });
      expect(second.messages.map((message) => message.messageId)).toEqual(["mail_aaaaaaaa"]);
      expect(second.next).toBeUndefined();

      const searched = store.search(1000, "digest", { limit: 1, before: first.next });
      expect(searched.messages.map((message) => message.messageId)).toEqual(["mail_aaaaaaaa"]);
      expect(() => store.list(1000, { before: "not-a-cursor" })).toThrow("cursor");
    });
  });
});
