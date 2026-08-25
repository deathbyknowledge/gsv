import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { Kernel } from "./do";
import { AuthStore } from "./auth-store";
import { UserKernelRegistry } from "./user-kernels";

async function addHuman(sql: SqlStorage, username: string, uid: number): Promise<void> {
  const auth = new AuthStore(sql);
  await auth.bootstrap();
  auth.addUser({
    username,
    uid,
    gid: uid,
    gecos: username,
    home: `/home/${username}`,
    shell: "/bin/init",
  }, "human");
}

describe("UserKernelRegistry", () => {
  it("moves one permanent username reservation from provisioning to active", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      await addHuman(state.storage.sql, "alice", 1000);
      const registry = new UserKernelRegistry(state.storage.sql);
      const reserved = registry.reserve("alice", 1000);

      expect(reserved).toMatchObject({
        username: "alice",
        uid: 1000,
        lifecycle: "provisioning",
      });
      expect(registry.get("alice")).toEqual(reserved);
      expect(registry.getByUid(1000)).toEqual(reserved);
      expect(registry.getByUid(9999)).toBeNull();
      expect(registry.list("provisioning")).toEqual([reserved]);
      expect(registry.list("active")).toEqual([]);

      const active = registry.markActive("alice");
      expect(active).toMatchObject({
        username: "alice",
        uid: 1000,
        lifecycle: "active",
      });
      expect(registry.markActive("alice")).toEqual(active);
      expect(registry.reserve("alice", 1000)).toEqual(active);
      expect(registry.list("provisioning")).toEqual([]);
      expect(registry.list("active")).toEqual([active]);
    });
  });

  it("rejects uid remapping and activation without a reservation", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      await addHuman(state.storage.sql, "alice", 1000);
      const registry = new UserKernelRegistry(state.storage.sql);
      registry.reserve("alice", 1000);

      expect(() => registry.reserve("alice", 1001)).toThrow(/conflicts/);
      expect(() => registry.markActive("bob")).toThrow(/not reserved/);
      expect(registry.get("alice")).toMatchObject({
        uid: 1000,
        lifecycle: "provisioning",
      });
    });
  });

  it("admits only provisioning and active lifecycle values", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      await addHuman(state.storage.sql, "alice", 1000);
      const registry = new UserKernelRegistry(state.storage.sql);
      registry.reserve("alice", 1000);

      expect(() => state.storage.sql.exec(
        "UPDATE user_kernels SET lifecycle = 'legacy' WHERE username = 'alice'",
      )).toThrow(/CHECK constraint/);
      expect(() => state.storage.sql.exec(
        "UPDATE user_kernels SET lifecycle = 'suspended' WHERE username = 'alice'",
      )).toThrow(/CHECK constraint/);
      expect(registry.get("alice")).toMatchObject({ lifecycle: "provisioning" });
    });
  });
});
