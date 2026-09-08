import { describe, expect, it, vi } from "vitest";
import { testPeer } from "../test-support/peers";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getDurableObjectByName } from "../shared/durable-object";
import { handleSignalUnwatch, handleSignalWatch } from "./signals";
import type { KernelContext } from "./context";
import type { Kernel } from "./do";
import type { SignalWatchStore } from "./signal-watches";

function makeContext(overrides: Partial<KernelContext> = {}): KernelContext {
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  return {
    peer: testPeer({ kind: "human", account: {
        uid: 1000,
        gid: 1000,
        gids: [1000],
        username: "hank",
        home: "/home/hank",
        cwd: "/home/hank",
      }, calls: ["*"] }),
    signalWatches: {
      upsert: vi.fn(() => ({
        created: true,
        watch: {
          watchId: "watch-1",
          createdAt: 1,
          expiresAt: 2,
        },
      })),
      removeById: vi.fn(() => 1),
      removeByKey: vi.fn(() => 1),
    },
    procs: {
      get: vi.fn(() => ({ uid: 1000, ownerUid: 1000 })),
      getOwnerUid: vi.fn(() => 1000),
    },
    targets: {
      canAccess: vi.fn(() => true),
      get: vi.fn(() => ({ target_id: "machine-visible", owner_uid: 1000 })),
    },
    auth: { getPasswdByUid: vi.fn(() => null) },
    ...overrides,
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  } as KernelContext;
}

describe("signal watch handlers", () => {
  it("reports logical rows removed from the indexed watch table", async () => {
    const kernel = await getDurableObjectByName(env.KERNEL, crypto.randomUUID());
    await runInDurableObject(kernel, (instance: Kernel) => {
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      const store = (instance as { signalWatches: SignalWatchStore }).signalWatches;
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      const target = { kind: "process" as const, processId: "proc-target" };
      const { watch } = store.upsert({
        uid: 1000, target, signal: "target.status", sourceTargetId: "machine-visible", audience: "person",
      });

      expect(store.removeById(1000, target, watch.watchId)).toBe(1);
      expect(store.removeById(1000, target, watch.watchId)).toBe(0);
    });
  });

  it("registers target watches under the calling process owner uid", () => {
    const ctx = makeContext({
      processId: "proc-agent",
      peer: testPeer({ kind: "human", account: {
          uid: 2000,
          gid: 2000,
          gids: [2000],
          username: "hank-agent",
          home: "/home/hank-agent",
          cwd: "/home/hank-agent",
        }, calls: ["*"] }),
      procs: {
        get: vi.fn((pid: string) => ({
          uid: 2000,
          ownerUid: pid === "proc-agent" || pid === "proc-child" ? 1000 : 1001,
        })),
        getOwnerUid: vi.fn((pid: string) => pid === "proc-agent" ? 1000 : null),
      },
    });

    handleSignalWatch({
      signal: "target.status",
      targetId: "machine-visible",
      key: "agent:machine-visible:status",
    }, ctx);

    expect(ctx.signalWatches.upsert).toHaveBeenCalledWith(expect.objectContaining({
      uid: 1000,
      sourceTargetId: "machine-visible",
      audience: "person",
      target: { kind: "process", processId: "proc-agent" },
    }));
  });

  it("rejects retired process sources and requires an explicit target", () => {
    const ctx = makeContext({
      processId: "proc-parent",
    });

    for (const args of [
      { signal: "proc.run.finished" },
      { signal: "proc.run.finished", processId: "proc-child" },
      { signal: "target.status", targetId: "" },
    ]) {
      expect(() => {
        // @ts-expect-error Retired source shapes intentionally violate the public contract.
        handleSignalWatch(args, ctx);
      }).toThrow("Unknown or inaccessible target");
    }
    expect(ctx.signalWatches.upsert).not.toHaveBeenCalled();
  });

  it("rejects target watch registration outside a process runtime", () => {
    const ctx = makeContext();
    expect(() => handleSignalWatch({ signal: "target.status", targetId: "machine-visible" }, ctx))
      .toThrow("signal.watch is only available to process runtimes");
    expect(ctx.signalWatches.upsert).not.toHaveBeenCalled();
  });

  it("unwatch delegates by key for the current target", () => {
    const ctx = makeContext({
      processId: "proc-parent",
    });

    const result = handleSignalUnwatch({ key: "builder:product-alpha" }, ctx);

    expect(result.removed).toBe(1);
    expect(ctx.signalWatches.removeByKey).toHaveBeenCalledWith(
      1000,
      { kind: "process", processId: "proc-parent" },
      "builder:product-alpha",
    );
  });
});
