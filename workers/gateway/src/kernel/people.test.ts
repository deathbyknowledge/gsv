import { describe, expect, it, vi } from "vitest";
import { createPairingSecret } from "@humansandmachines/gsv/protocol";
import { hashPassword, makeShadowEntry } from "../auth/shadow";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { testPeer } from "../test-support/peers";
import { AuthStore } from "./auth-store";
import { CapabilityStore } from "./capabilities";
import type { KernelContext } from "./context";
import { PeopleStore } from "./people";
import { IdentityLinkStore } from "./identity-links";
import { assertAdapterMessageDestinationAccess } from "./adapter-destinations";

async function fixture(work: (people: PeopleStore, ctx: KernelContext, sql: SqlStorage) => Promise<void>) {
  await runWithRealKernelSql(async (sql, storage) => {
    const auth = new AuthStore(sql);
    await auth.bootstrap();
    auth.setShadow(makeShadowEntry("root", await hashPassword("root-password")));
    const people = new PeopleStore(storage, auth);
    // SAFETY: the people owner uses only the auth/capability stores, home bucket and session invalidator below.
    const ctx = { auth, people, caps: new CapabilityStore(sql), env: { STORAGE: { head: vi.fn(async () => null), put: vi.fn(async () => null) } },
      connection: null, peer: testPeer({ account: { uid: 0, gid: 0, gids: [0], username: "root", home: "/root", cwd: "/root" }, calls: ["*"] }),
      invalidateAccountConnections: vi.fn(), adapters: { identityLinks: new IdentityLinkStore(sql), surfaceRoutes: { get: () => null } },
    } as KernelContext;
    await work(people, ctx, sql);
  });
}

async function invitation(people: PeopleStore, ctx: KernelContext, username = "friend") {
  const input = { id: crypto.randomUUID(), secret: createPairingSecret(), username };
  await people.invite(input, ctx);
  return { id: input.id, secret: input.secret, proof: createPairingSecret(), password: "friend-password" };
}

