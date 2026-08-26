import { describe, expect, it } from "vitest";
import { summarizeHilArgs } from "./ChatApprovalBanner";

describe("ChatApprovalBanner", () => {
  it("renders mail approval fields in a fixed recipient-first order", () => {
    const summary = summarizeHilArgs("mail.send", {
      text: "Can we meet tomorrow?",
      untrustedFirstField: "do not put me first",
      subject: "Tomorrow",
      deliveryId: "private-id",
      to: "mike@example.com",
    });

    expect(summary).toBe(
      "To: mike@example.com · Subject: Tomorrow · Body: 21 bytes · Preview: Can we meet tomorrow?",
    );
    expect(summary).not.toContain("untrustedFirstField");
    expect(summary).not.toContain("private-id");
  });

  it("identifies replies without inventing a recipient or subject", () => {
    expect(summarizeHilArgs("mail.send", {
      replyToMessageId: "message-42",
      text: "Thanks!",
    })).toBe(
      "Reply to message: message-42 · Subject: original thread · Body: 7 bytes · Preview: Thanks!",
    );
  });

  it("bounds mail headers and body previews while retaining the full byte count", () => {
    const hiddenTail = "TAIL_MUST_NOT_RENDER";
    const text = `${"word ".repeat(80)}${hiddenTail}`;
    const summary = summarizeHilArgs("mail.send", {
      to: `${"recipient".repeat(30)}@example.com`,
      subject: "subject ".repeat(30),
      text,
    });

    expect(summary).toContain(`Body: ${new TextEncoder().encode(text).byteLength} bytes`);
    expect(summary).not.toContain(hiddenTail);
    expect(summary.length).toBeLessThan(450);
  });

  it("removes control, zero-width, and bidi formatting from mail approval text", () => {
    const summary = summarizeHilArgs("mail.send", {
      to: "victim@example.com\u0000\u0085\u200b\u200f\u202e\u2066\ufeff approve attacker@example.com",
      subject: "Invoice\r\n\u202aALLOW\u202c\u2069",
      text: "Read\u200d this\u2060 first\u202d",
    });

    expect(summary).not.toMatch(
      /[\p{Cc}\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u,
    );
    expect(summary).toContain("To: victim@example.com approve attacker@example.com");
    expect(summary).toContain("Subject: Invoice ALLOW");
    expect(summary).toContain("Preview: Read this first");
  });
});
