import { describe, expect, it } from "vitest";
import { contactInvitationDestination, contactInvitationUrl, encodeContactInvitation, OutdatedContactInvitationError, parseContactInvitation } from "./contact-invitation";

const invitation = { version: 2 as const, did: "did:plc:aliceaaaaaaaaaaaaaaaaaaa", handle: "alice.example",
  name: "Alícia 宇", token: "fixture-token", expiresAtMs: 2_000_000_000_000 };

describe("contact invitation links", () => {
  it("preserves the original invitation through an Accounts chooser and recipient login", () => {
    const code = encodeContactInvitation(invitation);
    expect(parseContactInvitation(code).invitation).toEqual(invitation);
    const shared = contactInvitationUrl(code, "https://accounts.example/owner/signup/?resume=1");
    expect(new URL(shared).hash).toMatch(/^#contact=[A-Za-z0-9_-]+$/);
    expect(new URL(shared).search).toBe("?resume=1");
    expect(new URL(shared).search).not.toContain(code);
    const payload = new URLSearchParams(new URL(shared).hash.slice(1)).get("contact")!;
    expect(parseContactInvitation(payload)).toEqual({ code, invitation });
    expect(contactInvitationUrl(payload, "https://accounts.example/owner/signup/?resume=1")).toBe(shared);
    const selected = contactInvitationDestination("https://bob.example", parseContactInvitation(shared).code);
    expect(new URL(selected).pathname).toBe("/people");
    expect(new URL(selected).search).toBe("");
    expect(new URLSearchParams(new URL(selected).hash.slice(1)).get("contact")).toBe(code);
    expect(parseContactInvitation(selected)).toEqual({ code, invitation });
  });

  it.each(["encoded", "literal"])("accepts existing links with a %s separator", (separator) => {
    const code = encodeContactInvitation(invitation);
    const fragment = separator === "encoded" ? new URLSearchParams({ contact: code }).toString() : `contact=${code}`;
    const url = `https://accounts.example/#${fragment}`;
    expect(parseContactInvitation(url)).toEqual({ code, invitation });
  });

  it("keeps other fragment delimiters inside the contact value", () => {
    const payload = "invalid&onboarding=other+#fragment%3A";
    const url = new URL(contactInvitationUrl(`gsv-contact-v2:${payload}`, "https://accounts.example/?resume=1"));
    expect([...new URLSearchParams(url.hash.slice(1))]).toEqual([["contact", payload]]);
    expect(url.search).toBe("?resume=1");
  });

  it("rejects broken invitations and non-space destinations", () => {
    for (const value of ["", "gsv-contact-v2:%%%", "gsv-contact-v2:e30", "e30", "https://example.com/#contact=e30", "https://example.com/?contact=secret", "x".repeat(12_001)]) {
      expect(() => parseContactInvitation(value)).toThrow("invitation");
    }
    for (const origin of ["javascript:alert(1)", "http://example.com", "https://user:password@example.com", "https://example.com/path", "https://example.com#other"]) {
      expect(() => contactInvitationDestination(origin, "code")).toThrow("space address");
    }
    expect(new URL(contactInvitationDestination("http://bob.localhost:8976", encodeContactInvitation(invitation))).pathname).toBe("/people");
  });

  it("asks for a new invitation when a code predates DIDs", () => {
    const old = { version: 1, origin: "https://alice.example", shipId: "ship:alice",
      subject: { id: "person:alice", displayName: "Alicia" }, token: "fixture-token", expiresAtMs: 2_000_000_000_000 };
    const payload = btoa(JSON.stringify(old)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    for (const value of [`gsv-contact-v1:${payload}`, payload, `https://accounts.example/#contact=${payload}`]) {
      expect(() => parseContactInvitation(value)).toThrow(OutdatedContactInvitationError);
      expect(() => parseContactInvitation(value)).toThrow("This invitation is from before an update. Ask for a new one.");
    }
  });

  it("refuses an invitation that names something other than a DID", () => {
    const code = encodeContactInvitation({ ...invitation, did: "ship:alice" });
    expect(() => parseContactInvitation(code)).toThrow("This invitation is not valid");
  });
});
