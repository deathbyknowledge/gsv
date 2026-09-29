import { describe, expect, it, vi } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { ProcessRegistry } from "./processes";
import { notifyProcessChanged, unregisterProcess } from "./process-notifications";

describe("process registry notifications", () => {
  it("publishes only committed state to the owner and announces removal once", async () => {
    await runWithRealKernelSql(async (sql) => {
      const procs = new ProcessRegistry(sql);
      const broadcastToUserUid = vi.fn();
      const ctx = { procs, broadcastToUserUid };
      procs.spawn("p", { uid: 2000, gid: 2000, gids: [2000], username: "agent", home: "/home/agent", cwd: "/home/agent" }, { ownerUid: 1000, label: "private label" });
      notifyProcessChanged(ctx, "p", ["created"]);
      expect(broadcastToUserUid).toHaveBeenCalledExactlyOnceWith(1000, "proc.changed", {
        pid: "p", changes: ["created"],
        runtime: { state: "idle", activeRunId: null, queuedCount: 0, lastActiveAt: null },
      });
      broadcastToUserUid.mockClear();
      broadcastToUserUid.mockImplementation(() => expect(procs.get("p")).toBeNull());
      unregisterProcess(ctx, "p");
      unregisterProcess(ctx, "p");
      notifyProcessChanged(ctx, "p", ["state"]);
      expect(broadcastToUserUid).toHaveBeenCalledExactlyOnceWith(1000, "process.exit", { pid: "p" });
    });
  });
});
