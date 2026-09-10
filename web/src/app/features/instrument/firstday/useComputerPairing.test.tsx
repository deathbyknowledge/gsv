import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssuedMachineNodeToken } from "../../../services/system/consoleService";
import { createTestRoot, deferred } from "../../../testing/testHarness";
import { useComputerPairing } from "./useComputerPairing";

type Pairing = ReturnType<typeof useComputerPairing>;
type Operations = Parameters<typeof useComputerPairing>[0];
const cleanup: Array<() => Promise<void>> = [];

function credential(deviceId: string): IssuedMachineNodeToken {
  return { tokenId: `key:${deviceId}`, token: "synthetic-pairing-key", tokenPrefix: "synthetic", uid: 1000,
    kind: "machine", label: deviceId, peerId: deviceId, createdAt: 1, expiresAt: 30 };
}

async function harness(operations: Operations) {
  const root = createTestRoot("Computer pairing ownership");
  let observed: Pairing | undefined;
  function Harness() { observed = useComputerPairing(operations, []); return null; }
  cleanup.push(root.unmount);
  await root.render(<Harness />);
  return {
    unmount: root.unmount,
    current: () => {
      if (!observed) throw new Error("Pairing hook did not render");
      return observed;
    },
  };
}

beforeEach(() => vi.stubGlobal("document", {}));
afterEach(async () => {
  for (const unmount of cleanup.splice(0).reverse()) await unmount();
  vi.unstubAllGlobals();
});

describe("first-day computer pairing", () => {
  it("serializes rapid selections and waits for revocation before replacing a displayed key", async () => {
    const revocation = deferred<{ revoked: boolean }>();
    const create = vi.fn<Operations["create"]>(async ({ deviceId }) => credential(deviceId));
    const revoke = vi.fn<Operations["revoke"]>(() => revocation.promise);
    const view = await harness({ create, revoke });
    await act(async () => {
      const first = view.current().choose("mac");
      await view.current().choose("windows");
      await first;
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(view.current().issued?.os).toBe("mac");
    let replacement!: Promise<void>;
    await act(() => { replacement = view.current().choose("linux"); });
    expect(revoke).toHaveBeenCalledWith({ tokenId: "key:mac-workstation", reason: "Computer selection changed" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(view.current().pending).toBe(true);
    await act(async () => { await view.current().choose("windows"); });
    revocation.resolve({ revoked: true });
    await act(async () => { await replacement; });
    expect(create).toHaveBeenCalledTimes(2);
    expect(view.current().issued?.os).toBe("linux");
    expect(view.current().issued?.token.tokenId).toBe("key:linux-machine");
    expect(view.current().pending).toBe(false);
    await act(async () => { await view.current().choose("linux"); });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("retains the displayed key and OS when revocation fails, so switching can be retried", async () => {
    const create = vi.fn<Operations["create"]>(async ({ deviceId }) => credential(deviceId));
    const revoke = vi.fn<Operations["revoke"]>().mockRejectedValueOnce(new Error("revocation unavailable")).mockResolvedValue({ revoked: true });
    const view = await harness({ create, revoke });
    await act(async () => { await view.current().choose("mac"); });
    const previous = view.current().issued;
    await act(async () => { await view.current().choose("windows"); });
    expect(create).toHaveBeenCalledTimes(1);
    expect(view.current().issued).toBe(previous);
    expect(view.current().os).toBe("mac");
    expect(view.current().error).toBe("revocation unavailable");
    await act(async () => { await view.current().choose("windows"); });
    expect(create).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(view.current().issued?.os).toBe("windows");
    expect(view.current().error).toBe("");
  });

  it("does not restore a revoked key if replacement issuance fails", async () => {
    const create = vi.fn<Operations["create"]>().mockResolvedValueOnce(credential("mac-workstation"))
      .mockRejectedValueOnce(new Error("creation unavailable")).mockResolvedValue(credential("windows-workstation"));
    const revoke = vi.fn<Operations["revoke"]>(async () => ({ revoked: true }));
    const view = await harness({ create, revoke });
    await act(async () => { await view.current().choose("mac"); });
    await act(async () => { await view.current().choose("windows"); });
    expect(view.current().issued).toBeNull();
    expect(view.current().os).toBe("windows");
    expect(view.current().error).toBe("creation unavailable");
    await act(async () => { await view.current().choose("windows"); });
    expect(view.current().issued?.os).toBe("windows");
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("waits for cleanup when a key arrives after the panel closes", async () => {
    const creation = deferred<IssuedMachineNodeToken>();
    const revocation = deferred<{ revoked: boolean }>();
    const revoke = vi.fn<Operations["revoke"]>(() => revocation.promise);
    const view = await harness({ create: () => creation.promise, revoke });
    let operation!: Promise<void>;
    await act(() => { operation = view.current().choose("mac"); });
    await view.unmount();
    creation.resolve(credential("mac-workstation"));
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith({ tokenId: "key:mac-workstation", reason: "Connection closed before the pairing key was displayed" }));
    let finished = false;
    void operation.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    revocation.resolve({ revoked: true });
    await operation;
  });

  it("does not mint a replacement if the panel closes during revocation", async () => {
    const revocation = deferred<{ revoked: boolean }>();
    const create = vi.fn<Operations["create"]>(async ({ deviceId }) => credential(deviceId));
    const view = await harness({ create, revoke: () => revocation.promise });
    await act(async () => { await view.current().choose("mac"); });
    let replacement!: Promise<void>;
    await act(() => { replacement = view.current().choose("linux"); });
    await view.unmount();
    revocation.resolve({ revoked: true });
    await replacement;
    expect(create).toHaveBeenCalledTimes(1);
  });
});
