import { describe, expect, it } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { ConversationRegistry } from "./conversations";

describe("ConversationRegistry", () => {
  it("keeps one stable Home address while rotating its process handler", async () => {
    await runWithRealKernelSql((sql) => {
      const registry = new ConversationRegistry(sql);
      const first = registry.ensureHome(1000, "proc:first");
      const second = registry.ensureHome(1000, "proc:second");

      expect(second.id).toBe(first.id);
      expect(second.handlerPid).toBe("proc:second");
      expect(registry.members(first.id)).toEqual([
        { kind: "account", id: "1000", role: "member" },
        { kind: "process", id: "proc:first", role: "observer" },
        { kind: "process", id: "proc:second", role: "handler" },
      ]);
    });
  });

  it("keeps Work and shared-surface conversations separate from Home", async () => {
    await runWithRealKernelSql((sql) => {
      const registry = new ConversationRegistry(sql);
      const home = registry.ensureHome(1000, "proc:personal");
      const work = registry.ensureWork(1000, "proc:work", "Research");
      const sameWork = registry.ensureWork(1000, "proc:work", "Renamed");
      const group = registry.ensureGroup(1000, "proc:group", "Team", "telegram:a:group:g");
      const movedGroup = registry.ensureGroup(1000, "proc:new-group", "Team", "telegram:a:group:g");

      expect(new Set([home.id, work.id, group.id]).size).toBe(3);
      expect(sameWork.id).toBe(work.id);
      expect(movedGroup).toMatchObject({ id: group.id, handlerPid: "proc:new-group" });
      expect(registry.list(1000).map((item) => item.id).sort())
        .toEqual([home.id, work.id, group.id].sort());
    });
  });

  it("never crosses installation-local owner boundaries", async () => {
    await runWithRealKernelSql((sql) => {
      const registry = new ConversationRegistry(sql);
      const first = registry.ensureHome(1000, "proc:first");
      const second = registry.ensureHome(1001, "proc:second");
      expect(first.id).not.toBe(second.id);
      expect(registry.list(1000)).toEqual([first]);
      expect(registry.list(1001)).toEqual([second]);
    });
  });
});
