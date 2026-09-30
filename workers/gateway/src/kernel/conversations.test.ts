import { describe, expect, it } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { ConversationRegistry } from "./conversations";
import { runSqlMigrations } from "../schema/runner";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./schema/migrations";

describe("ConversationRegistry", () => {
  it.each([0, 54])("retains the deletion inventory for new conversations after schema version %s", async (version) => {
    await runWithRealKernelSql(async (sql, storage) => {
      if (version) {
        await storage.deleteAll();
        runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id <= version));
        sql.exec(`INSERT INTO conversations (conversation_id, owner_uid, kind, title, handler_pid, latest_sequence, created_at, updated_at)
          VALUES ('conv:existing', 1000, 'contact', 'Existing', 'proc:old', 42, 1, 2)`);
        sql.exec("INSERT INTO conversation_members VALUES ('conv:existing', 'process', 'proc:old', 'handler', 1)");
        sql.exec("INSERT INTO installation_resources VALUES ('conversation', 'conv:removed', 'live-erased')");
        runKernelSqlMigrations(storage);
        runKernelSqlMigrations(storage);
        expect(sql.exec("SELECT handler_pid, latest_sequence FROM conversations WHERE conversation_id = 'conv:existing'").toArray())
          .toEqual([{ handler_pid: null, latest_sequence: 42 }]);
        expect(sql.exec("SELECT role FROM conversation_members WHERE conversation_id = 'conv:existing'").toArray()).toEqual([{ role: "observer" }]);
        expect(sql.exec("SELECT resource_id, state FROM installation_resources ORDER BY resource_id").toArray())
          .toEqual([{ resource_id: "conv:existing", state: "live" }, { resource_id: "conv:removed", state: "live-erased" }]);
      }
      const registry = new ConversationRegistry(sql);
      const conversations = [
        registry.ensureShip(1000, "proc:ship"),
        registry.ensureWork(1000, "proc:work", "Work"),
        registry.ensureGroup(1000, "proc:group", "Group", "surface:group"),
        registry.ensureContact(1000, "Contact", "conv:contact"),
      ];
      for (const conversation of conversations) {
        expect(sql.exec("SELECT state FROM installation_resources WHERE kind = 'conversation' AND resource_id = ?", conversation.id).toArray())
          .toEqual([{ state: "live" }]);
        sql.exec("DELETE FROM conversations WHERE conversation_id = ?", conversation.id);
        expect(sql.exec("SELECT state FROM installation_resources WHERE kind = 'conversation' AND resource_id = ?", conversation.id).toArray())
          .toEqual([{ state: "live" }]);
      }
    });
  });

  it("keeps contact conversations independent of Process handlers", async () => {
    await runWithRealKernelSql((sql) => {
      const registry = new ConversationRegistry(sql);
      const contact = registry.ensureContact(1000, "Alice", "conv:alice");
      registry.recordSequence(contact.id, 42);
      const renamed = registry.ensureContact(1000, "Alice Smith", contact.id);
      expect(renamed).toMatchObject({ id: contact.id, kind: "contact", title: "Alice Smith", latestSequence: 42 });
      expect(renamed.handlerPid).toBeUndefined();
      expect(registry.members(contact.id)).toEqual([{ kind: "account", id: "1000", role: "member" }]);
      expect(() => registry.setHandler(contact.id, "proc:ship")).toThrow("do not dispatch");
      expect(() => registry.ensureContact(1001, "Alice", contact.id)).toThrow("identity does not match");
    });
  });

  it("keeps one stable Ship address while rotating its process handler", async () => {
    await runWithRealKernelSql((sql) => {
      const registry = new ConversationRegistry(sql);
      const first = registry.ensureShip(1000, "proc:first");
      const second = registry.ensureShip(1000, "proc:second");

      expect(second.id).toBe(first.id);
      expect(second.handlerPid).toBe("proc:second");
      expect(registry.members(first.id)).toEqual([
        { kind: "account", id: "1000", role: "member" },
        { kind: "process", id: "proc:first", role: "observer" },
        { kind: "process", id: "proc:second", role: "handler" },
      ]);
    });
  });

  it("keeps Work and shared-surface conversations separate from Ship", async () => {
    await runWithRealKernelSql((sql) => {
      const registry = new ConversationRegistry(sql);
      const ship = registry.ensureShip(1000, "proc:personal");
      const work = registry.ensureWork(1000, "proc:work", "Research");
      const sameWork = registry.ensureWork(1000, "proc:work", "Renamed");
      const group = registry.ensureGroup(1000, "proc:group", "Team", "telegram:a:group:g");
      const movedGroup = registry.ensureGroup(1000, "proc:new-group", "Team", "telegram:a:group:g");

      expect(new Set([ship.id, work.id, group.id]).size).toBe(3);
      expect(sameWork.id).toBe(work.id);
      expect(movedGroup).toMatchObject({ id: group.id, handlerPid: "proc:new-group" });
      expect(registry.list(1000).map((item) => item.id).sort())
        .toEqual([ship.id, work.id, group.id].sort());
    });
  });

  it("never crosses installation-local owner boundaries", async () => {
    await runWithRealKernelSql((sql) => {
      const registry = new ConversationRegistry(sql);
      const first = registry.ensureShip(1000, "proc:first");
      const second = registry.ensureShip(1001, "proc:second");
      expect(first.id).not.toBe(second.id);
      expect(registry.list(1000)).toEqual([first]);
      expect(registry.list(1001)).toEqual([second]);
    });
  });
});
