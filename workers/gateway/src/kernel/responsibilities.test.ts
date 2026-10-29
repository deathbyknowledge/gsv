import { describe, expect, it, vi } from "vitest";

import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import type { KernelContext } from "./context";
import { handleResponsibilityCreate, handleResponsibilityGet } from "./responsibilities";
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

describe("responsibility.created telemetry", () => {
  function createContext(responsibilities: ResponsibilityStore, processId?: string): KernelContext {
    // SAFETY: the create handler reads the caller identity, process registry, store and telemetry env from its context.
    return {
      callerOwnerUid: 1000,
      installationId: "inst_test",
      env: { GSV_TELEMETRY_ENABLED: "1" },
      processId,
      peer: { peer: { principal: { kind: "human", account: { uid: 1000, gid: 1000, gids: [1000], username: "sam", home: "/home/sam", cwd: "/home/sam" } }, grant: { calls: [] } } },
      procs: { get: vi.fn(() => (processId ? { processId, ownerUid: 1000, isPersonalController: true } : null)), getOwnerUid: vi.fn(() => 1000) },
      responsibilities,
      reconcileResponsibilityWake: vi.fn(async () => {}),
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;
  }

  it("reports who created a record, once, and nothing for a dedupe hit", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const responsibilities = new ResponsibilityStore(storage);
      const emitted: unknown[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((record) => { emitted.push(record); });
      try {
        const byShip = await handleResponsibilityCreate({ title: "Track flight prices", dedupeKey: "flights" }, createContext(responsibilities, "proc:ship"));
        await handleResponsibilityCreate({ title: "Track flight prices", dedupeKey: "flights" }, createContext(responsibilities, "proc:ship"));
        await handleResponsibilityCreate({ title: "Buy a gift", parentId: byShip.responsibility.id }, createContext(responsibilities));
      } finally {
        log.mockRestore();
      }
      const created = emitted.filter((record: any) => record?.event?.name === "responsibility.created").map((record: any) => record.event.properties);
      expect(created).toEqual([{ source: "process", parent: false }, { source: "account", parent: true }]);
      expect(JSON.stringify(emitted)).not.toContain("flight");
    });
  });
});
