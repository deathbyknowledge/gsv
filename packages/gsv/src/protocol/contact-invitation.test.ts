import { describe, expect, it } from "vitest";
import { contactInvitationDestination, contactInvitationUrl, encodeContactInvitation, parseContactInvitation } from "./contact-invitation";

const invitation = { version: 1 as const, origin: "https://alice.example", shipId: "ship:alice",
  subject: { id: "person:alice", displayName: "Alícia 宇" }, token: "fixture-token", expiresAtMs: 2_000_000_000_000 };

describe("contact invitation links", () => {
  it("preserves the original invitation through an Accounts chooser and recipient login", () => {
    const code = encodeContactInvitation(invitation);
    expect(parseContactInvitation(code).invitation).toEqual(invitation);
    const shared = contactInvitationUrl(code, "https://accounts.example/owner/signup/?resume=1");
    expect(new URL(shared).hash).toBe(`#contact=${code}`);
    expect(new URL(shared).search).toBe("?resume=1");
    expect(new URL(shared).search).not.toContain(code);
    const selected = contactInvitationDestination("https://bob.example", parseContactInvitation(shared).code);
    expect(new URL(selected).pathname).toBe("/people");
    expect(new URL(selected).search).toBe("");
    expect(new URL(selected).hash).toBe(`#contact=${code}`);
    expect(parseContactInvitation(selected)).toEqual({ code, invitation });
  });

  it("accepts existing links with an encoded separator", () => {
    const code = encodeContactInvitation(invitation);
    const url = `https://accounts.example/#${new URLSearchParams({ contact: code })}`;
    expect(url).toContain("%3A");
    expect(parseContactInvitation(url)).toEqual({ code, invitation });
  });

  it("keeps other fragment delimiters inside the contact value", () => {
    const code = "gsv-contact-v1:invalid&onboarding=other+#fragment%3A";
    const url = new URL(contactInvitationUrl(code, "https://accounts.example/?resume=1"));
    expect([...new URLSearchParams(url.hash.slice(1))]).toEqual([["contact", code]]);
    expect(url.search).toBe("?resume=1");
  });

  it("rejects broken invitations and non-space destinations", () => {
    for (const value of ["", "gsv-contact-v1:%%%", "gsv-contact-v1:e30", "https://example.com/?contact=secret", "x".repeat(12_001)]) {
      expect(() => parseContactInvitation(value)).toThrow("invitation");
    }
    for (const origin of ["javascript:alert(1)", "http://example.com", "https://user:password@example.com", "https://example.com/path", "https://example.com#other"]) {
      expect(() => contactInvitationDestination(origin, "code")).toThrow("space address");
    }
    expect(new URL(contactInvitationDestination("http://bob.localhost:8976", "code")).pathname).toBe("/people");
  });
});
