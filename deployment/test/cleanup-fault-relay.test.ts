import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import type { InstallationDeletionRequest } from "@humansandmachines/gsv/services/lifecycle";

const request: InstallationDeletionRequest = { version: 1, installationId: "inst_retired", operationId: "delete_fixture" };
const authority = { authority: "installation-deletion" };
const relay = resolve(import.meta.dirname, "../acceptance/cleanup-fault-relay.ts");
const owner = resolve(import.meta.dirname, "fixtures/cleanup-fault-relay-owner.ts");
const base = { compatibility_date: "2026-09-01", compatibility_flags: ["nodejs_compat"] };

describe("temporary cloud cleanup fault relay", () => {
  const harness = createTestHarness({ root: resolve(import.meta.dirname, ".."), workers: [
    { config: { ...base, name: "fault-relay", main: relay, vars: { FAULT_INSTALLATION_ID: request.installationId, FAULT_OPERATION_ID: request.operationId },
      services: [{ binding: "GATEWAY_REAL", service: "fault-owner", entrypoint: "TestOwner" }] } },
    { config: { ...base, name: "fault-invalid", main: relay, vars: { FAULT_INSTALLATION_ID: "", FAULT_OPERATION_ID: request.operationId },
      services: [{ binding: "GATEWAY_REAL", service: "fault-owner", entrypoint: "TestOwner" }] } },
    { config: { ...base, name: "fault-owner", main: owner, services: [
      { binding: "AUTHORIZED", service: "fault-relay", entrypoint: "GatewayFaultRelay", props: authority },
      { binding: "MISSING", service: "fault-relay", entrypoint: "GatewayFaultRelay" },
      { binding: "WRONG", service: "fault-relay", entrypoint: "GatewayFaultRelay", props: { authority: "adapter" } },
      { binding: "INVALID", service: "fault-invalid", entrypoint: "GatewayFaultRelay", props: authority },
      { binding: "OWNER", service: "fault-owner", entrypoint: "TestOwner" },
    ] } },
  ] });
  beforeAll(async () => { await harness.listen(); }, 30_000);
  afterAll(async () => { await harness.close(); });
  async function invoke(method: "erase" | "status" | "quiesce" | "inspect" | "import", binding = "AUTHORIZED", input = request) {
    return (await harness.getWorker("fault-owner").fetch("https://fixture.invalid/", {
      method: "POST", body: JSON.stringify({ method, binding, request: input }),
    })).json();
  }
  async function count() { return (await harness.getWorker("fault-owner").fetch("https://fixture.invalid/count")).json(); }

  it("loses the exact operation's reply after real erasure commits and leaves status readable", async () => {
    expect(await invoke("erase")).toEqual({ error: "Acceptance relay lost the committed Gateway erase reply" });
    expect(await invoke("status")).toMatchObject({ result: { ...request, phase: "live-erased", pendingResources: 0 } });
    expect(await invoke("erase")).toEqual({ error: "Acceptance relay lost the committed Gateway erase reply" });
  });
  it.each([
    { ...request, installationId: "inst_other" },
    { ...request, operationId: "delete_other" },
    { ...request, installationId: "inst_retired_extra" },
  ])("passes through other exact installation/operation pairs", async (input) => {
    expect(await invoke("erase", "AUTHORIZED", input)).toMatchObject({ result: { ...input, phase: "live-erased" } });
  });
  it.each(["MISSING", "WRONG"])("rejects %s authority on every RPC before touching Gateway", async (binding) => {
    const before = await count();
    for (const method of ["erase", "status", "quiesce", "inspect", "import"] as const) {
      expect(await invoke(method, binding)).toEqual({ error: "Installation deletion binding authority is required" });
    }
    expect(await count()).toBe(before);
  });
  it("passes discovery, import and quiescence through and exposes no public HTTP control", async () => {
    expect(await invoke("inspect")).toEqual({ result: { installationId: request.installationId, observations: [] } });
    expect(await invoke("import")).toMatchObject({ result: { installationId: request.installationId, outcome: "verified" } });
    expect(await invoke("quiesce")).toMatchObject({ result: { ...request, phase: "quiesced" } });
    expect((await harness.getWorker("fault-relay").fetch("https://fixture.invalid/", { method: "POST" })).status).toBe(404);
  });
  it("rejects invalid configuration before erasure and preserves real errors and mismatched receipts", async () => {
    const before = await count();
    expect(await invoke("erase", "INVALID")).toHaveProperty("error");
    expect(await count()).toBe(before);
    expect(await invoke("erase", "AUTHORIZED", { ...request, operationId: "real_failure" })).toEqual({ error: "Real owner failed" });
    expect(await invoke("erase", "AUTHORIZED", { ...request, operationId: "wrong_receipt" })).toEqual({ error: "Gateway erase receipt does not match the requested operation" });
  });
});