describe("Kernel human invitations and removal", () => {
  it("creates one account across concurrent receivers and preserves later credentials on exact replay", async () => {
    await fixture(async (people, ctx, sql) => {
      const request = await invitation(people, ctx);
      const requests = [request, { ...request, proof: createPairingSecret() }];
      const results = await Promise.allSettled(requests.map((input) => people.redeem(input, ctx)));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const winningIndex = results.findIndex((result) => result.status === "fulfilled");
      // Replay the persisted recipient only; the different receiver cannot claim the same receipt.
      expect(await people.redeem(requests[winningIndex], ctx)).toEqual({ uid: 1000, username: "friend" });
      expect(ctx.auth.getPasswdEntries().filter((entry) => entry.username === "friend")).toHaveLength(1);
      expect(ctx.auth.getGroupByName("users")?.members).toContain("friend");
      const stored = JSON.stringify(sql.exec("SELECT * FROM human_invitations").toArray());
      expect(stored).not.toContain(request.secret);
      expect(stored).not.toContain(request.proof);
      expect(stored).not.toContain(request.password);
      const second = await invitation(people, ctx, "another");
      const enrolled = await people.redeem(second, ctx);
      await people.setPassword({ uid: enrolled.uid, password: "later-password" }, ctx);
      expect(await people.redeem(second, ctx)).toEqual(enrolled);
      expect(await ctx.auth.authenticate("another", "later-password")).toMatchObject({ ok: true });
      await expect(people.redeem({ ...second, password: "replacement-password" }, ctx)).rejects.toThrow("already used");
    });
  });

  it("rolls back enrollment with its receipt and resumes home preparation after a lost reply", async () => {
    await fixture(async (people, ctx) => {
      const request = await invitation(people, ctx);
      const original = ctx.auth.setShadow.bind(ctx.auth);
      vi.spyOn(ctx.auth, "setShadow").mockImplementationOnce((entry) => { original(entry); throw new Error("credential write failed"); });
      await expect(people.redeem(request, ctx)).rejects.toThrow("credential write failed");
      expect(ctx.auth.getPasswdByUsername("friend")).toBeNull();
      expect(people.invitations(ctx).invitations[0].status).toBe("pending");
      vi.mocked(ctx.env.STORAGE.head).mockRejectedValueOnce(new Error("home unavailable"));
      await expect(people.redeem(request, ctx)).rejects.toThrow("home unavailable");
      expect(people.invitations(ctx).invitations[0].status).toBe("redeemed");
      expect(await people.redeem(request, ctx)).toEqual({ uid: 1000, username: "friend" });
      expect(await ctx.auth.authenticate("friend", request.password)).toMatchObject({ ok: true });
    });
  });

  it("refuses cancellation, expiry, issuer revocation, missing claims and device-purpose claims", async () => {
    await fixture(async (people, ctx, sql) => {
      const cancelled = await invitation(people, ctx, "cancelled");
      people.cancel(cancelled.id, ctx);
      await expect(people.redeem(cancelled, ctx)).rejects.toThrow("cancelled");
      const expired = await invitation(people, ctx, "expired");
      sql.exec("UPDATE human_invitations SET expires_at = 0 WHERE id = ?", expired.id);
      await expect(people.redeem(expired, ctx)).rejects.toThrow("expired");
      const revoked = await invitation(people, ctx, "revoked");
      ctx.auth.invalidateCredentials(0, "root recovered");
      await expect(people.redeem(revoked, ctx)).rejects.toThrow("cancelled");
      const deviceId = crypto.randomUUID();
      sql.exec(`INSERT INTO device_pairings (id, owner_uid, target_id, label, secret_hash, created_at, expires_at)
        VALUES (?, 0, 'device_target', 'laptop', 'secret', 0, ?)`, deviceId, Date.now() + 300_000);
      await expect(people.redeem({ ...revoked, id: deviceId }, ctx)).rejects.toThrow("unavailable");
      await expect(people.redeem({ ...revoked, id: crypto.randomUUID() }, ctx)).rejects.toThrow("unavailable");
      expect(ctx.auth.getPasswdEntries()).toHaveLength(1);
    });
  });

  it("rechecks issuer authority after password hashing and rejects Process and member administrators", async () => {
    await fixture(async (people, ctx) => {
      const request = await invitation(people, ctx);
      const pending = people.redeem(request, ctx);
      ctx.auth.invalidateCredentials(0, "root revoked during hash");
      await expect(pending).rejects.toThrow("cancelled");
      const mint = people.invite({ id: crypto.randomUUID(), secret: createPairingSecret(), username: "late" }, ctx);
      ctx.auth.invalidateCredentials(0, "root revoked during mint");
      await expect(mint).rejects.toThrow("revoked");
      ctx.peer!.provenance = { kind: "process-registry", processId: "proc:root-agent" };
      await expect(invitation(people, ctx)).rejects.toThrow("signed-in root human");
      ctx.peer = testPeer({ account: { uid: 1000, gid: 1000, gids: [1000], username: "member", home: "/home/member", cwd: "/home/member" }, calls: ["*"] });
      expect(() => people.people(ctx)).toThrow("signed-in root human");
      await expect(people.setPassword({ uid: 1001, password: "new-password" }, ctx)).rejects.toThrow("signed-in root human");
    });
  });

  it("resets and removes one member while retaining uid, group, other people and admitted work", async () => {
    await fixture(async (people, ctx) => {
      const first = await people.redeem(await invitation(people, ctx), ctx);
      const other = await people.redeem(await invitation(people, ctx, "other"), ctx);
      const firstToken = await ctx.auth.issueToken({ uid: first.uid, kind: "human" });
      const otherToken = await ctx.auth.issueToken({ uid: other.uid, kind: "human" });
      const destination = { adapter: "telegram", accountId: "managed", actorId: "actor", surface: { kind: "dm", id: "actor" } };
      ctx.adapters.identityLinks.link("telegram", "managed", "actor", first.uid, first.uid, { surfaceKind: "dm", surfaceId: "actor" });
      assertAdapterMessageDestinationAccess(destination, first.uid, ctx);
      await people.setPassword({ uid: first.uid, password: "reset-password" }, ctx);
      expect(await ctx.auth.authenticateToken("friend", firstToken.token)).toMatchObject({ ok: false });
      expect(await ctx.auth.authenticate("friend", "reset-password")).toMatchObject({ ok: true });
      expect(() => assertAdapterMessageDestinationAccess(destination, first.uid, ctx)).toThrow("not authorized");
      const prepared = await ctx.auth.prepareToken({ uid: first.uid, kind: "human" });
      people.remove(first.uid, ctx);
      people.remove(first.uid, ctx);
      expect(() => ctx.adapters.identityLinks.link("telegram", "managed", "actor", first.uid, 0)).toThrow("Removed accounts");
      expect(() => ctx.auth.storePreparedToken(prepared)).toThrow("revoked");
      expect(await ctx.auth.authenticate("friend", "reset-password")).toMatchObject({ ok: false });
      expect(await ctx.auth.authenticateToken("other", otherToken.token)).toMatchObject({ ok: true });
      expect(ctx.auth.getPasswdByUid(first.uid)?.username).toBe("friend");
      expect(ctx.auth.getGroupByGid(first.uid)).not.toBeNull();
      expect(ctx.auth.credentialEpoch(first.uid)).toBe(2);
      expect(ctx.invalidateAccountConnections).toHaveBeenCalledWith(first.uid);
      expect(people.people(ctx).people.find((person) => person.uid === first.uid)?.disabled).toBe(true);
      await expect(people.setPassword({ uid: 0, password: "root-overwrite" }, ctx)).rejects.toThrow();
      await expect(invitation(people, ctx)).rejects.toThrow("unavailable");
    });
  });
});
