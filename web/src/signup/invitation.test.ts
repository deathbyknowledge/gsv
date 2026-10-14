import { describe, expect, it, vi } from "vitest";
import { OwnerWelcome, type WelcomeSnapshot } from "../app/services/session/ownerWelcome";
import { captureCreationInvitation } from "./invitation";

const origin = "https://accounts.example.com";
const code = `invite_${"x".repeat(43)}`;

describe("signup invitation links", () => {
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
