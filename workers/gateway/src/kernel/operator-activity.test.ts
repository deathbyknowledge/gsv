import { describe, expect, it } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { OperatorActivityStore } from "./operator-activity";

describe("operator owner activity", () => {
  it("counts committed owner requests once and ignores unrelated background runs", async () => {
    await runWithRealKernelSql((sql) => {
      const store = new OperatorActivityStore(sql);
      const now = Date.now();
      store.receive({ messageId: "message:first", runId: "run:first", at: now });
      store.receive({ messageId: "message:first", runId: "run:first", at: now + 1 });
      store.finish("run:background", "ok", now);
      store.finish("run:first", "ok", now + 10);
      store.finish("run:first", "error", now + 20);
      store.receive({ messageId: "message:second", runId: "run:second", at: now + 30 });
      store.finish("run:second", "error", now + 40);
      expect(new OperatorActivityStore(sql).snapshot(now + 50)).toMatchObject({
        firstActiveAt: now, lastActiveAt: now + 30, messages: 2, tasks: 2, successfulTasks: 1, failedTasks: 1, abortedTasks: 0,
        days: [{ day: new Date(now).toISOString().slice(0, 10), messages: 2 }],
      });
    });
  });
});
