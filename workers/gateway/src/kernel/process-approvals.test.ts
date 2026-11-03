import { expect, it, vi } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as utils from "../shared/utils";
import { runSqlMigrations } from "../schema/runner";
import type { Kernel } from "./do";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT } from "./schema/migrations";

it("drops persisted approval notices on upgrade, so no alarm decodes their retired task", async () => {
  const stub = env.KERNEL.get(env.KERNEL.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (kernel: Kernel, state) => {
    await state.storage.deleteAll();
    runSqlMigrations(state.storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter(({ id }) => id <= 91));
    state.storage.sql.exec(
      `INSERT INTO cf_agents_schedules (id, callback, payload, type, time)
       VALUES ('approval-notice', 'onProcessApprovalNotice', '{"pid":"child","runId":"child-run","requestId":"request"}', 'scheduled', 0)`,
    );
    runSqlMigrations(state.storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS);
    expect(state.storage.sql.exec("SELECT id FROM cf_agents_schedules WHERE callback = 'onProcessApprovalNotice'").toArray()).toEqual([]);
    const send = vi.spyOn(utils, "sendFrameToProcess").mockRejectedValue(new Error("No model notice should be sent"));
    const deliver = vi.spyOn(utils, "deliverEventToProcess").mockRejectedValue(new Error("No model notice should be sent"));
    try {
      await kernel.alarm();
      expect(send).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
    } finally { send.mockRestore(); deliver.mockRestore(); }
  });
});
