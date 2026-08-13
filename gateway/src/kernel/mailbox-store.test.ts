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
        count: 1,
        messages: [{ messageId: "mail_aaaaaaaa" }],
      });
      expect(store.list(1001)).toMatchObject({
        count: 1,
        messages: [{ messageId: "mail_bbbbbbbb" }],
      });
      expect(store.getMessage(1000, "mail_b")).toBeNull();
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
      expect(store.list(1000).count).toBe(1);
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
      expect(store.list(1000).count).toBe(1);
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

  it("searches bounded message metadata and supports pagination", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new MailboxStore(sql);
      store.ensureMailbox("mailbox:1000:primary", 1000, "hank@gsv.space");
      store.recordMessage(messageInput());
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

      expect(store.search(1000, "billing")).toMatchObject({
        count: 1,
        messages: [{ messageId: "mail_bbbbbbbb" }],
      });
      expect(store.list(1000, 1, 1)).toMatchObject({
        count: 2,
        messages: [{ messageId: "mail_aaaaaaaa" }],
      });
    });
  });
});
