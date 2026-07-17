import { describe, expect, it, vi } from "vitest";
import {
  encodeDataFrameStream,
  type ManagedObjectRestoreControl,
} from "@humansandmachines/gsv/protocol/data-frame-stream";
import { ManagedLifecycleFence } from "../../shared/src/managed-lifecycle";
import {
  restoreManagedAdapterAccount,
  snapshotManagedAdapterAccount,
} from "../../shared/src/managed-portability";

const PROVIDER_ID = "a".repeat(64);

describe("managed adapter portability owner", () => {
  it("requires an exact source provider/logical namespace identity", async () => {
    const managedSnapshot = vi.fn();
    const namespace = {
      idFromName: () => ({ toString: () => "b".repeat(64) }),
      idFromString: () => ({ toString: () => PROVIDER_ID }),
      get: vi.fn(() => ({ managedSnapshot })),
    };
    await expect(snapshotManagedAdapterAccount(
      namespace as never,
      "telegram",
      {
        component: "telegram",
        kind: "adapter_account",
        providerId: PROVIDER_ID,
        logicalName: "private-account",
        objectId: "adapter-object",
        fenceEpoch: 2,
      },
    )).rejects.toThrow(/provider identity/);
    expect(namespace.get).not.toHaveBeenCalled();
  });

  it("derives the restore target from logicalName without accepting a source provider ID", async () => {
    const control: ManagedObjectRestoreControl = {
      component: "telegram",
      kind: "adapter_account",
      logicalName: "private-account",
      objectId: "adapter-object",
      restoreId: "restore-adapter",
      fenceEpoch: 1,
      frameCount: "0",
      bodyBytes: "0",
      semanticSha256: "A".repeat(43),
    };
    const managedRestore = vi.fn(async (received, stream: ReadableStream<Uint8Array>) => {
      expect(received).toEqual(control);
      await stream.cancel("test consumed");
      return {
        status: "applied" as const,
        providerId: PROVIDER_ID,
        frameCount: "0",
        bodyBytes: "0",
        semanticSha256: control.semanticSha256,
      };
    });
    const idFromName = vi.fn(() => ({ toString: () => PROVIDER_ID }));
    const namespace = {
      idFromName,
      idFromString: vi.fn(),
      get: vi.fn(() => ({ managedRestore })),
    };
    const result = await restoreManagedAdapterAccount(
      namespace as never,
      "telegram",
      control,
      encodeDataFrameStream([]),
    );
    expect(idFromName).toHaveBeenCalledWith(control.logicalName);
    expect(namespace.idFromString).not.toHaveBeenCalled();
    expect(result.providerId).toBe(PROVIDER_ID);
  });

  it("cancels bodies before rejecting infrastructure kinds", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    await expect(restoreManagedAdapterAccount(
      {} as never,
      "telegram",
      {
        component: "telegram",
        kind: "adapter_admission",
        logicalName: "singleton",
        objectId: "gate",
        restoreId: "restore-gate",
        fenceEpoch: 1,
        frameCount: "0",
        bodyBytes: "0",
        semanticSha256: "A".repeat(43),
      },
      stream,
    )).rejects.toThrow(/component and kind/);
    expect(cancelled).toBe(true);
  });
});

describe("managed adapter restore fences", () => {
  it("advances exactly once and requires exact retry epochs", async () => {
    const values = new Map<string, unknown>();
    const storage = {
      get: async (key: string) => values.get(key),
      put: async (key: string, value: unknown) => { values.set(key, value); },
    } as unknown as DurableObjectStorage;
    const lifecycle = new ManagedLifecycleFence(storage);
    await lifecycle.load();
    await expect(lifecycle.prepareRestore(1)).resolves.toMatchObject({
      status: "paused",
      epoch: 1,
    });
    await expect(lifecycle.prepareRestore(1)).resolves.toMatchObject({ epoch: 1 });
    await expect(lifecycle.prepareRestore(2)).rejects.toThrow(/existing pause fence/);
    expect(() => lifecycle.assertPaused(1)).not.toThrow();
  });
});
