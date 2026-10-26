import { describe, expect, it } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { OWNER_NOTICE_COLLAPSE_MS, OwnerNoticeStore, type OwnerNoticeSubject } from "./owner-notice-store";

const OWNER = 1000;
const ADA: OwnerNoticeSubject = { contactId: "contact:ada", contactGeneration: "generation:one", conversationId: "conv:ada", from: "Ada", preview: "one" };

describe("owner notices", () => {
  it("collapses a contact's messages into one notice, counting each message once", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const notices = new OwnerNoticeStore(storage);
      notices.noteContactMessage(OWNER, ADA, 1, 1_000);
      notices.noteContactMessage(OWNER, { ...ADA, preview: "two" }, 2, 2_000);
      notices.noteContactMessage(OWNER, { ...ADA, preview: "two again" }, 2, 3_000);
      expect(notices.next(OWNER)).toMatchObject({
        key: "contact.message:contact:ada", topic: "contact.message", pendingCount: 2, round: 0, nextAttemptAtMs: 1_000,
        subject: { preview: "two" },
      });
    });
  });

  it("holds messages after a sent notice until the collapse window ends", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const notices = new OwnerNoticeStore(storage);
      notices.noteContactMessage(OWNER, ADA, 1, 1_000);
      notices.sent(notices.next(OWNER)!, 5_000);
      expect(notices.next(OWNER)).toBeNull();

      notices.noteContactMessage(OWNER, { ...ADA, preview: "three" }, 3, 6_000);
      notices.noteContactMessage(OWNER, { ...ADA, preview: "four" }, 4, 7_000);
      expect(notices.next(OWNER)).toMatchObject({ pendingCount: 2, round: 1, nextAttemptAtMs: 5_000 + OWNER_NOTICE_COLLAPSE_MS });
    });
  });

  it("carries messages that arrived while a round was sending into the next round", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const notices = new OwnerNoticeStore(storage);
      notices.noteContactMessage(OWNER, ADA, 1, 1_000);
      const sending = notices.next(OWNER)!;
      notices.noteContactMessage(OWNER, { ...ADA, preview: "late" }, 2, 2_000);
      notices.sent(sending, 3_000);
      expect(notices.next(OWNER)).toMatchObject({
        pendingCount: 1, round: 1, nextAttemptAtMs: 3_000 + OWNER_NOTICE_COLLAPSE_MS, subject: { preview: "late" },
      });
    });
  });

  it("sends a one-time notice at most once and forgets dismissed contact rounds", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const notices = new OwnerNoticeStore(storage);
      const request = { contactId: "contact:bo", approachId: "approach:bo", from: "Bo" };
      notices.noteOnce(OWNER, "contact.request:approach:bo", "contact.request", request, 1_000);
      notices.noteOnce(OWNER, "contact.request:approach:bo", "contact.request", request, 2_000);
      notices.sent(notices.next(OWNER)!, 3_000);
      notices.noteOnce(OWNER, "contact.request:approach:bo", "contact.request", request, 4_000);
      expect(notices.next(OWNER)).toBeNull();

      notices.noteContactMessage(OWNER, ADA, 1, 5_000);
      notices.dismissed(notices.next(OWNER)!, 6_000);
      notices.noteContactMessage(OWNER, { ...ADA, preview: "after reading" }, 2, 7_000);
      expect(notices.next(OWNER)).toMatchObject({ pendingCount: 1, round: 0, nextAttemptAtMs: 7_000 });
    });
  });

  it("keeps each owner's notices separate", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const notices = new OwnerNoticeStore(storage);
      notices.noteContactMessage(OWNER, ADA, 1, 1_000);
      notices.noteContactMessage(1001, { ...ADA, contactId: "contact:other" }, 1, 1_000);
      expect(notices.ownersWithPending().sort()).toEqual([OWNER, 1001]);
      expect(notices.next(1001)?.subject.contactId).toBe("contact:other");
    });
  });
});
