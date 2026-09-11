import { describe, expect, it, vi } from "vitest";
import { evictDurableObject } from "cloudflare:test";
import type { Process } from "./do";
import { approvedRun, initProcess, offeredTools, ROOT_IDENTITY, runInProcess } from "./do-test-harness";

describe("stored CodeMode approval", () => {
  it.each(["net.fetch", "mail.send", "sys.mcp.call"] as const)("restores %s after eviction without expanding the model tool surface", async (syscall) => {
    const stub = await initProcess(`restore-approval-${syscall}`, ROOT_IDENTITY);
    await runInProcess(stub, (process: Process) => {
      process.store.tools.setPendingHil({ requestId: "request", runId: "run", ownerDispatchId: "codemode",
        toolCallId: "nested", toolName: syscall, syscall, args: { target: "gsv" }, createdAt: 10 });
    });
    await evictDurableObject(stub);
    await runInProcess(stub, (process: Process) => {
      expect(process.store.tools.getPendingHil()).toMatchObject({ requestId: "request", syscall, ownerDispatchId: "codemode" });
      process.store.tools.clearPendingHil();
      expect(process.store.tools.getPendingHil()).toBeNull();
    });
  });

  it("exposes and resolves the exact nested net.fetch request, rejecting stale decisions", async () => {
    const stub = await initProcess("restore-net-fetch-decision", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      vi.spyOn(process, "sendSignal").mockResolvedValue(undefined);
      vi.spyOn(process.run, "scheduleTick").mockResolvedValue(undefined);
      process.runs.active = approvedRun("run", { tools: offeredTools("CodeMode"), offeredToolNames: ["CodeMode"] });
      process.store.tools.register("codemode", "outer", "run", "codemode.exec", { code: "return await net.fetch({ url: 'https://example.com' })" });
      process.store.tools.markDispatched("codemode");
      const waiting = process.tools.waitForCodeModeApproval("run", "codemode", "nested", "net.fetch", "net.fetch", { url: "https://example.com", target: "gsv" });
      const pending = process.store.tools.getPendingHil()!;
      const history = await process.controller.handleReq({ type: "req", id: "history", call: "proc.history", args: { includeMessages: false } });
      expect(history).toMatchObject({ ok: true, data: { pendingHil: { pid: process.pid, requestId: pending.requestId, runId: "run", syscall: "net.fetch" } } });
      expect(await process.controller.handleProcHil({ requestId: "stale", decision: "approve" })).toMatchObject({ ok: false });
      expect(process.store.tools.getPendingHil()?.requestId).toBe(pending.requestId);
      expect(await process.controller.handleProcHil({ requestId: pending.requestId, decision: "approve" })).toMatchObject({ ok: true, requestId: pending.requestId });
      expect(await waiting).toBe(true);
      expect(process.store.tools.getPendingHil()).toBeNull();
      expect(await process.controller.handleProcHil({ requestId: pending.requestId, decision: "approve" })).toMatchObject({ ok: false });
      process.runs.active = null;
    });
  });

  it("continues rejecting unknown persisted syscall names", async () => {
    const stub = await initProcess("restore-invalid-approval", ROOT_IDENTITY);
    await runInProcess(stub, (process: Process) => {
      process.store.tools.setPendingHil({ requestId: "request", runId: "run", toolCallId: "call", toolName: "Read", syscall: "fs.read", args: {}, createdAt: 1 });
      process.store.sql.exec("UPDATE pending_hil SET syscall = ?", "invented.execute");
      expect(() => process.store.tools.getPendingHil()).toThrow("unsupported syscall");
      process.store.tools.clearPendingHil();
    });
  });
});
