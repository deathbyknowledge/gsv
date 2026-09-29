import { describe, expect, it, vi } from "vitest";
import { GsvClientError } from "@humansandmachines/gsv/client";
import type { DevicePairing, SysPairCreateArgs } from "@humansandmachines/gsv/protocol";
import { deferred } from "../../testing/testHarness";
import { DevicePairingSession } from "./devicePairing";

function fixture() {
  let saved: string | null = null;
  let pairing: DevicePairing;
  const api = {
    create: vi.fn(async (args: SysPairCreateArgs) => {
      pairing = { ...args, username: "human", createdAt: Date.now(), expiresAt: Date.now() + 600_000, state: "pending" };
      return { pairing };
    }),
    list: vi.fn(async () => ({ pairings: [pairing] })),
    cancel: vi.fn(async (): Promise<{ pairing: DevicePairing }> => ({ pairing: { ...pairing, state: "cancelled" } })),
  };
  const storage = { read: () => saved, write: vi.fn((value: string) => { saved = value; }) };
  const owner = new DevicePairingSession(api, storage);
  owner.setLabel("My macbook", []);
  return { owner, api, storage };
}

describe("device invitation ownership", () => {
  it("derives the ID from the name until customized and never changes identity for an OS choice", async () => {
    const { owner, api } = fixture();
    expect(owner.snapshot().draft.targetId).toBe("my-macbook");
    owner.setLabel("My Mac", ["my-mac"]);
    expect(owner.snapshot().draft.targetId).toBe("my-mac-2");
    owner.setTargetId("work");
    owner.setLabel("Renamed Mac", []);
    owner.setPlatform("windows");
    expect(owner.snapshot().draft).toMatchObject({ label: "Renamed Mac", targetId: "work", platform: "windows" });
    expect(api.create).not.toHaveBeenCalled();
    await owner.create();
    const identity = owner.snapshot().invitation;
    owner.setPlatform("browser");
    owner.setLabel("Ignored while paired", []);
    owner.setTargetId("ignored");
    expect(owner.snapshot().invitation).toBe(identity);
    expect(owner.snapshot().draft.targetId).toBe("work");
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it("retains a lost creation acknowledgement across reload and retries the identical invitation", async () => {
    const { owner, api, storage } = fixture();
    api.create.mockRejectedValueOnce(new Error("Connection closed"));
    await owner.create();
    const request = api.create.mock.calls[0][0];
    expect(JSON.parse(storage.read()!).invitation.request).toEqual(request);
    owner.dispose();
    const reloaded = new DevicePairingSession(api, storage);
    await reloaded.create();
    expect(api.create.mock.calls[1][0]).toEqual(request);
    expect(reloaded.snapshot().invitation?.pairing?.state).toBe("pending");
    reloaded.dispose();
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it("unlocks a definitely rejected name or ID, while authorization and transport uncertainty retain recovery", async () => {
    const { owner, api } = fixture();
    api.create.mockRejectedValueOnce(new GsvClientError({ code: 400, message: "Target ID is already in use", details: { pairingCreate: "rejected" } }));
    await owner.create();
    expect(owner.snapshot()).toMatchObject({ invitation: null, pending: false, error: "Target ID is already in use" });
    owner.setTargetId("available");
    api.create.mockRejectedValueOnce(new GsvClientError({ code: 403, message: "Permission changed" }));
    await owner.create();
    expect(owner.snapshot().invitation?.request.targetId).toBe("available");
    owner.setTargetId("must-not-lose-an-uncertain-invitation");
    expect(owner.snapshot().draft.targetId).toBe("available");
  });

  it("persists before sending and does not create an invitation when storage fails", async () => {
    const { owner, api, storage } = fixture();
    storage.write.mockImplementationOnce(() => { throw new Error("quota"); });
    await owner.create();
    expect(api.create).not.toHaveBeenCalled();
    expect(owner.snapshot()).toMatchObject({ invitation: null, pending: false });
    expect(owner.snapshot().error).toContain("Could not save");
  });

  it("accepts a paired result when redemption wins cancellation and leaves its credential alone", async () => {
    const { owner, api } = fixture();
    await owner.create();
    const paired = { ...owner.snapshot().invitation!.pairing!, state: "paired" as const };
    api.cancel.mockResolvedValueOnce({ pairing: paired });
    await owner.cancel();
    expect(owner.snapshot().invitation?.pairing?.state).toBe("paired");
    await owner.cancel();
    owner.dispose();
    expect(api.cancel).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale refresh replace a cancelled invitation or a newer draft", async () => {
    const { owner, api } = fixture();
    await owner.create();
    const refresh = deferred<{ pairings: DevicePairing[] }>();
    api.list.mockReturnValueOnce(refresh.promise);
    const checking = owner.refresh();
    const old = owner.snapshot().invitation!.pairing!;
    await owner.cancel();
    owner.startAnother();
    owner.setLabel("New computer", []);
    refresh.resolve({ pairings: [old] });
    await checking;
    expect(owner.snapshot()).toMatchObject({ invitation: null, draft: { label: "New computer", targetId: "new-computer" } });
  });

  it("starts an explicit pair-again invitation with the existing ID after a completed pairing", async () => {
    const { owner, api } = fixture();
    await owner.create();
    api.list.mockResolvedValueOnce({ pairings: [{ ...owner.snapshot().invitation!.pairing!, state: "paired" }] });
    await owner.refresh();
    expect(owner.selectExisting("My renamed macbook", "my-macbook", "mac")).toBe(true);
    expect(owner.snapshot()).toMatchObject({ invitation: null, draft: { label: "My renamed macbook", targetId: "my-macbook", replace: true } });
    await owner.create();
    expect(api.create.mock.calls[1][0]).toMatchObject({ targetId: "my-macbook", replace: true });
    expect(api.create.mock.calls[1][0].id).not.toBe(api.create.mock.calls[0][0].id);
  });
});
