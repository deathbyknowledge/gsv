import { describe, expect, it, vi } from "vitest";
import { OwnerWelcome, type WelcomeSnapshot } from "../app/services/session/ownerWelcome";
import { captureCreationInvitation } from "./invitation";
import { encodeContactInvitation } from "@humansandmachines/gsv/protocol";
import { signupDestination } from "./navigation";

const origin = "https://accounts.example.com";
const code = `invite_${"x".repeat(43)}`;

describe("signup invitation links", () => {
  it("restores the contact handoff after the browser loses session storage", async () => {
    let snapshot: WelcomeSnapshot = { revision: "initial", value: null };
    const storage = { save: async (_revision: string, value: WelcomeSnapshot["value"]) => snapshot = { revision: "saved", value } };
    const contact = encodeContactInvitation({ version: 1, origin: "https://sponsor.example", shipId: "ship:sponsor",
      subject: { id: "subject:sponsor", displayName: "Sponsor" }, token: "x".repeat(43), expiresAtMs: Date.now() + 60_000 });
    const first = new OwnerWelcome(snapshot, storage, origin);
    await captureCreationInvitation(first, `${origin}/#invite=${code}`, vi.fn(), contact);
    await first.save({ inviteCode: null, inviteId: "claimed-invitation" });
    const reopened = new OwnerWelcome(snapshot, storage, origin);
    const restored = await captureCreationInvitation(reopened, `${origin}/?resume=1`, vi.fn());
    const destination = new URL(signupDestination("https://friend.example", `onboard_${"x".repeat(43)}`, restored));
    expect(new URLSearchParams(destination.hash.slice(1)).get("contact")).toBe(contact);
    expect(reopened.state.inviteId).toBe("claimed-invitation");
    expect(await captureCreationInvitation(reopened, `${origin}/#invite=${code}`, vi.fn())).toBeNull();
    expect(reopened.state.contactInvite).toBeNull();
  });
  it("keeps browser contact state out of an ordinary Desktop welcome record", async () => {
    const client = new OwnerWelcome({ revision: "initial", value: null }, {
      save: async (_revision, value) => ({ revision: "saved", value }),
    }, origin);
    await client.save({ flow: "create", inviteId: "invite_id" });
    await client.completeCreation();
    expect(client.state).not.toHaveProperty("contactInvite");
  });
  it("saves the invitation before removing its fragment, without claiming it", async () => {
    let snapshot: WelcomeSnapshot = { revision: "initial", value: null };
    const save = vi.fn(async (_revision, value) => snapshot = { revision: "saved", value });
    const fetcher = vi.fn();
    const client = new OwnerWelcome(snapshot, { save }, origin, fetcher);
    const replace = vi.fn(() => expect(snapshot.value?.inviteCode).toBe(code));
    await captureCreationInvitation(client, `${origin}/owner/signup/?resume=1#invite=${code}&contact=keep`, replace);
    expect(snapshot.value).toMatchObject({ flow: "create", inviteCode: code, inviteId: null, handle: null });
    expect(replace).toHaveBeenCalledWith(`${origin}/owner/signup/?resume=1#contact=keep`);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("leaves the link recoverable when another tab changed signup", async () => {
    const client = new OwnerWelcome({ revision: "initial", value: null }, {
      save: async () => { throw new Error("Signup changed in another tab"); },
    }, origin);
    const replace = vi.fn();
    await expect(captureCreationInvitation(client, `${origin}/#invite=${code}`, replace)).rejects.toThrow("another tab");
    expect(replace).not.toHaveBeenCalled();
  });

  it("accepts a pasted invitation link at the same claim boundary as a code", async () => {
    const save = vi.fn(async (_revision, value) => ({ revision: "saved", value }));
    const fetcher = vi.fn(async () => Response.json({ id: "invite_id", state: "claimed", handle: null, origin: null, lastError: null }));
    const client = new OwnerWelcome({ revision: "initial", value: null }, { save }, origin, fetcher);
    await client.save({ flow: "create", inviteCode: `https://signup.example.com/#invite=${code}` });
    await client.claim();
    expect(fetcher).toHaveBeenCalledWith(`${origin}/owner/api/invites/claim`, expect.objectContaining({ body: JSON.stringify({ code }) }));
    expect(client.state.inviteCode).toBeNull();
  });
});
