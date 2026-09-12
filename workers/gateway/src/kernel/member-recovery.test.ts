import type { AdapterDeliveryContext, AdapterGatewayRequestFrame, AdapterGatewayResponseFrame } from "@humansandmachines/gsv/protocol";
import { createPairingSecret } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { hashPassword, makeShadowEntry } from "../auth/shadow";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { AuthStore } from "./auth-store";
import { IdentityLinkStore } from "./identity-links";
import type { KernelContext } from "./context";
import { MemberRecoveryStore } from "./member-recovery";

type Delivery = { context: AdapterDeliveryContext; text: string };
async function fixture(work: (store: MemberRecoveryStore, ctx: KernelContext, sql: SqlStorage, deliveries: Delivery[]) => Promise<void>) {
  await runWithRealKernelSql(async (sql, storage) => {
    const auth = new AuthStore(sql);
    await auth.bootstrap();
    auth.setShadow(makeShadowEntry("root", await hashPassword("root-password")));
    auth.addUser({ username: "member", uid: 1000, gid: 1000, gecos: "", home: "/home/member", shell: "/bin/gsv" });
    auth.setShadow(makeShadowEntry("member", await hashPassword("old-password")));
    const deliveries: Delivery[] = [];
    const adapterFrame = vi.fn(async (_scope: { installationId: string }, context: AdapterDeliveryContext, frame: AdapterGatewayRequestFrame): Promise<AdapterGatewayResponseFrame> => {
      if (frame.call !== "adapter.send") throw new Error("Unexpected adapter call");
      deliveries.push({ context, text: z.object({ text: z.string() }).parse(frame.args).text });
      return { type: "res", id: frame.id, ok: true, data: { ok: true, adapter: "telegram", accountId: context.accountId, surfaceId: context.surface.id, deliveryId: context.deliveryId } };
    });
    // SAFETY: recovery uses only these durable identity/auth stores and the ordinary adapter binding boundary.
    const ctx = { auth, installationId: "singleton", installationIdentity: { canonicalOrigin: "https://space.example.com" },
      env: { CHANNEL_TELEGRAM: { adapterFrame } }, connection: null,
      adapters: { identityLinks: new IdentityLinkStore(sql), privateDestinations: { get: () => null }, surfaceRoutes: { get: () => null } },
      invalidateAccountConnections: vi.fn(),
    } as KernelContext;
    link(ctx);
    await work(new MemberRecoveryStore(storage, auth), ctx, sql, deliveries);
  });
}
function link(ctx: KernelContext, generation = "generation-1", linkedByUid = 1000) {
  ctx.adapters.identityLinks.link("telegram", "managed", "actor-1", 1000, linkedByUid, { managed: true, surfaceKind: "dm", surfaceId: "dm-1", routeGeneration: generation });
}
function attempt(username = "member") { return { id: crypto.randomUUID(), proof: createPairingSecret(), username }; }
function code(deliveries: Delivery[]) { return deliveries.at(-1)!.text.match(/code is ([A-F0-9]{4}-[A-F0-9]{4})/)![1]; }
function redeemArgs(request: ReturnType<typeof attempt>, deliveries: Delivery[]) { return { id: request.id, proof: request.proof, code: code(deliveries), password: "new-password" }; }

