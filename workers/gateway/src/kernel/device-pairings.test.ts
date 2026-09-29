import { describe, expect, it, vi } from "vitest";
import { createPairingCredential, createPairingSecret } from "@humansandmachines/gsv/protocol";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { AuthStore } from "./auth-store";
import { TargetRegistry } from "./target-registry";
import { DevicePairingStore, DEVICE_PAIRING_TTL_MS } from "./device-pairings";

function invitation(targetId = "my-macbook") {
  return { id: crypto.randomUUID(), secret: createPairingSecret(), targetId, label: "My macbook" };
}

async function fixture(work: (pairings: DevicePairingStore, auth: AuthStore, sql: SqlStorage) => Promise<void>) {
  await runWithRealKernelSql(async (sql, storage) => {
    const auth = new AuthStore(sql);
    await auth.bootstrap();
    auth.addUser({ uid: 1000, gid: 1000, username: "human", home: "/home/human", gecos: "", shell: "/bin/sh" });
    auth.addUser({ uid: 1001, gid: 1001, username: "other", home: "/home/other", gecos: "", shell: "/bin/sh" });
    await work(new DevicePairingStore(storage, auth, new TargetRegistry(sql)), auth, sql);
  });
}

describe("device invitations", () => {
  it("creates no credential until redemption and recovers acknowledgements without minting another", async () => {
    await fixture(async (pairings, auth, sql) => {
      const invite = invitation();
      const first = await pairings.create(1000, invite);
      expect(await pairings.create(1000, invite)).toEqual(first);
      expect(first.state).toBe("pending");
      expect(auth.listTokens()).toHaveLength(0);
      expect(JSON.stringify(sql.exec("SELECT * FROM device_pairings").toArray())).not.toContain(invite.secret);
      const credential = createPairingCredential();
      const redeem = { id: invite.id, secret: invite.secret, credential };
      const paired = await pairings.redeem(redeem);
      expect(paired.pairing).toMatchObject({ targetId: "my-macbook", username: "human", label: "My macbook", state: "paired" });
      expect(await pairings.redeem(redeem)).toEqual(paired);
      expect(auth.listTokens()).toHaveLength(1);
      expect(await auth.authenticateToken("human", credential, { kind: "machine", peerId: "my-macbook" })).toMatchObject({ ok: true });
      expect(await auth.authenticateToken("human", credential, { kind: "human" })).toMatchObject({ ok: false });
      expect(await auth.authenticateToken("human", credential, { kind: "machine", peerId: "another-id" })).toMatchObject({ ok: false });
      expect(await auth.authenticateToken("other", credential, { kind: "machine", peerId: "my-macbook" })).toMatchObject({ ok: false });
      expect(JSON.stringify(sql.exec("SELECT * FROM device_pairings").toArray())).not.toContain(credential);
      await expect(pairings.redeem({ ...redeem, credential: createPairingCredential() })).rejects.toThrow("already used");
      expect(pairings.cancel(1000, invite.id).state).toBe("paired");
      expect(auth.listTokens()[0].revokedAt).toBeNull();
    });
  });

  it("enforces ownership, expiry, cancellation and target reservations", async () => {
    await fixture(async (pairings, auth) => {
      const invite = invitation();
      const issued = await pairings.create(1000, invite);
      expect(pairings.list(1001)).toEqual([]);
      expect(() => pairings.cancel(1001, invite.id)).toThrow("not found");
      await expect(pairings.create(1001, invite)).rejects.toThrow("already exists");
      await expect(pairings.create(1001, invitation())).rejects.toThrow("pending invitation");
      await expect(pairings.redeem({ id: invite.id, secret: createPairingSecret(), credential: createPairingCredential() })).rejects.toThrow("Invalid");
      const clock = vi.spyOn(Date, "now").mockReturnValue(issued.createdAt + DEVICE_PAIRING_TTL_MS);
      try {
        await expect(pairings.redeem({ id: invite.id, secret: invite.secret, credential: createPairingCredential() })).rejects.toThrow("expired");
        expect(pairings.list(1000)[0].state).toBe("expired");
        const next = invitation();
        await pairings.create(1000, next);
        expect(pairings.cancel(1000, next.id).state).toBe("cancelled");
        await expect(pairings.redeem({ id: next.id, secret: next.secret, credential: createPairingCredential() })).rejects.toThrow("cancelled");
        expect(auth.listTokens()).toHaveLength(0);
      } finally { clock.mockRestore(); }
    });
  });

  it("lets only one receiver redeem and fences cancellation during credential preparation", async () => {
    await fixture(async (pairings, auth) => {
      const invite = invitation();
      await pairings.create(1000, invite);
      const results = await Promise.allSettled([
        pairings.redeem({ ...invite, credential: createPairingCredential() }),
        pairings.redeem({ ...invite, credential: createPairingCredential() }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(auth.listTokens()).toHaveLength(1);
      await expect(pairings.create(1000, invitation())).rejects.toThrow("already in use");

      const cancelled = invitation("cancel-during-redemption");
      await pairings.create(1000, cancelled);
      const original = auth.prepareToken.bind(auth);
      const prepare = vi.spyOn(auth, "prepareToken").mockImplementation(async (...args) => {
        const prepared = await original(...args);
        pairings.cancel(1000, cancelled.id);
        return prepared;
      });
      await expect(pairings.redeem({ ...cancelled, credential: createPairingCredential() })).rejects.toThrow("cancelled");
      prepare.mockRestore();
      expect(auth.listTokens()).toHaveLength(1);
    });
  });

  it("allows explicit pairing again only for an owned target and invalidates pending invitations when forgotten", async () => {
    await fixture(async (pairings, auth, sql) => {
      const targets = new TargetRegistry(sql);
      targets.register("my-macbook", 1000, 1000, ["fs.*"], "macos", "test");
      await expect(pairings.create(1000, invitation())).rejects.toThrow("already in use");
      await expect(pairings.create(1001, { ...invitation(), replace: true })).rejects.toThrow("owned existing");
      const invite = { ...invitation(), replace: true };
      await pairings.create(1000, invite);
      const paired = await pairings.redeem({ ...invite, credential: createPairingCredential() });
      expect(paired.pairing.targetId).toBe("my-macbook");
      const next = { ...invitation(), replace: true };
      await pairings.create(1000, next);
      pairings.cancelForTarget(1000, "my-macbook");
      await expect(pairings.redeem({ ...next, credential: createPairingCredential() })).rejects.toThrow("cancelled");
      expect(auth.listTokens()).toHaveLength(1);
    });
  });

  it("rolls back the credential if redemption fails before its receipt is committed", async () => {
    await fixture(async (pairings, auth) => {
      const invite = invitation();
      await pairings.create(1000, invite);
      const store = auth.storePreparedToken.bind(auth);
      const fault = vi.spyOn(auth, "storePreparedToken").mockImplementationOnce((token) => {
        store(token);
        throw new Error("Injected storage failure");
      });
      const request = { ...invite, credential: createPairingCredential() };
      await expect(pairings.redeem(request)).rejects.toThrow("Injected storage failure");
      expect(auth.listTokens()).toHaveLength(0);
      expect(pairings.list(1000)[0].state).toBe("pending");
      fault.mockRestore();
      expect((await pairings.redeem(request)).pairing.state).toBe("paired");
      expect(auth.listTokens()).toHaveLength(1);
    });
  });
});
