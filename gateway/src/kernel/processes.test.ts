import { describe, expect, it } from "vitest";
import { ProcessRegistry } from "./processes";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";

describe("ProcessRegistry", () => {
  const registryTest = it.extend<{ registry: ProcessRegistry }>({
    registry: async ({}, use) => {
      await runWithRealKernelSql((sql) => use(new ProcessRegistry(sql)));
    },
  });

  function makeIdentity(home: string): ProcessIdentity {
    return {
      uid: 1000,
      gid: 1000,
      gids: [1000, 100],
      username: "sam",
      home,
      cwd: home,
    };
  }

  registryTest("stores cwd on spawn", ({ registry }) => {
    registry.spawn("task:1", makeIdentity("/home/sam"), {
      profile: "task",
      cwd: "/srv/work/demo",
      label: "demo",
    });

    expect(registry.getIdentity("task:1")).toEqual({
      uid: 1000,
      gid: 1000,
      gids: [1000, 100],
      username: "sam",
      home: "/home/sam",
      cwd: "/srv/work/demo",
    });
  });

  registryTest("updates a live process label", ({ registry }) => {
    registry.spawn("task:title", makeIdentity("/home/sam"), {});

    expect(registry.setLabel("task:title", "  Review migration  ")).toBe(true);
    expect(registry.get("task:title")?.label).toBe("Review migration");
    expect(registry.setLabel("missing", "Ignored")).toBe(false);
    expect(registry.setLabel("task:title", "  ")).toBe(false);
  });

  registryTest(
    "remaps cwd inside home when identity home changes",
    ({ registry }) => {
      registry.spawn("task:2", makeIdentity("/home/sam"), {
        profile: "task",
        cwd: "/home/sam/projects/demo",
      });

      registry.updateIdentity("task:2", {
        uid: 1000,
        gid: 1000,
        gids: [1000, 100],
        username: "sam",
        home: "/srv/sam",
        cwd: "/srv/sam",
      });

      expect(registry.get("task:2")?.cwd).toBe("/srv/sam/projects/demo");
    },
  );

  registryTest(
    "preserves non-home cwd when auth identity changes",
    ({ registry }) => {
      registry.spawn("task:3", makeIdentity("/home/sam"), {
        profile: "task",
        cwd: "/srv/work/demo",
      });

      registry.updateIdentity("task:3", {
        uid: 1000,
        gid: 1000,
        gids: [1000, 100, 200],
        username: "sam",
        home: "/srv/sam",
        cwd: "/srv/sam",
      });

      const record = registry.get("task:3");
      expect(record?.cwd).toBe("/srv/work/demo");
    },
  );

  registryTest(
    "tracks runtime activity fields separately from identity metadata",
    ({ registry }) => {
      registry.spawn("task:runtime", makeIdentity("/home/sam"), {
        profile: "task",
        cwd: "/home/sam",
      });

      expect(registry.get("task:runtime")).toMatchObject({
        state: "idle",
        activeRunId: null,
        queuedCount: 0,
        lastActiveAt: null,
      });

      registry.updateRuntimeState("task:runtime", {
        state: "waiting_hil",
        activeRunId: "run-1",
        queuedCount: 2,
        lastActiveAt: 1234,
      });

      expect(registry.get("task:runtime")).toMatchObject({
        state: "waiting_hil",
        activeRunId: "run-1",
        queuedCount: 2,
        lastActiveAt: 1234,
      });
    },
  );
});
