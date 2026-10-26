import { describe, expect, it, vi } from "vitest";
import { evictDurableObject } from "cloudflare:test";
import type { Process } from "./do";
import { DEFAULT_TOOL_APPROVAL_POLICY } from "./approval";
import { approvedRun, initProcess, offeredTools, ROOT_IDENTITY, runInProcess, terminalTestConfig } from "./do-test-harness";
import type { ProcessApprovalTarget } from "../protocol/process-frames";
import { ProcessStore } from "./store";
import { runSqlMigrations } from "../schema/runner";
import { PROCESS_MIGRATIONS, PROCESS_SCHEMA_COMPONENT } from "./schema/migrations";

const target: ProcessApprovalTarget = {
  targetId: "browser", ownerUid: 1000, platform: "browser", route: { kind: "instance", instanceId: "original" },
};

describe("approval target persistence", () => {
  it("upgrades v16 approvals without losing them and persists new target identities", async () => {
    const stub = await initProcess("approval-v16-upgrade", ROOT_IDENTITY);
    await runInProcess(stub, async (_process: Process, state: DurableObjectState) => {
      await state.storage.deleteAll();
      runSqlMigrations(state.storage, PROCESS_SCHEMA_COMPONENT, PROCESS_MIGRATIONS.filter(({ id }) => id <= 16));
      state.storage.sql.exec(`INSERT INTO pending_hil (request_id, run_id, tool_call_id, tool_name, syscall, args_json, created_at)
        VALUES ('old', 'run', 'call', 'Shell', 'shell.exec', '{"target":"browser","input":"page snapshot"}', 1)`);
      runSqlMigrations(state.storage, PROCESS_SCHEMA_COMPONENT, PROCESS_MIGRATIONS);
      runSqlMigrations(state.storage, PROCESS_SCHEMA_COMPONENT, PROCESS_MIGRATIONS);
      const store = new ProcessStore(state.storage.sql);
      const pending = store.tools.getPendingHil()!;
      expect(pending).toMatchObject({ requestId: "old", args: { target: "browser", input: "page snapshot" } });
      expect(pending.approvedTarget).toBeUndefined();
      store.tools.setPendingHil({ ...pending, approvedTarget: target });
      expect(store.tools.getPendingHil()?.approvedTarget).toEqual(target);
    });
  });

  it("carries the originally checked target through human approval after eviction", async () => {
    const stub = await initProcess("approval-target-restored", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      process.runs.active = approvedRun("run", {
        config: terminalTestConfig(process.pid), tools: offeredTools("Shell"), offeredToolNames: ["Shell"],
        approvalPolicy: { default: "auto", rules: [
          { match: "shell.exec", target: { route: "instance", platform: "browser" }, action: "ask" },
        ] },
      });
      vi.spyOn(process.kernel, "resolveApprovalTarget").mockResolvedValue(target);
      vi.spyOn(process.kernel, "readApprovalPolicy").mockResolvedValue(JSON.stringify(process.runs.active.approvalPolicy));
      vi.spyOn(process, "sendSignal").mockResolvedValue(undefined);
      process.store.tools.register("shell", "call", "run", "shell.exec", { target: "browser", input: "page snapshot" });
      expect(await process.tools.processToolCalls("run")).toMatchObject({ approvedTarget: target });
    });
    await evictDurableObject(stub);
    await runInProcess(stub, async (process: Process) => {
      const pending = process.store.tools.getPendingHil()!;
      expect(pending.approvedTarget).toEqual(target);
      vi.spyOn(process.run, "schedule").mockResolvedValue(undefined);
      vi.spyOn(process, "sendSignal").mockResolvedValue(undefined);
      const launch = vi.spyOn(process.tools, "launchToolDispatch").mockImplementation(() => {});
      expect(await process.controller.handleProcHil({ requestId: pending.requestId, decision: "approve" })).toMatchObject({ ok: true });
      expect(launch).toHaveBeenCalledWith("run", "shell", "shell.exec", pending.args, process.runs.active?.approvalPolicy, undefined, target);
      process.runs.active = null;
    });
  });
});

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

  it("makes a run from before owner policies read the owner's policy before deciding", async () => {
    const stub = await initProcess("approval-policy-upgrade", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process, state: DurableObjectState) => {
      await state.storage.deleteAll();
      runSqlMigrations(state.storage, PROCESS_SCHEMA_COMPONENT, PROCESS_MIGRATIONS.filter(({ id }) => id <= 17));
      const codeAsks = ["sched.add", "sched.update", "approach.create"];
      const before = { default: "auto" as const, rules: DEFAULT_TOOL_APPROVAL_POLICY.rules.filter(({ match }) => !codeAsks.includes(match)) };
      new ProcessStore(state.storage.sql).state.setValue("currentRun", JSON.stringify(approvedRun("run", {
        config: { ...terminalTestConfig(process.pid), capabilities: ["*"] },
        approvalPolicy: before, tools: offeredTools("Shell"), offeredToolNames: ["Shell"],
      })));
      runSqlMigrations(state.storage, PROCESS_SCHEMA_COMPONENT, PROCESS_MIGRATIONS);
      runSqlMigrations(state.storage, PROCESS_SCHEMA_COMPONENT, PROCESS_MIGRATIONS);

      expect(process.runs.active?.runId).toBe("run");
      process.store.tools.register("shell", "call", "run", "shell.exec", { input: "sched add" });
      process.store.tools.markDispatched("shell");
      vi.spyOn(process, "sendSignal").mockResolvedValue(undefined);
      vi.spyOn(process.run, "scheduleTick").mockResolvedValue(undefined);
      const read = vi.spyOn(process.kernel, "readApprovalPolicy").mockResolvedValue(JSON.stringify(DEFAULT_TOOL_APPROVAL_POLICY));
      const waiting = process.tools.authorizeNestedTool({ runId: "run", requestId: "shell", syscall: "sched.add", args: {} }, new AbortController().signal);
      const pending = await vi.waitFor(() => {
        const hil = process.store.tools.getPendingHil();
        if (!hil) throw new Error("No approval is pending yet");
        return hil;
      });
      expect(read).toHaveBeenCalledOnce();
      expect(pending.syscall).toBe("sched.add");
      process.tools.resolveCodeModeApproval(pending.requestId, false);
      expect(await waiting).toBe(false);
      process.runs.active = null;
    });
  });
});
