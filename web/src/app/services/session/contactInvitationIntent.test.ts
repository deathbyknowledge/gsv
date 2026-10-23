import { encodeContactInvitation } from "@humansandmachines/gsv/protocol";
import { describe, expect, it } from "vitest";
import { contactInvitationPreview } from "./contactInvitationIntent";

const invitation = { version: 2 as const, did: "did:plc:sponsoraaaaaaaaaaaaaaaaa", handle: "sponsor.example", name: "Sponsor", token: "x".repeat(43) };

describe("contact invitation preview", () => {
  it("names the inviter by name and handle", () => {
    expect(contactInvitationPreview(encodeContactInvitation({ ...invitation, expiresAtMs: Date.now() + 60_000 })))
      .toEqual({ name: "Sponsor", handle: "sponsor.example", expired: false });
    expect(contactInvitationPreview(encodeContactInvitation({ ...invitation, expiresAtMs: Date.now() - 1 }))).toMatchObject({ expired: true });
  });

  it("asks for a new invitation when the code is from before the update", () => {
    const payload = btoa(JSON.stringify({ version: 1, origin: "https://sponsor.example" })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(contactInvitationPreview(`gsv-contact-v1:${payload}`)).toEqual({ error: "This invitation is from before an update. Ask for a new one." });
    expect(contactInvitationPreview("not an invitation")).toEqual({ error: "This invitation is not valid. Paste the complete link or code." });
  });
});
