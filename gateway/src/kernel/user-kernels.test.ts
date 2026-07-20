import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { Kernel } from "./do";
import { AuthStore } from "./auth-store";
import { CapabilityStore } from "./capabilities";
import { ConfigStore } from "./config";
import { UserKernelRegistry } from "./user-kernels";
import { makeShadowEntry } from "../auth/shadow";
import { SHIP_KERNEL_NAME, userKernelName } from "../shared/kernel-names";

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
  it("moves a permanent username through provisioning to active", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      await addHuman(state.storage.sql, "alice", 1000);
      const registry = new UserKernelRegistry(state.storage.sql);
      const reserved = registry.reserve("alice", 1000);

      expect(reserved).toMatchObject({
        username: "alice",
        uid: 1000,
        lifecycle: "provisioning",
        generation: 1,
      });
      expect(registry.getByUid(1000)).toEqual(reserved);
      expect(registry.getByUid(9999)).toBeNull();

      const active = registry.markActive("alice", 1);
      expect(active).toMatchObject({
        lifecycle: "active",
        generation: 1,
      });
      expect(registry.markActive("alice", 1)).toEqual(active);
      expect(registry.reserve("alice", 1000)).toMatchObject({
        lifecycle: "active",
        generation: 1,
      });
    });
  });

  it("rejects uid remapping and invalid lifecycle activation", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      await addHuman(state.storage.sql, "alice", 1000);
      const registry = new UserKernelRegistry(state.storage.sql);
      registry.reserve("alice", 1000);

      expect(() => registry.reserve("alice", 1001)).toThrow(/conflicts/);
      expect(() => registry.markActive("alice", 2)).toThrow(/generation mismatch/);

      state.storage.sql.exec(
        "UPDATE user_kernels SET lifecycle = 'suspended' WHERE username = 'alice'",
      );
      expect(() => registry.markActive("alice", 1)).toThrow(/cannot activate/);
    });
  });

  it("suspends only an active exact generation and increments it atomically", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      await addHuman(state.storage.sql, "alice", 1000);
      const registry = new UserKernelRegistry(state.storage.sql);
      registry.reserve("alice", 1000);

      expect(() => registry.suspend("alice", 1)).toThrow(/cannot suspend from provisioning/);
      registry.markActive("alice", 1);

      const suspended = registry.suspend("alice", 1);
      expect(suspended).toMatchObject({
        lifecycle: "suspended",
        generation: 2,
        retiredAt: null,
      });
      expect(registry.getByUid(1000)).toEqual(suspended);
      expect(() => registry.suspend("alice", 1)).toThrow(/generation mismatch/);
      expect(registry.suspend("alice", 2)).toEqual(suspended);
      expect(() => registry.suspend("alice", 3)).toThrow(/generation mismatch/);
    });
  });

  it("begins provisioning from legacy or suspended without changing generation", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      await addHuman(state.storage.sql, "alice", 1000);
      const registry = new UserKernelRegistry(state.storage.sql);
      registry.reserve("alice", 1000);
      state.storage.sql.exec(
        "UPDATE user_kernels SET lifecycle = 'legacy' WHERE username = 'alice'",
      );

      const fromLegacy = registry.beginProvisioning("alice", 1);
      expect(fromLegacy).toMatchObject({ lifecycle: "provisioning", generation: 1 });
      expect(registry.beginProvisioning("alice", 1)).toEqual(fromLegacy);

      registry.markActive("alice", 1);
      expect(() => registry.beginProvisioning("alice", 1))
        .toThrow(/cannot provision from active/);
      registry.suspend("alice", 1);
      expect(() => registry.beginProvisioning("alice", 1)).toThrow(/generation mismatch/);

      const fromSuspended = registry.beginProvisioning("alice", 2);
      expect(fromSuspended).toMatchObject({ lifecycle: "provisioning", generation: 2 });
      expect(registry.beginProvisioning("alice", 2)).toEqual(fromSuspended);
    });
  });

  it("retires every non-retired lifecycle with a generation tombstone", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const registry = new UserKernelRegistry(state.storage.sql);
      const cases = [
        { username: "legacy-user", uid: 1000, lifecycle: "legacy" },
        { username: "provisioning-user", uid: 1001, lifecycle: "provisioning" },
        { username: "active-user", uid: 1002, lifecycle: "active" },
        { username: "suspended-user", uid: 1003, lifecycle: "suspended" },
      ] as const;

      for (const entry of cases) {
        await addHuman(state.storage.sql, entry.username, entry.uid);
        registry.reserve(entry.username, entry.uid);
        if (entry.lifecycle === "legacy") {
          state.storage.sql.exec(
            "UPDATE user_kernels SET lifecycle = 'legacy' WHERE username = ?",
            entry.username,
          );
        } else if (entry.lifecycle === "active" || entry.lifecycle === "suspended") {
          registry.markActive(entry.username, 1);
          if (entry.lifecycle === "suspended") {
            registry.suspend(entry.username, 1);
          }
        }

        const before = registry.get(entry.username)!;
        expect(before.lifecycle).toBe(entry.lifecycle);
        const retired = registry.retire(entry.username, before.generation);
        expect(retired).toMatchObject({
          lifecycle: "retired",
          generation: before.generation + 1,
          retiredAt: expect.any(Number),
        });
        expect(retired.retiredAt).toBe(retired.updatedAt);
        expect(registry.getByUid(entry.uid)).toEqual(retired);
        expect(() => registry.retire(entry.username, before.generation))
          .toThrow(/generation mismatch/);
        expect(registry.retire(entry.username, retired.generation)).toEqual(retired);
        expect(() => registry.beginProvisioning(entry.username, retired.generation))
          .toThrow(/cannot provision from retired/);
        expect(() => registry.suspend(entry.username, retired.generation))
          .toThrow(/cannot suspend from retired/);
        expect(() => registry.reserve(entry.username, entry.uid)).toThrow(/conflicts/);
      }
    });
  });
});

