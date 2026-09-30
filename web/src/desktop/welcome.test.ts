import { describe, expect, it, vi } from "vitest";
import { OwnerWelcome, type WelcomeSnapshot, type WelcomeState } from "../app/services/session/ownerWelcome";

function fixture() {
  let stored: WelcomeSnapshot = { revision: "initial", value: null };
  const save = vi.fn(async (revision: string, value: WelcomeState | null) => {
    if (revision !== stored.revision) throw new Error("stale write");
    stored = { revision: crypto.randomUUID(), value }; return structuredClone(stored);
  });
  const fetcher = vi.fn<typeof fetch>();
  const reopen = () => new OwnerWelcome(structuredClone(stored), { save }, "https://gsv.space", fetcher);
  return { fetcher, save, reopen, stored: () => stored };
}
const invite = { id: "invite_owned", state: "claimed", handle: null, origin: null, lastError: null };

describe("desktop invite recovery", () => {
  it("persists verification secrets before sending and authenticates after a lost verification response", async () => {
    const f = fixture();
    let client = f.reopen();
    await client.save({ flow: "create", inviteCode: "invite_private" });
    let sessionSecret = "";
    f.fetcher.mockImplementationOnce(async (_url, options) => {
      const input = JSON.parse(String(options?.body));
      expect(f.stored().value?.challenge).toMatchObject({ id: input.challengeId, browserSecret: input.browserSecret });
      sessionSecret = f.stored().value!.sessionSecret!;
      return Response.json({ deliveryStatus: "sent" });
    });
    await client.sendCode("tester@example.com");
    f.fetcher.mockRejectedValueOnce(new TypeError("Network unavailable"));
    await expect(client.verify("123456")).rejects.toThrow("Could not connect");
    client = f.reopen();
    f.fetcher.mockImplementationOnce(async (_url, options) => {
      expect(new Headers(options?.headers).get("authorization")).toBe(`Bearer ${sessionSecret}`);
      expect(options?.credentials).toBe("omit");
      return Response.json({ email: "tester@example.com", expiresAt: Date.now() + 60_000, spaceDomain: "gsv.space", spaces: [], invites: [] });
    });
    expect((await client.session())?.email).toBe("tester@example.com");
    expect(f.stored().value?.inviteCode).toBe("invite_private");
  });

  it("saves the selected invite and handle before allocation and retries the same operation after reopening", async () => {
    const f = fixture();
    let client = f.reopen();
    await client.save({ sessionSecret: "a".repeat(64), inviteCode: "invite_private" });
    f.fetcher.mockResolvedValueOnce(Response.json(invite));
    await client.claim();
    expect(f.stored().value).toMatchObject({ inviteCode: null, inviteId: invite.id });
    f.fetcher.mockImplementationOnce(async () => {
      expect(f.stored().value).toMatchObject({ inviteId: invite.id, handle: "new-space" });
      throw new TypeError("Lost allocation response");
    });
    await expect(client.prepare(invite.id, "new-space")).rejects.toThrow();
    client = f.reopen();
    f.fetcher.mockResolvedValueOnce(Response.json({ invite: { ...invite, state: "provisioning", handle: "new-space", origin: "https://new-space.gsv.space" },
      origin: "https://new-space.gsv.space", handle: "new-space", onboardingToken: `onboard_${"a".repeat(43)}`, expiresAt: Date.now() + 60_000 }));
    expect((await client.prepare(client.state.inviteId!, client.state.handle!)).handle).toBe("new-space");
    expect(f.fetcher.mock.calls[1][0]).toBe(f.fetcher.mock.calls[2][0]);
  });

  it("does not call the server if private persistence fails and preserves logout authority on a network failure", async () => {
    const f = fixture();
    const client = f.reopen();
    f.save.mockRejectedValueOnce(new Error("Disk full"));
    await expect(client.sendCode("tester@example.com")).rejects.toThrow("Disk full");
    expect(f.fetcher).not.toHaveBeenCalled();
    await client.save({ sessionSecret: "a".repeat(64) });
    f.fetcher.mockRejectedValueOnce(new TypeError("Network unavailable"));
    await expect(client.signOut()).rejects.toThrow();
    expect(f.stored().value?.sessionSecret).toBe("a".repeat(64));
    f.fetcher.mockResolvedValueOnce(Response.json({ ok: true }));
    await client.signOut();
    expect(f.stored().value).toBeNull();
  });

  it("clears a completed invite after recovering a lost setup response without signing the owner out", async () => {
    const f = fixture();
    const beforeSetup = f.reopen();
    await beforeSetup.save({ flow: "create", sessionSecret: "a".repeat(64), inviteId: invite.id, handle: "new-space" });
    const resumed = f.reopen();
    f.fetcher.mockResolvedValueOnce(Response.json({ invite: { ...invite, state: "active", handle: "new-space", origin: "https://new-space.gsv.space" },
      origin: "https://new-space.gsv.space", handle: "new-space", onboardingToken: null, expiresAt: null }));
    expect((await resumed.prepare(invite.id, "new-space")).onboardingToken).toBeNull();
    expect(f.reopen().state).toMatchObject({ flow: "open", sessionSecret: "a".repeat(64), inviteId: null, inviteCode: null, handle: null });
    await expect(beforeSetup.save({ flow: "create", inviteId: invite.id })).rejects.toThrow("stale write");
  });
});