describe("member recovery through a confirmed messenger", () => {
  it("delivers only to the fixed linked route and atomically resets one member across exact replay", async () => {
    await fixture(async (store, ctx, sql, deliveries) => {
      const token = await ctx.auth.issueToken({ uid: 1000, kind: "human" });
      const rootToken = await ctx.auth.issueToken({ uid: 0, kind: "human" });
      const request = attempt();
      expect(await store.start(request, ctx)).toMatchObject({ accepted: true });
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].context).toMatchObject({ accountId: "managed", actorId: "actor-1", surface: { kind: "dm", id: "dm-1" }, routeGeneration: "generation-1", deliveryId: `member-recovery:${request.id}` });
      expect(deliveries[0].text).toContain("https://space.example.com");
      await store.start(request, ctx);
      expect(deliveries).toHaveLength(1);
      const args = redeemArgs(request, deliveries);
      const stored = JSON.stringify(sql.exec("SELECT * FROM member_recovery_claims").toArray());
      for (const secret of [request.proof, args.code, args.code.replace("-", ""), args.password]) expect(stored).not.toContain(secret);
      expect(await store.redeem(args, ctx)).toEqual({ username: "member" });
      expect(await ctx.auth.authenticate("member", "new-password")).toMatchObject({ ok: true });
      expect(await ctx.auth.authenticateToken("member", token.token)).toMatchObject({ ok: false });
      expect(await ctx.auth.authenticateToken("root", rootToken.token)).toMatchObject({ ok: true });
      expect(ctx.adapters.identityLinks.list(1000)).toHaveLength(0);
      expect(ctx.invalidateAccountConnections).toHaveBeenCalledWith(1000);
      ctx.auth.setShadow(makeShadowEntry("member", await hashPassword("later-password")));
      expect(await store.redeem(args, ctx)).toEqual({ username: "member" });
      expect(await ctx.auth.authenticate("member", "later-password")).toMatchObject({ ok: true });
      await expect(store.redeem({ ...args, password: "overwrite-password" }, ctx)).rejects.toThrow();
    });
  });

  it("keeps unknown, root, disabled and unconfirmed accounts indistinguishable and rate limits deliveries", async () => {
    await fixture(async (store, ctx, sql, deliveries) => {
      ctx.auth.addUser({ username: "agent", uid: 1001, gid: 1001, gecos: "", home: "/home/agent", shell: "/bin/gsv" });
      ctx.auth.setShadow(makeShadowEntry("agent", "!"));
      ctx.adapters.identityLinks.link("telegram", "managed", "agent-actor", 1001, 1001, { managed: true, surfaceKind: "dm", surfaceId: "agent-dm", routeGeneration: "agent-generation" });
      for (const username of ["missing", "root", "agent"]) expect(await store.start(attempt(username), ctx)).toMatchObject({ accepted: true });
      link(ctx, "generation-1", 0);
      await store.start(attempt(), ctx);
      ctx.adapters.identityLinks.link("telegram", "managed", "actor-1", 1000, 1000, { surfaceKind: "dm", surfaceId: "dm-1" });
      await store.start(attempt(), ctx);
      expect(deliveries).toHaveLength(0);
      expect(sql.exec("SELECT * FROM member_recovery_claims").toArray()).toHaveLength(0);
      link(ctx);
      await store.start(attempt(), ctx);
      await store.start(attempt(), ctx);
      expect(deliveries).toHaveLength(1);
      sql.exec("UPDATE member_recovery_claims SET created_at = created_at - 61000");
      await store.start(attempt(), ctx);
      expect(deliveries).toHaveLength(2);
      ctx.auth.invalidateCredentials(1000, "removed");
      sql.exec("UPDATE account_access SET disabled_at = ? WHERE uid = 1000", Date.now());
      await store.start(attempt(), ctx);
      expect(deliveries).toHaveLength(2);
    });
  });

  it("bounds incorrect codes without letting another browser consume the attempt budget", async () => {
    await fixture(async (store, ctx, sql, deliveries) => {
      const request = attempt(); await store.start(request, ctx);
      const args = redeemArgs(request, deliveries);
      await expect(store.redeem({ ...args, proof: createPairingSecret() }, ctx)).rejects.toThrow();
      expect(sql.exec<{ failed_attempts: number }>("SELECT failed_attempts FROM member_recovery_claims").toArray()[0].failed_attempts).toBe(0);
      const wrong = args.code === "0000-0000" ? "FFFF-FFFF" : "0000-0000";
      for (let i = 0; i < 5; i++) await expect(store.redeem({ ...args, code: wrong }, ctx)).rejects.toThrow();
      expect(sql.exec<{ failed_attempts: number }>("SELECT failed_attempts FROM member_recovery_claims").toArray()[0].failed_attempts).toBe(5);
      await expect(store.redeem(args, ctx)).rejects.toThrow();
      expect(await ctx.auth.authenticate("member", "old-password")).toMatchObject({ ok: true });
    });
  });

  it("fences expiry, link replacement and account revocation around asynchronous hashing", async () => {
    await fixture(async (store, ctx, sql, deliveries) => {
      const first = attempt(); await store.start(first, ctx);
      sql.exec("UPDATE member_recovery_claims SET expires_at = 0");
      await expect(store.redeem(redeemArgs(first, deliveries), ctx)).rejects.toThrow();
      sql.exec("DELETE FROM member_recovery_claims");
      const second = attempt(); await store.start(second, ctx);
      const pending = store.redeem(redeemArgs(second, deliveries), ctx);
      link(ctx, "replacement");
      await expect(pending).rejects.toThrow();
      sql.exec("DELETE FROM member_recovery_claims");
      const third = attempt(); await store.start(third, ctx);
      const revoked = store.redeem(redeemArgs(third, deliveries), ctx);
      ctx.auth.invalidateCredentials(1000, "root reset");
      await expect(revoked).rejects.toThrow();
      sql.exec("DELETE FROM member_recovery_claims");
      const starting = store.start(attempt(), ctx);
      link(ctx, "changed-during-start");
      await starting;
      expect(sql.exec("SELECT * FROM member_recovery_claims").toArray()).toHaveLength(0);
      expect(deliveries).toHaveLength(3);
    });
  });

  it("rechecks the linked generation after the password hash finishes", async () => {
    await fixture(async (store, ctx, _sql, deliveries) => {
      const request = attempt(); await store.start(request, ctx);
      let entered!: () => void;
      let release!: () => void;
      const hashing = new Promise<void>((resolve) => { entered = resolve; });
      const resume = new Promise<void>((resolve) => { release = resolve; });
      const derive = crypto.subtle.deriveBits.bind(crypto.subtle);
      const pause = vi.spyOn(crypto.subtle, "deriveBits").mockImplementationOnce(async (...args) => {
        entered(); await resume; return derive(...args);
      });
      try {
        const pending = store.redeem(redeemArgs(request, deliveries), ctx);
        await hashing;
        link(ctx, "replaced-during-password-hash");
        release();
        await expect(pending).rejects.toThrow("revoked");
        expect(await ctx.auth.authenticate("member", "old-password")).toMatchObject({ ok: true });
      } finally { release(); pause.mockRestore(); }
    });
  });

  it("commits only one password under a race and rolls back a failed reset with its receipt", async () => {
    await fixture(async (store, ctx, sql, deliveries) => {
      const request = attempt(); await store.start(request, ctx);
      const args = redeemArgs(request, deliveries);
      const token = await ctx.auth.issueToken({ uid: 1000, kind: "human" });
      const replace = ctx.auth.replaceHumanPassword.bind(ctx.auth);
      vi.spyOn(ctx.auth, "replaceHumanPassword").mockImplementationOnce((...input) => { replace(...input); throw new Error("write failed"); });
      await expect(store.redeem(args, ctx)).rejects.toThrow("write failed");
      expect(await ctx.auth.authenticateToken("member", token.token)).toMatchObject({ ok: true });
      expect(ctx.adapters.identityLinks.list(1000)).toHaveLength(1);
      expect(sql.exec<{ redeemed_at: number | null }>("SELECT redeemed_at FROM member_recovery_claims").toArray()[0].redeemed_at).toBeNull();
      const requests = [args, { ...args, password: "different-password" }];
      const results = await Promise.allSettled(requests.map((input) => store.redeem(input, ctx)));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const winner = requests[results.findIndex((result) => result.status === "fulfilled")];
      expect(await ctx.auth.authenticate("member", winner.password)).toMatchObject({ ok: true });
      expect(await store.redeem(winner, ctx)).toEqual({ username: "member" });
    });
  });
});