describe("user Kernel auth projection", () => {
  it("keeps directory metadata without projecting inaccessible credentials or capabilities", async () => {
    const kernel = await getAgentByName(env.KERNEL, SHIP_KERNEL_NAME);

    await runInDurableObject(kernel, async (instance: Kernel, state) => {
      const sql = state.storage.sql;
      const auth = new AuthStore(sql);
      await auth.bootstrap();
      auth.setShadow(makeShadowEntry("root", "root-password-hash"));

      auth.addUser({
        username: "daemon",
        uid: 1,
        gid: 1,
        gecos: "daemon",
        home: "/var/empty",
        shell: "/bin/init",
      }, "system");
      auth.setShadow(makeShadowEntry("daemon", "daemon-password-hash"));
      auth.addGroup({ name: "daemon", gid: 1, members: ["daemon"] });

      for (const [username, uid] of [["alice", 1000], ["bob", 1001]] as const) {
        auth.addUser({
          username,
          uid,
          gid: uid,
          gecos: username,
          home: `/home/${username}`,
          shell: "/bin/init",
        }, "human");
        auth.setShadow(makeShadowEntry(username, `${username}-password-hash`));
        auth.addGroup({ name: username, gid: uid, members: [] });
      }

      auth.addUser({
        username: "alice-agent",
        uid: 1002,
        gid: 1002,
        gecos: "alice agent",
        home: "/home/alice-agent",
        shell: "/bin/init",
      }, "agent");
      auth.setShadow(makeShadowEntry("alice-agent", "!"));
      auth.addGroup({ name: "alice-agent", gid: 1002, members: ["alice"] });
      auth.updateGroupMembers("users", ["alice", "bob", "alice-agent"]);
      auth.setPersonalAgent(1000, 1002);

      const caps = new CapabilityStore(sql);
      expect(caps.grant(1001, "net.fetch")).toMatchObject({ ok: true });
      expect(caps.grant(1002, "repo.read")).toMatchObject({ ok: true });

      const config = new ConfigStore(sql);
      config.set("config/server/name", "shared-name");
      config.set("config/auth/authorization", "never-project-authorization");
      config.set("config/auth/private_key", "never-project-private-key");
      config.set("config/private/innocent_name", "unknown-keys-stay-private");
      config.set("users/1000/ai/model", "alice-model");
      config.set("users/1001/ai/model", "bob-model");
      config.set("repos/alice/private/created_at", "1");
      config.set("repos/alice-agent/memory/created_at", "2");
      config.set("repos/bob/public/created_at", "3");
      config.set("repos/bob/public/description", "Public repo");
      config.set("repos/bob/public/visibility", "public");
      config.set("repos/bob/private/created_at", "4");
      config.set("repos/bob/private/description", "Private repo");
      config.set("repos/bob/private/provider_token", "never-project");

      const registry = new UserKernelRegistry(sql);
      registry.reserve("alice", 1000);
      registry.markActive("alice", 1);
      registry.reserve("root", 0);
      registry.markActive("root", 1);
      const aliceKernelCapability = await (instance as any)
        .rotateUserKernelCapability(registry.get("alice")!);
      const rootKernelCapability = await (instance as any)
        .rotateUserKernelCapability(registry.get("root")!);

      const projection = await instance.getUserKernelProjection(
        userKernelName("alice"),
        "alice",
        1,
        aliceKernelCapability,
      );
      const accountLocks = new Map(
        projection.accounts.map((account) => [account.entry.username, account.locked]),
      );
      expect(projection).not.toHaveProperty("kernelCapability");

      expect([...accountLocks.keys()]).toEqual([
        "root",
        "daemon",
        "alice",
        "bob",
        "alice-agent",
      ]);
      expect(accountLocks.get("alice")).toBe(false);
      expect(accountLocks.get("alice-agent")).toBe(true);
      expect(accountLocks.get("root")).toBe(true);
      expect(accountLocks.get("daemon")).toBe(true);
      expect(accountLocks.get("bob")).toBe(true);
      expect(projection.accounts.find((account) => account.entry.username === "bob"))
        .toMatchObject({ kind: "human", locked: true });
      expect(projection.accounts.find((account) => account.entry.username === "alice-agent"))
        .toMatchObject({ kind: "agent", locked: true });

      expect(projection.groups).toContainEqual({ name: "bob", gid: 1001, members: [] });
      expect(projection.groups).toContainEqual({ name: "root", gid: 0, members: [] });
      expect(projection.groups).toContainEqual({
        name: "alice-agent",
        gid: 1002,
        members: ["alice"],
      });
      expect(projection.capabilities).not.toContainEqual({ gid: 0, capability: "*" });
      expect(projection.capabilities).not.toContainEqual({ gid: 1001, capability: "net.fetch" });
      expect(projection.capabilities).toContainEqual({ gid: 1002, capability: "repo.read" });
      expect(projection.config).toContainEqual({
        key: "config/server/name",
        value: "shared-name",
      });
      expect(projection.config.some((entry) => entry.key === "config/auth/authorization"))
        .toBe(false);
      expect(projection.config.some((entry) => entry.key === "config/auth/private_key"))
        .toBe(false);
      expect(projection.config.some((entry) => entry.key === "config/private/innocent_name"))
        .toBe(false);
      expect(projection.config).toContainEqual({
        key: "users/1000/ai/model",
        value: "alice-model",
      });
      expect(projection.config).not.toContainEqual({
        key: "users/1001/ai/model",
        value: "bob-model",
      });
      expect(projection.config).toContainEqual({
        key: "repos/alice/private/created_at",
        value: "1",
      });
      expect(projection.config).toContainEqual({
        key: "repos/alice-agent/memory/created_at",
        value: "2",
      });
      expect(projection.config).toContainEqual({
        key: "repos/bob/public/description",
        value: "Public repo",
      });
      expect(projection.config).not.toContainEqual({
        key: "repos/bob/private/description",
        value: "Private repo",
      });
      expect(projection.config.some((entry) => entry.key.endsWith("provider_token"))).toBe(false);

      const rootProjection = await instance.getUserKernelProjection(
        userKernelName("root"),
        "root",
        1,
        rootKernelCapability,
      );
      expect(rootProjection.capabilities).toContainEqual({ gid: 0, capability: "*" });
      expect(rootProjection.accounts.find((account) => account.entry.username === "bob"))
        .toMatchObject({ locked: false });
      expect(rootProjection.config).toContainEqual({
        key: "repos/bob/private/description",
        value: "Private repo",
      });
      expect(rootProjection.config.some((entry) => entry.key.endsWith("provider_token"))).toBe(false);

      sql.exec("DELETE FROM account_identities WHERE username = 'alice-agent'");
      await expect(instance.getUserKernelProjection(
        userKernelName("alice"),
        "alice",
        1,
        aliceKernelCapability,
      )).rejects.toThrow("Account identity projection is incomplete: alice-agent");
    });
  });
});
