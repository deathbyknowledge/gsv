import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { inspectPhysicalResources } from "../acceptance/delayed-inference/physical-probe.ts";

const installationId = "inst_11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const request = { installationId, operationId };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const names = { kernel: installationId, process: `process:${installationId}:proc%3Atest`,
    conversation: `conversation:${installationId}:conv%3Atest`, ripgit: `installation-index:${installationId}`, "inference-executor": installationId };
  const resources = Object.entries(names).map(([kind, name], index) => ({ ownerId: kind === "inference-executor" ? "inference" : "gateway",
    kind, namespaceId: String(index + 1).repeat(32), objectId: hash(`${kind}:${name}`), name }));
  let live = false;
  let nativePhase = "live-erased";
  const open = vi.fn();
  const namespace = (kind: keyof typeof names) => ({ idFromName: (name: string) => ({ toString: () => hash(`${kind}:${name}`) }),
    getByName(name: string) { open(kind, name); return {
      inspectInstallationResource: async () => ({ name, empty: !live }),
      fetch: async () => Response.json({ name, empty: !live }),
      installationDeletionStatus: async () => ({ ...request, phase: nativePhase, pendingResources: live ? 3 : 0 }),
    }; } });
  const scope = { ...request, resources };
  const env = { DELAY_INSTALLATION_ID: installationId, DELAY_PROCESS_ID: "proc:test", get PHYSICAL_SCOPE() { return JSON.stringify(scope); },
    PHYSICAL_KERNEL: namespace("kernel"), PHYSICAL_PROCESS: namespace("process"), PHYSICAL_CONVERSATION: namespace("conversation"),
    PHYSICAL_REPOSITORY: namespace("ripgit"), PHYSICAL_INFERENCE_EXECUTORS: namespace("inference-executor") };
  return { env, scope, open, setLive: () => { live = true; }, setPending: () => { nativePhase = "pending"; } };
}

describe("original physical resource inspection", () => {
  it("reads every fixed original address freshly and allows only excluded tombstones", async () => {
    const f = fixture();
    const first = await inspectPhysicalResources(f.env, request);
    expect(first).toMatchObject({ ...request, liveResources: 0, tombstonesExcluded: true });
    expect(first.resources).toHaveLength(5);
    expect(first.resources.map((r) => r.physicalId)).toEqual(f.scope.resources.map((r) => r.objectId));
    expect(JSON.stringify(first)).not.toContain("proc%3Atest");
    f.setLive();
    const second = await inspectPhysicalResources(f.env, request);
    expect(second.liveResources).toBe(7);
    expect(f.open).toHaveBeenCalledTimes(10);
  });

  it.each(["installation", "operation", "extra-address", "physical-id", "foreign-name", "selected-process", "missing-original"])("rejects %s before opening any object", async (failure) => {
    const f = fixture();
    const input = failure === "installation" ? { ...request, installationId: "inst_other" }
      : failure === "operation" ? { ...request, operationId: "33333333-3333-4333-8333-333333333333" }
      : failure === "extra-address" ? { ...request, resources: [] } : request;
    if (failure === "physical-id") f.scope.resources[4].objectId = "f".repeat(64);
    if (failure === "foreign-name") f.scope.resources[4].name = "inst_other";
    if (failure === "selected-process") f.env.DELAY_PROCESS_ID = "proc:other";
    if (failure === "missing-original") f.scope.resources.splice(2, 1);
    await expect(inspectPhysicalResources(f.env, input)).rejects.toThrow();
    expect(f.open).not.toHaveBeenCalled();
  });

  it("rejects malformed serialized scope before opening any object", async () => {
    const f = fixture();
    await expect(inspectPhysicalResources({ ...f.env, PHYSICAL_SCOPE: "{" }, request)).rejects.toThrow();
    expect(f.open).not.toHaveBeenCalled();
  });

  it("does not report a never-retired native executor as erased merely because it has zero rows", async () => {
    const f = fixture(); f.setPending();
    await expect(inspectPhysicalResources(f.env, request)).rejects.toThrow();
  });
});
