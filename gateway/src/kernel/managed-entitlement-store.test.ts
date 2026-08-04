import { env } from "cloudflare:workers";
import type { ManagedEntitlementProjection } from "@humansandmachines/gsv/protocol";
import { getAgentByName } from "agents";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseInstallationId } from "../installation/identity";
import { Kernel } from "./do";
import { ManagedEntitlementStore } from "./managed-entitlement-store";

describe("managed Kernel entitlement store", () => {
  it("is fail-closed, versioned, and idempotent", async () => {
    const installationId = parseInstallationId(`inst_entitlement_${crypto.randomUUID()}`);
    const kernel = await getAgentByName<Env, Kernel>(env.KERNEL, installationId);
    const state = await runInDurableObject(kernel, (instance: Kernel) => {
      const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
      const store = new ManagedEntitlementStore(sql, installationId);
      const active = entitlement(installationId, "active", 1);
      const restricted = entitlement(installationId, "restricted", 2);

      const initiallyAllowed = store.allowsScheduledWork();
      const first = store.project(active);
      const replay = store.project(active);
      const activeAllowed = store.allowsScheduledWork();
      const second = store.project(restricted);
      const restrictedAllowed = store.allowsScheduledWork();
      let staleError = "";
      try {
        store.project(active);
      } catch (error) {
        staleError = error instanceof Error ? error.message : String(error);
      }
      return {
        initiallyAllowed,
        first,
        replay,
        activeAllowed,
        second,
        restrictedAllowed,
        staleError,
        stored: store.get(),
      };
    });

    expect(state.initiallyAllowed).toBe(false);
    expect(state.first.changed).toBe(true);
    expect(state.replay.changed).toBe(false);
    expect(state.activeAllowed).toBe(true);
    expect(state.second.changed).toBe(true);
    expect(state.restrictedAllowed).toBe(false);
    expect(state.staleError).toContain("stale or conflicts");
    expect(state.stored).toMatchObject({ state: "restricted", version: 2 });
  });

  it("rejects a projection for another installation", async () => {
    const installationId = parseInstallationId(`inst_entitlement_${crypto.randomUUID()}`);
    const kernel = await getAgentByName<Env, Kernel>(env.KERNEL, installationId);
    const message = await runInDurableObject(kernel, (instance: Kernel) => {
      const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
      const store = new ManagedEntitlementStore(sql, installationId);
      try {
        store.project(entitlement("inst_other", "active", 1));
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(message).toContain("does not match Kernel");
  });
});

function entitlement(
  installationId: string,
  state: ManagedEntitlementProjection["state"],
  version: number,
): ManagedEntitlementProjection {
  const now = Date.now();
  return {
    installationId,
    state,
    planKey: "founding-monthly",
    inferenceBudgetMicrounits: state === "restricted" ? 0 : 5_000_000,
    inferencePeriodStartsAt: now,
    inferencePeriodEndsAt: now + 30 * 24 * 60 * 60_000,
    storageLimitBytes: 10 * 1024 ** 3,
    effectiveAt: now,
    version,
  };
}
