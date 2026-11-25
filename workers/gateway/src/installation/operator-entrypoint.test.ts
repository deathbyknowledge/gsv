import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { OperatorGatewayEntrypoint } from "./operator-entrypoint";

const snapshot = {
  version: 1, installationId: "inst_operator", capturedAt: 1, ship: null, processes: { total: 0, running: 0 },
  runs: [], messengers: [], targets: [], shipEvents: { queued: 0, oldestQueuedAt: null }, openResponsibilities: 0,
};

/** What the Kernel answers; a test may add a field the contract forbids. */
type KernelAnswer = Omit<typeof snapshot, "messengers"> & { messengers: { adapter: string; linkedAt: number; actorId?: string }[] };

function fixture(authority: string | undefined, state = "active", found = true, result: KernelAnswer = snapshot, copy = "removed") {
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "props", { value: authority ? { authority } : {} });
  const operatorShipSnapshot = vi.fn(async () => result);
  const operatorTakedownsChanged = vi.fn(async () => copy);
  const operatorCampaign = vi.fn(async () => ({ status: "scheduled", atMs: 1, timezone: "Europe/Madrid", messengers: 1, lastActiveAt: null }));
  const getByName = vi.fn(() => ({ operatorShipSnapshot, operatorTakedownsChanged, operatorCampaign }));
  const resolveInstallation = vi.fn(async (installationId: string) => ({ found, installationId, state }));
  // SAFETY: The entrypoint reads exactly these binding props, directory records and Kernel RPC methods.
  const entrypoint = new OperatorGatewayEntrypoint(ctx as never, { KERNEL: { getByName }, INSTALLATION_DIRECTORY: { resolveInstallation } } as never);
  return { entrypoint, getByName, resolveInstallation, operatorShipSnapshot, operatorTakedownsChanged, operatorCampaign };
}

describe("operator gateway binding", () => {
  const request = { version: 1 as const, installationId: "inst_operator", runLimit: 20 };

  it.each([undefined, "installation-deletion", "installation-owner-recovery"])("refuses authority %s before resolving", async (authority) => {
    const f = fixture(authority);
    await expect(f.entrypoint.operatorShipSnapshot(request)).rejects.toThrow("authority");
    expect(f.resolveInstallation).not.toHaveBeenCalled();
    expect(f.getByName).not.toHaveBeenCalled();
  });

  it("never wakes a Kernel the directory does not hold as active or suspended", async () => {
    for (const f of [fixture("installation-operator", "active", false), fixture("installation-operator", "retained"), fixture("installation-operator", "provisioning")]) {
      await expect(f.entrypoint.operatorShipSnapshot(request)).resolves.toEqual({ found: false });
      expect(f.getByName).not.toHaveBeenCalled();
    }
  });

  it("rejects a malformed request before resolving", async () => {
    const f = fixture("installation-operator");
    await expect(f.entrypoint.operatorShipSnapshot({ ...request, runLimit: 500 })).rejects.toThrow();
    expect(f.resolveInstallation).not.toHaveBeenCalled();
  });

  it("returns a validated snapshot for active and suspended Ships", async () => {
    for (const state of ["active", "restricted"]) {
      const f = fixture("installation-operator", state);
      await expect(f.entrypoint.operatorShipSnapshot(request)).resolves.toEqual({ found: true, snapshot });
      expect(f.getByName).toHaveBeenCalledWith("inst_operator");
      expect(f.operatorShipSnapshot).toHaveBeenCalledWith(20);
    }
  });

  it("refuses a Kernel answer that does not match the contract", async () => {
    const f = fixture("installation-operator", "active", true, { ...snapshot, messengers: [{ adapter: "whatsapp", linkedAt: 1, actorId: "34690104444" }] });
    await expect(f.entrypoint.operatorShipSnapshot(request)).rejects.toThrow();
  });
});

describe("telling a Ship its takedowns changed", () => {
  const request = { version: 1 as const, installationId: "inst_operator" };

  it.each([undefined, "installation-deletion", "installation-owner-recovery"])("refuses authority %s before resolving", async (authority) => {
    const f = fixture(authority);
    await expect(f.entrypoint.operatorTakedownsChanged(request)).rejects.toThrow("authority");
    expect(f.resolveInstallation).not.toHaveBeenCalled();
    expect(f.getByName).not.toHaveBeenCalled();
  });

  it("never wakes a Kernel the directory does not hold as active or suspended", async () => {
    for (const f of [fixture("installation-operator", "active", false), fixture("installation-operator", "retained"), fixture("installation-operator", "provisioning")]) {
      await expect(f.entrypoint.operatorTakedownsChanged(request)).resolves.toEqual({ found: false });
      expect(f.getByName).not.toHaveBeenCalled();
    }
  });

  it("answers only what became of the Ship's copy on Bluesky, for active and suspended Ships", async () => {
    for (const state of ["active", "restricted"]) {
      const f = fixture("installation-operator", state);
      await expect(f.entrypoint.operatorTakedownsChanged(request)).resolves.toEqual({ found: true, copy: "removed" });
      expect(f.getByName).toHaveBeenCalledWith("inst_operator");
      expect(f.operatorTakedownsChanged).toHaveBeenCalledExactlyOnceWith();
    }
  });

  it("rejects a malformed request before resolving, and a Kernel answer outside the contract", async () => {
    const f = fixture("installation-operator");
    await expect(f.entrypoint.operatorTakedownsChanged({ ...request, installationId: "inst operator" })).rejects.toThrow();
    expect(f.resolveInstallation).not.toHaveBeenCalled();
    const odd = fixture("installation-operator", "active", true, snapshot, "deleted");
    await expect(odd.entrypoint.operatorTakedownsChanged(request)).rejects.toThrow();
  });

  describe("one-off operator message", () => {
    const campaign = { name: "Check-in", message: "Say hello.", slots: ["2026-11-26T11:00", "2026-11-26T14:00"], latest: "2026-11-26T19:00", dryRun: true };

    it("needs the operator authority and an active or suspended Ship", async () => {
      const refused = fixture("installation-deletion");
      await expect(refused.entrypoint.operatorCampaign({ installationId: "inst_operator", ...campaign })).rejects.toThrow("authority");
      const retained = fixture("installation-operator", "retained");
      await expect(retained.entrypoint.operatorCampaign({ installationId: "inst_operator", ...campaign })).resolves.toEqual({ found: false });
      expect(retained.getByName).not.toHaveBeenCalled();
    });

    it("hands the Kernel only a valid campaign", async () => {
      const f = fixture("installation-operator");
      await expect(f.entrypoint.operatorCampaign({ installationId: "inst_operator", ...campaign, slots: ["tomorrow"] })).rejects.toThrow();
      await expect(f.entrypoint.operatorCampaign({ installationId: "inst_operator", ...campaign })).resolves.toMatchObject({ found: true, result: { status: "scheduled" } });
      expect(f.operatorCampaign).toHaveBeenCalledWith(campaign);
    });
  });
});
