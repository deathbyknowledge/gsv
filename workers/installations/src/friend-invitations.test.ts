import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { FriendInvitations } from "./friend-invitations";
import { AccountStore } from "./store";
import { InstallationCreationInvites } from "./creation-invites";
import { InstallationOnboardingStore } from "./onboarding";
import { createOpaqueToken } from "./tokens";

const db = env.INSTALLATIONS_DB;
const accounts = new AccountStore(db, "example.com");
const creation = new InstallationCreationInvites(db, accounts, new InstallationOnboardingStore(db, accounts), { prepare: async () => {} });
const friends = new FriendInvitations(db, async () => ({ total: 5, policyRef: "early-access" }));
async function owner() {
  return (await accounts.createPrincipal({ email: `${crypto.randomUUID()}@example.com`, displayName: "Owner", verified: true })).id;
}
async function sponsor() {
  const space = await accounts.reserveInstallation({ principalId: await owner(), operationId: crypto.randomUUID(), handle: `space-${crypto.randomUUID()}` });
  await db.prepare("UPDATE installations SET state = 'active' WHERE id = ?").bind(space.installationId).run();
  return { version: 1 as const, installationId: space.installationId };
}
async function invitation(space: Awaited<ReturnType<typeof sponsor>>) {
  return { ...space, contactInviteId: crypto.randomUUID(), code: (await createOpaqueToken("invite")).raw, expiresAt: Date.now() + 60_000 };
}

describe("friend signup places", () => {
  it("keeps cancellation final when it overtakes a delayed reservation", async () => {
    const space = await sponsor(), input = await invitation(space);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delayed = new FriendInvitations(db, async () => { await gate; return { total: 5, policyRef: "early-access" }; });
    const reservation = delayed.reserve(input);
    const rejected = expect(reservation).rejects.toThrow("reservation has changed");
    await friends.cancel({ ...space, contactInviteId: input.contactInviteId });
    release();
    await rejected;
    expect(await friends.getAllowance(space)).toEqual({ total: 5, used: 0, reserved: 0, available: 5 });
    await expect(creation.claim(input.code, await owner())).rejects.toThrow("unavailable");
  });
  it("admits exactly five concurrent reservations and makes exact retries free", async () => {
    const space = await sponsor();
    const inputs = await Promise.all(Array.from({ length: 6 }, () => invitation(space)));
    const results = await Promise.allSettled(inputs.map((input) => friends.reserve(input)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    const accepted = inputs[results.findIndex((result) => result.status === "fulfilled")];
    await friends.reserve(accepted);
    expect(await friends.getAllowance(space)).toEqual({ total: 5, used: 0, reserved: 5, available: 0 });
    const { code: _code, expiresAt: _expiry, ...scope } = accepted;
    await friends.cancel(scope);
    await friends.cancel(scope);
    expect((await friends.getAllowance(space)).available).toBe(1);
    await expect(creation.claim(accepted.code, await owner())).rejects.toThrow("unavailable");
  });

  it("expires abandoned email claims without any background job", async () => {
    const space = await sponsor(), input = await invitation(space);
    await friends.reserve(input);
    const recipient = await owner(), claimed = await creation.claim(input.code, recipient);
    await db.prepare("UPDATE friend_invitations SET expires_at = 1 WHERE id = ?").bind(claimed.id).run();
    expect((await friends.getAllowance(space)).available).toBe(5);
    await expect(creation.claim(input.code, recipient)).rejects.toThrow("unavailable");
    await expect(creation.prepare(claimed.id, recipient, `expired-${crypto.randomUUID()}`)).rejects.toThrow("unavailable");
    await expect(accounts.reserveInstallation({ principalId: recipient, operationId: claimed.id,
      creationInviteId: claimed.id, handle: `expired-${crypto.randomUUID()}` })).rejects.toThrow();
  });

  it("returns an existing recipient's place and fences a simultaneous signup", async () => {
    const space = await sponsor(), input = await invitation(space);
    await friends.reserve(input);
    const recipient = await owner(), claimed = await creation.claim(input.code, recipient);
    const acceptance = { version: 1 as const, installationId: space.installationId, contactInviteId: input.contactInviteId, recipientOrigin: "https://existing.example.com" };
    await friends.accept(acceptance);
    await friends.accept(acceptance);
    expect((await friends.getAllowance(space)).available).toBe(5);
    await expect(friends.accept({ ...acceptance, recipientOrigin: "https://someone-else.example.com" })).rejects.toThrow("different Space");
    await expect(creation.prepare(claimed.id, recipient, `rejected-${crypto.randomUUID()}`)).rejects.toThrow("unavailable");
  });

  it("keeps a used place charged and only connects the Space created with that invitation", async () => {
    const space = await sponsor(), input = await invitation(space);
    await friends.reserve(input);
    const recipient = await owner(), claimed = await creation.claim(input.code, recipient);
    const prepared = await creation.prepare(claimed.id, recipient, `friend-${crypto.randomUUID()}`);
    const scope = { ...space, contactInviteId: input.contactInviteId };
    await friends.accept({ ...scope, recipientOrigin: prepared.space.canonicalOrigin });
    await friends.cancel(scope);
    expect(await friends.getAllowance(space)).toEqual({ total: 5, used: 1, reserved: 0, available: 4 });
    await expect(friends.accept({ ...scope, recipientOrigin: "https://other.example.com" })).rejects.toThrow("different Space");
    // Recipient erasure must not replenish the sponsor's lifetime allowance.
    await db.prepare("DELETE FROM installation_creation_invites WHERE id = ?").bind(claimed.id).run();
    expect((await friends.getAllowance(space)).used).toBe(1);
  });

  it("returns operator-revoked places and isolates sponsors", async () => {
    const space = await sponsor(), input = await invitation(space);
    await friends.reserve(input);
    const claimed = await creation.claim(input.code, await owner());
    const other = await sponsor();
    await friends.cancel({ ...other, contactInviteId: input.contactInviteId });
    expect((await friends.getAllowance(space)).reserved).toBe(1);
    await creation.revoke(claimed.id);
    expect((await friends.getAllowance(space)).available).toBe(5);
    await friends.accept({ ...other, contactInviteId: "ordinary-contact", recipientOrigin: "https://existing.example.com" });
  });
});
