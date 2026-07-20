import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { KernelProjectionState } from "./projection-state";

describe("KernelProjectionState", () => {
  it("persists a monotonic pending revision and recovers it after interruption", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance, state) => {
      const projection = new KernelProjectionState(state.storage.sql);
      expect(projection.masterRevision()).toBe(1);
      expect(projection.pendingMasterRevision()).toBeNull();

      expect(projection.beginMasterMutation()).toBe(2);
      expect(projection.pendingMasterRevision()).toBe(2);
      expect(() => projection.beginMasterMutation()).toThrow(/already in progress/);

      expect(projection.recoverPendingMasterRevision()).toBe(2);
      expect(projection.masterRevision()).toBe(2);
      expect(projection.pendingMasterRevision()).toBeNull();
      expect(projection.beginMasterMutation()).toBe(3);
      expect(projection.commitMasterMutation(3)).toBe(3);
      expect(projection.masterRevision()).toBe(3);
    });
  });

  it("requires an exact durable package fence identity to clear", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance, state) => {
      const projection = new KernelProjectionState(state.storage.sql);
      const fence = {
        fenceId: "fence-1",
        kernelGeneration: 1,
        startedAt: Date.now(),
      };
      projection.enterPackageFence(fence);
      expect(projection.packageFence()).toEqual(fence);
      expect(() => projection.enterPackageFence({
        ...fence,
        fenceId: "fence-2",
      })).toThrow(/already active/);
      expect(projection.clearPackageFence("fence-1", 2)).toBe(false);
      expect(projection.clearPackageFence("fence-2", 1)).toBe(false);
      expect(projection.packageFence()).toEqual(fence);
      expect(projection.clearPackageFence("fence-1", 1)).toBe(true);
      expect(projection.packageFence()).toBeNull();
    });
  });

  it("persists the exact installed projection generation, revision, and digest", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance, state) => {
      const projection = new KernelProjectionState(state.storage.sql);
      expect(projection.installed()).toBeNull();
      const installed = {
        username: "alice",
        uid: 1000,
        kernelGeneration: 4,
        revision: 12,
        digest: `sha256:${"a".repeat(64)}`,
      };
      projection.recordInstalled(installed);
      expect(projection.installed()).toEqual(installed);
      expect(() => projection.recordInstalled({
        ...installed,
        digest: "sha256:invalid",
      })).toThrow(/digest is invalid/);
    });
  });
});
