import { describe, expect, it, vi } from "vitest";
import { GsvClientError } from "@humansandmachines/gsv/client";
import { createPairingSecret, encodeDevicePairingCode, type DevicePairing, type DevicePairingCode, type SysPairRedeemArgs, type SysPairRedeemResult } from "@humansandmachines/gsv/protocol";
import { BrowserPairing } from "./pairing";
import type { ExtensionConfig } from "../shared/config";

function fixture() {
  const pairing: DevicePairing = { id: crypto.randomUUID(), targetId: "my-browser", label: "My browser", username: "human", createdAt: Date.now(), expiresAt: Date.now() + 600_000, state: "pending" };
  const code = encodeDevicePairingCode("https://fixture.example", pairing, createPairingSecret());
  let pending: { code: string; credential: string } | null = null;
  let config: ExtensionConfig = { gatewayUrl: "ws://localhost:8787/ws", username: "", token: "", deviceId: "chrome", autoConnect: false };
  const operations = {
    load: async () => pending,
    save: vi.fn(async (value: typeof pending) => { pending = value; }),
    config: async () => config,
    commit: vi.fn(async (value: ExtensionConfig) => { config = value; return value; }),
    redeem: vi.fn(async (_invite: DevicePairingCode, args: SysPairRedeemArgs): Promise<SysPairRedeemResult> => {
      expect(pending?.credential).toBe(args.credential);
      return { pairing: { ...pairing, state: "paired" }, tokenId: "fixture-token" };
    }),
  };
  const api = operations;
  return { code, pairing, operations, api, owner: new BrowserPairing(api) };
}

describe("browser pairing", () => {
  it("persists the receiving credential first, then commits the invitation's exact account and target", async () => {
    const { code, owner, operations } = fixture();
    const saved = await owner.pair(code);
    expect(saved).toMatchObject({ gatewayUrl: "wss://fixture.example/ws", username: "human", deviceId: "my-browser", autoConnect: true });
    expect(saved.token).toMatch(/^gsv_machine_[a-f0-9]{64}$/);
    expect(await operations.load()).toBeNull();
  });

  it("recovers a dropped acknowledgement after background restart using the same credential", async () => {
    const { code, owner, operations, api } = fixture();
    operations.redeem.mockRejectedValueOnce(new Error("Connection closed"));
    await expect(owner.pair(code)).rejects.toThrow("Connection closed");
    expect(operations.commit).not.toHaveBeenCalled();
    const recovered = await new BrowserPairing(api).pair("");
    expect(recovered.token).toBe(operations.redeem.mock.calls[0][1].credential);
    expect(operations.redeem.mock.calls[1][1]).toEqual(operations.redeem.mock.calls[0][1]);
  });

  it("does not exchange when persistence fails or replace an uncertain invitation with another", async () => {
    const { code, owner, operations, pairing } = fixture();
    operations.save.mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(owner.pair(code)).rejects.toThrow("Storage unavailable");
    expect(operations.redeem).not.toHaveBeenCalled();
    operations.redeem.mockRejectedValueOnce(new Error("Connection closed"));
    await expect(owner.pair(code)).rejects.toThrow();
    const another = encodeDevicePairingCode("https://other.example", pairing, createPairingSecret());
    await expect(owner.pair(another)).rejects.toThrow("previous pairing");
    expect(operations.redeem).toHaveBeenCalledTimes(1);
  });

  it("clears terminally refused invitations so a fresh one can be pasted", async () => {
    const { code, owner, operations } = fixture();
    operations.redeem.mockRejectedValueOnce(new GsvClientError({ code: 400, message: "Invitation expired", details: { pairing: "expired" } }));
    await expect(owner.pair(code)).rejects.toThrow("expired");
    expect(await operations.load()).toBeNull();
    expect(operations.commit).not.toHaveBeenCalled();
  });

  it("fences a late exchange result after Stop and retains the credential for recovery", async () => {
    const { code, owner, operations, pairing } = fixture();
    operations.redeem.mockImplementationOnce(async () => {
      owner.stop();
      return { pairing: { ...pairing, state: "paired" }, tokenId: "fixture-token" };
    });
    await expect(owner.pair(code)).rejects.toThrow("Pairing stopped");
    expect(operations.commit).not.toHaveBeenCalled();
    expect(await operations.load()).not.toBeNull();
    expect(owner.isPairing).toBe(false);
  });
});
