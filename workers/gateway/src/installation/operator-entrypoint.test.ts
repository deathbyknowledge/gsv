import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { OperatorGatewayEntrypoint } from "./operator-entrypoint";

const snapshot = {
  version: 1, installationId: "inst_operator", capturedAt: 1, ship: null, processes: { total: 0, running: 0 },
  runs: [], messengers: [], targets: [], shipEvents: { queued: 0, oldestQueuedAt: null }, openResponsibilities: 0,
};

/** What the Kernel answers; a test may add a field the contract forbids. */
type KernelAnswer = Omit<typeof snapshot, "messengers"> & { messengers: { adapter: string; linkedAt: number; actorId?: string }[] };

const person = { shipId: "ship:local", subjectId: "subject:local", did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", handle: "local.ship.test" };
const rows = { contacts: 1, blocks: 0, requests: 0, deliveries: 2 };
const survey = {
  version: 1, installationId: "inst_operator", person, references: [{ shipId: "ship:remote", subjectId: "subject:remote" }],
  waiting: rows, otherAccounts: 0,
};
const move = { version: 1, installationId: "inst_operator", moved: { ...rows, messages: 3 }, ended: { ...rows, contacts: 0, deliveries: 0, messages: 0 } };

function fixture(authority: string | undefined, state = "active", found = true, result: KernelAnswer = snapshot, identity: { survey?: object; move?: object } = {}) {
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "props", { value: authority ? { authority } : {} });
  const operatorShipSnapshot = vi.fn(async () => result);
  const operatorIdentitySurvey = vi.fn(async (_active: boolean) => identity.survey ?? survey);
  const operatorIdentityMove = vi.fn(async (_people: unknown[]) => identity.move ?? move);
  const getByName = vi.fn(() => ({ operatorShipSnapshot, operatorIdentitySurvey, operatorIdentityMove }));
  const resolveInstallation = vi.fn(async (installationId: string) => ({ found, installationId, state }));
  // SAFETY: The entrypoint reads exactly these binding props, directory records and Kernel RPC methods.
  const entrypoint = new OperatorGatewayEntrypoint(ctx as never, { KERNEL: { getByName }, INSTALLATION_DIRECTORY: { resolveInstallation } } as never);
  return { entrypoint, getByName, resolveInstallation, operatorShipSnapshot, operatorIdentitySurvey, operatorIdentityMove };
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

describe("the operator's move to DIDs", () => {
  const surveyRequest = { version: 1 as const, installationId: "inst_operator" };
  const moveRequest = { version: 1 as const, installationId: "inst_operator", people: [person] };

  it.each([undefined, "installation-deletion", "installation-owner-recovery"])("refuses authority %s before resolving", async (authority) => {
    const f = fixture(authority);
    await expect(f.entrypoint.operatorIdentitySurvey(surveyRequest)).rejects.toThrow("authority");
    await expect(f.entrypoint.operatorIdentityMove(moveRequest)).rejects.toThrow("authority");
    expect(f.resolveInstallation).not.toHaveBeenCalled();
  });

  it("never wakes a Kernel the directory does not hold as active or suspended", async () => {
    for (const f of [fixture("installation-operator", "active", false), fixture("installation-operator", "retained")]) {
      await expect(f.entrypoint.operatorIdentitySurvey(surveyRequest)).resolves.toEqual({ found: false });
      await expect(f.entrypoint.operatorIdentityMove(moveRequest)).resolves.toEqual({ found: false });
      expect(f.getByName).not.toHaveBeenCalled();
    }
  });

  it("tells the Kernel whether the Ship is active, so a suspended one publishes nothing", async () => {
    for (const [state, active] of [["active", true], ["restricted", false]] as const) {
      const f = fixture("installation-operator", state);
      await expect(f.entrypoint.operatorIdentitySurvey(surveyRequest)).resolves.toEqual({ found: true, survey });
      expect(f.operatorIdentitySurvey).toHaveBeenCalledExactlyOnceWith(active);
      await expect(f.entrypoint.operatorIdentityMove(moveRequest)).resolves.toEqual({ found: true, move });
      expect(f.operatorIdentityMove).toHaveBeenCalledExactlyOnceWith([person]);
    }
  });

  it("rejects a person named by something other than a DID before resolving", async () => {
    const f = fixture("installation-operator");
    await expect(f.entrypoint.operatorIdentityMove({ ...moveRequest, people: [{ ...person, did: "ship:remote" }] })).rejects.toThrow();
    await expect(f.entrypoint.operatorIdentityMove({ ...moveRequest, people: [{ ...person, handle: "Not A Handle" }] })).rejects.toThrow();
    expect(f.resolveInstallation).not.toHaveBeenCalled();
  });

  it("refuses a Kernel answer for another Ship, or one that does not match the contract", async () => {
    const elsewhere = fixture("installation-operator", "active", true, snapshot, { survey: { ...survey, installationId: "inst_other" }, move: { ...move, installationId: "inst_other" } });
    await expect(elsewhere.entrypoint.operatorIdentitySurvey(surveyRequest)).rejects.toThrow("another installation");
    await expect(elsewhere.entrypoint.operatorIdentityMove(moveRequest)).rejects.toThrow("another installation");
    const malformed = fixture("installation-operator", "active", true, snapshot, { survey: { ...survey, waiting: { ...rows, messages: 1 } }, move: { ...move, moved: rows } });
    await expect(malformed.entrypoint.operatorIdentitySurvey(surveyRequest)).rejects.toThrow();
    await expect(malformed.entrypoint.operatorIdentityMove(moveRequest)).rejects.toThrow();
  });
});
