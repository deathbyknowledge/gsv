import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { Kernel } from "./do";
import {
  AppRuntimeRegistry,
  type AppRuntimeLifecycleFence,
} from "./app-runtime-registry";

describe("AppRuntimeRegistry", () => {
  it("records exact control/data identities and lists them by Kernel owner", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, (_instance: Kernel, state) => {
      const registry = new AppRuntimeRegistry(state.storage.sql);
      expect(registry.rememberRunner({
        runnerName: "app-control-v3:1000:2000:pkg-chat",
        ownerUid: 2000,
        ownerUsername: "alice-agent",
        kernelOwnerUid: 1000,
        kernelOwnerUsername: "alice",
        packageId: "pkg-chat",
        seenAt: 100,
      })).toMatchObject({ firstSeenAt: 100, lastSeenAt: 100 });
      expect(registry.rememberRunner({
        runnerName: "app-control-v3:1000:2000:pkg-chat",
        ownerUid: 2000,
        ownerUsername: "alice-agent",
        kernelOwnerUid: 1000,
        kernelOwnerUsername: "alice",
        packageId: "pkg-chat",
        seenAt: 200,
      })).toMatchObject({ firstSeenAt: 100, lastSeenAt: 200 });
      registry.rememberRunner({
        runnerName: "app-data-v2:1000:2000:pkg-chat",
        ownerUid: 2000,
        ownerUsername: "alice-agent",
        kernelOwnerUid: 1000,
        kernelOwnerUsername: "alice",
        packageId: "pkg-chat",
        seenAt: 150,
      });
      registry.rememberRunner({
        runnerName: "app-control-v3:1001:3000:pkg-chat",
        ownerUid: 3000,
        ownerUsername: "bob-agent",
        kernelOwnerUid: 1001,
        kernelOwnerUsername: "bob",
        packageId: "pkg-chat",
        seenAt: 150,
      });

      expect(registry.listRunners({
        kernelOwnerUid: 1000,
        kernelOwnerUsername: "alice",
      }).map((record) => record.runnerName)).toEqual([
        "app-control-v3:1000:2000:pkg-chat",
        "app-data-v2:1000:2000:pkg-chat",
      ]);
      expect(registry.listRunners()).toHaveLength(3);
      expect(() => registry.rememberRunner({
        runnerName: "app-control-v3:1000:2001:pkg-chat",
        ownerUid: 2000,
        ownerUsername: "alice-agent",
        kernelOwnerUid: 1000,
        kernelOwnerUsername: "alice",
        packageId: "pkg-chat",
      })).toThrow("does not match");
    });
  });

  it("records separate objects when two Kernel owners run the same actor", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, (_instance: Kernel, state) => {
      const registry = new AppRuntimeRegistry(state.storage.sql);
      registry.rememberRunner({
        runnerName: "app-control-v3:1000:0:pkg-chat",
        ownerUid: 0,
        ownerUsername: "root",
        kernelOwnerUid: 1000,
        kernelOwnerUsername: "alice",
        packageId: "pkg-chat",
      });
      registry.rememberRunner({
        runnerName: "app-control-v3:1001:0:pkg-chat",
        ownerUid: 0,
        ownerUsername: "root",
        kernelOwnerUid: 1001,
        kernelOwnerUsername: "bob",
        packageId: "pkg-chat",
      });

      expect(registry.listRunners().map((record) => record.runnerName)).toEqual([
        "app-control-v3:1000:0:pkg-chat",
        "app-control-v3:1001:0:pkg-chat",
      ]);
    });
  });

  it("rejects identity conflicts without advancing the observation", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, (_instance: Kernel, state) => {
      const registry = new AppRuntimeRegistry(state.storage.sql);
      const identity = {
        runnerName: "app-control-v3:1000:2000:pkg-chat",
        ownerUid: 2000,
        ownerUsername: "alice-agent",
        kernelOwnerUid: 1000,
        kernelOwnerUsername: "alice",
        packageId: "pkg-chat",
      };
      registry.rememberRunner({ ...identity, seenAt: 100 });

      expect(() => registry.rememberRunner({
        ...identity,
        ownerUsername: "mallory",
        seenAt: 300,
      })).toThrow("identity conflict");
      expect(() => registry.rememberRunner({
        ...identity,
        kernelOwnerUsername: "bob",
        seenAt: 300,
      })).toThrow("identity conflict");
      expect(registry.getRunner(identity.runnerName)).toMatchObject({
        ...identity,
        firstSeenAt: 100,
        lastSeenAt: 100,
      });
    });
  });

  it("rejects non-canonical runner account identities", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, (_instance: Kernel, state) => {
      const registry = new AppRuntimeRegistry(state.storage.sql);
      const identity = {
        runnerName: "app-control-v3:1000:2000:pkg-chat",
        ownerUid: 2000,
        ownerUsername: "alice-agent",
        kernelOwnerUid: 1000,
        kernelOwnerUsername: "alice",
        packageId: "pkg-chat",
      };
      expect(() => registry.rememberRunner({
        ...identity,
        ownerUsername: "Alice-Agent",
      })).toThrow("owner username is invalid");
      expect(() => registry.rememberRunner({
        ...identity,
        kernelOwnerUsername: "Alice",
      })).toThrow("Kernel owner username is invalid");
      expect(() => registry.listRunners({
        kernelOwnerUid: 1000,
        kernelOwnerUsername: "Alice",
      })).toThrow("Kernel owner username is invalid");
    });
  });

  it("persists one exact retryable lifecycle fence per owner", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());
    const fence: AppRuntimeLifecycleFence = {
      ownerUid: 1000,
      ownerUsername: "alice",
      sourceKernelName: "user:alice",
      generation: 7,
      fenceId: "4f57c735-a614-4e0f-a36a-e5c60b94db15",
      targetLifecycle: "suspended",
      createdAt: 100,
    };

    await runInDurableObject(kernel, (_instance: Kernel, state) => {
      const registry = new AppRuntimeRegistry(state.storage.sql);
      expect(registry.beginLifecycleFence(fence)).toEqual(fence);
      expect(registry.beginLifecycleFence(fence)).toEqual(fence);
      expect(() => registry.beginLifecycleFence({
        ...fence,
        fenceId: "9ee7d668-5942-4c80-a90c-ec3b2efb8c91",
      })).toThrow("different AppRunner lifecycle fence");
      expect(registry.clearLifecycleFence({ ...fence, generation: 8 })).toBe(false);
      expect(registry.getLifecycleFence(1000)).toEqual(fence);
      expect(registry.clearLifecycleFence(fence)).toBe(true);
      expect(registry.getLifecycleFence(1000)).toBeNull();
    });
  });

  it("rejects non-canonical lifecycle identities", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, (_instance: Kernel, state) => {
      const registry = new AppRuntimeRegistry(state.storage.sql);
      expect(() => registry.beginLifecycleFence({
        ownerUid: 1000,
        ownerUsername: "Alice",
        sourceKernelName: "user:alice",
        generation: 1,
        fenceId: "4f57c735-a614-4e0f-a36a-e5c60b94db15",
        targetLifecycle: "provisioning",
        createdAt: 1,
      })).toThrow("lifecycle fence is invalid");
      expect(() => registry.beginLifecycleFence({
        ownerUid: 1000,
        ownerUsername: "alice",
        sourceKernelName: "user:bob",
        generation: 1,
        fenceId: "4f57c735-a614-4e0f-a36a-e5c60b94db15",
        targetLifecycle: "provisioning",
        createdAt: 1,
      })).toThrow("lifecycle fence is invalid");
    });
  });
});
