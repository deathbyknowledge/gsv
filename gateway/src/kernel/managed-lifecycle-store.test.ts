import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseInstallationId } from "../installation/identity";
import { Kernel } from "./do";
import { ManagedLifecycleStore } from "./managed-lifecycle-store";

describe("managed installation lifecycle store", () => {
  it("persists one idempotent recoverable deletion and its resource progress", async () => {
    const installationId = parseInstallationId(`inst_lifecycle_${crypto.randomUUID()}`);
    const kernel = await getAgentByName<Env, Kernel>(env.KERNEL, installationId);
    const result = await runInDurableObject(kernel, (instance: Kernel) => {
      const storage = (instance as unknown as { ctx: DurableObjectState }).ctx.storage;
      const store = new ManagedLifecycleStore(storage, installationId);
      const input = {
        installationId,
        operationId: "deletion_test",
        recoverableUntil: Date.now() + 60_000,
      };
      const first = store.begin(input);
      const replay = store.begin(input);
      store.markResource(input.operationId, "process_suspended", "proc:one");
      store.markResource(input.operationId, "process_suspended", "proc:one");
      const resources = [...store.completedResources(
        input.operationId,
        "process_suspended",
      )];
      const recovered = store.recover(input.operationId);
      return { first, replay, resources, recovered, current: store.get() };
    });

    expect(result.replay).toEqual(result.first);
    expect(result.resources).toEqual(["proc:one"]);
    expect(result.recovered).toBe(true);
    expect(result.current).toBeNull();
  });

  it("rejects a conflicting operation", async () => {
    const installationId = parseInstallationId(`inst_lifecycle_${crypto.randomUUID()}`);
    const kernel = await getAgentByName<Env, Kernel>(env.KERNEL, installationId);
    const message = await runInDurableObject(kernel, (instance: Kernel) => {
      const storage = (instance as unknown as { ctx: DurableObjectState }).ctx.storage;
      const store = new ManagedLifecycleStore(storage, installationId);
      store.begin({
        installationId,
        operationId: "deletion_first",
        recoverableUntil: Date.now() + 60_000,
      });
      try {
        store.begin({
          installationId,
          operationId: "deletion_second",
          recoverableUntil: Date.now() + 60_000,
        });
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });

    expect(message).toContain("conflicts with the active operation");
  });
});
