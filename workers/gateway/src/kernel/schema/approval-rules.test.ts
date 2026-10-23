import { describe, expect, it } from "vitest";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { parseToolApprovalPolicy, resolveToolApproval } from "../../process/approval";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

const CODE_ASKS = ["mail.send", "sched.add", "sched.update", "approach.create"];

describe("approval rules replacing code defaults", () => {
  it("keeps every saved policy deciding mail, schedules and approaches as it did", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 72));
      const saved = {
        "users/1000/ai/tools/approval": JSON.stringify({ default: "auto", rules: [{ match: "shell.exec", target: "laptop", action: "ask" }] }),
        "users/1001/ai/tools/approval": JSON.stringify({ default: "ask", rules: [] }),
        "users/1002/ai/tools/approval": JSON.stringify({ default: "auto", rules: [
          { match: "mail.*", action: "auto" }, { match: "sched.add", target: "gsv", action: "deny" }, "junk",
        ] }),
        "users/1003/ai/tools/approval": JSON.stringify({ rules: [{ match: " approach.create ", action: "auto" }] }),
        "users/1004/ai/tools/approval": JSON.stringify({ default: "auto", rules: [
          { match: "mail.send", target: "targets/*", action: "auto" }, { match: "sched.update", target: { route: "machine" }, action: "auto" },
        ] }),
        "users/1005/ai/tools/approval": "not json",
        "config/ai/tools/approval": JSON.stringify({ default: "auto", rules: [] }),
        "users/1006/ai/models": JSON.stringify({ default: "auto", rules: [] }),
      };
      for (const [key, value] of Object.entries(saved)) sql.exec("INSERT INTO config_kv (key, value) VALUES (?, ?)", key, value);

      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);

      const stored = Object.fromEntries(sql.exec<{ key: string; value: string }>("SELECT key, value FROM config_kv").toArray()
        .map(({ key, value }) => [key, value]));
      const decide = (key: string, syscall: string) => resolveToolApproval(parseToolApprovalPolicy(stored[key]), syscall).action;
      for (const syscall of CODE_ASKS) {
        expect(decide("users/1000/ai/tools/approval", syscall)).toBe("ask");
        expect(decide("config/ai/tools/approval", syscall)).toBe("ask");
        expect(decide("users/1001/ai/tools/approval", syscall)).toBe("ask");
        expect(decide("users/1004/ai/tools/approval", syscall)).toBe("ask");
      }
      expect(stored["users/1001/ai/tools/approval"]).toBe(saved["users/1001/ai/tools/approval"]);
      expect(decide("users/1002/ai/tools/approval", "mail.send")).toBe("auto");
      expect(decide("users/1002/ai/tools/approval", "sched.add")).toBe("deny");
      expect(decide("users/1002/ai/tools/approval", "sched.update")).toBe("ask");
      expect(decide("users/1003/ai/tools/approval", "approach.create")).toBe("auto");
      expect(decide("users/1003/ai/tools/approval", "mail.send")).toBe("ask");
      expect(decide("users/1000/ai/tools/approval", "shell.exec")).toBe("auto");
      expect(stored["users/1005/ai/tools/approval"]).toBe("not json");
      expect(stored["users/1006/ai/models"]).toBe(saved["users/1006/ai/models"]);
    });
  });
});
