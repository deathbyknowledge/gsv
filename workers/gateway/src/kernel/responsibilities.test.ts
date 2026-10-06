import { describe, expect, it } from "vitest";

import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import type { KernelContext } from "./context";
import { handleResponsibilityGet } from "./responsibilities";
import { ResponsibilityStore } from "./responsibility-store";

function ownerContext(responsibilities: ResponsibilityStore): KernelContext {
  // SAFETY: the get handler reads only the caller's owner uid and the responsibility store from its context.
  return { callerOwnerUid: 1000, responsibilities } as KernelContext;
}

describe("responsibility ids", () => {
  it("accepts a bare uuid and restores the r12y prefix", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const responsibilities = new ResponsibilityStore(storage);
      const { record } = responsibilities.create({
        ownerUid: 1000,
        title: "Welcome",
        source: { kind: "system", component: "onboarding" },
        assignee: { kind: "ship" },
        state: "waiting",
        priority: "high",
        actor: { kind: "system", component: "onboarding" },
        observedByShip: true,
        now: 1_000,
      });
      const bare = record.id.slice("r12y:".length);
      expect(bare).toHaveLength(36);

      const ctx = ownerContext(responsibilities);
      expect(handleResponsibilityGet({ id: bare }, ctx).responsibility.id).toBe(record.id);
      expect(handleResponsibilityGet({ id: record.id }, ctx).responsibility.id).toBe(record.id);
    });
  });

  it("still rejects ids that are neither form", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const ctx = ownerContext(new ResponsibilityStore(storage));
      expect(() => handleResponsibilityGet({ id: "onboarding" }, ctx)).toThrow("Invalid responsibility id: onboarding");
      expect(() => handleResponsibilityGet({ id: "r12y:onboarding" }, ctx)).toThrow("Invalid responsibility id");
      expect(() => handleResponsibilityGet({ id: "R12Y:11111111-1111-4111-8111-111111111111" }, ctx)).toThrow("Invalid responsibility id");
    });
  });
});
