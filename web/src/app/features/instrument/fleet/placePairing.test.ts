import { describe, expect, it, vi } from "vitest";
import type { SysTokenCreateResult } from "@humansandmachines/gsv";
import { deferred } from "../../gsv-console/messengers/messengerTestHarness";
import { issuePlacePairing, pairingOrigin } from "./placePairing";

function issued(): SysTokenCreateResult {
  return { token: { tokenId: "fixture-key", token: "synthetic-key", tokenPrefix: "fixture", uid: 1000, kind: "machine", label: "Fixture", peerId: "same-target", createdAt: 1, expiresAt: 30 } };
}

describe("Fleet pairing credential ownership", () => {
  it("issues a credential bound to the existing target ID and leaves an accepted key usable", async () => {
    const create = vi.fn(async () => issued());
    const revoke = vi.fn(async () => ({ revoked: true }));
    const result = await issuePlacePairing({ sys: { token: { create, revoke } } }, { deviceId: "same-target", label: "Fixture", expiresAt: 30 }, new AbortController().signal);
    expect(create).toHaveBeenCalledWith({ kind: "machine", peerId: "same-target", label: "Fixture", expiresAt: 30 });
    expect(result?.peerId).toBe("same-target");
    expect(revoke).not.toHaveBeenCalled();
  });

  it("does not create a credential after cancellation", async () => {
    const create = vi.fn(async () => issued());
    const revoke = vi.fn(async () => ({ revoked: true }));
    const controller = new AbortController();
    controller.abort();
    await expect(issuePlacePairing({ sys: { token: { create, revoke } } }, { deviceId: "same-target" }, controller.signal)).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("owns revocation when cancellation or navigation overtakes token issuance", async () => {
    const creation = deferred<SysTokenCreateResult>();
    const revoked = deferred<{ revoked: boolean }>();
    const create = vi.fn(() => creation.promise);
    const revoke = vi.fn(() => revoked.promise);
    const controller = new AbortController();
    const operation = issuePlacePairing({ sys: { token: { create, revoke } } }, { deviceId: "same-target" }, controller.signal);
    controller.abort();
    creation.resolve(issued());
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith({ tokenId: "fixture-key", reason: "Pairing cancelled before the key was displayed" }));
    let completed = false;
    void operation.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    revoked.resolve({ revoked: true });
    await expect(operation).resolves.toBeNull();
  });

  it("surfaces failed cleanup instead of declaring the cancelled key revoked", async () => {
    const creation = deferred<SysTokenCreateResult>();
    const controller = new AbortController();
    const operation = issuePlacePairing({ sys: { token: { create: () => creation.promise, revoke: async () => { throw new Error("offline"); } } } }, { deviceId: "same-target" }, controller.signal);
    const assertion = expect(operation).rejects.toThrow("offline");
    controller.abort();
    creation.resolve(issued());
    await assertion;
  });

  it("builds setup for the connected gateway, keeping its port and avoiding a duplicate ws path", () => {
    expect(pairingOrigin("wss://fixture.example/ws")).toBe("https://fixture.example");
    expect(pairingOrigin("ws://127.0.0.1:9123/ws")).toBe("http://127.0.0.1:9123");
  });
});
