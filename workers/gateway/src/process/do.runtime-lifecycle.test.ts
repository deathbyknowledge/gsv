import { MANAGED_LIFECYCLE_RECHECK_MS } from "../installation/lifecycle";
import { processDurableObjectName } from "../installation/routing";
import { Kernel } from "../kernel/do";
import type { ResponseFrame } from "../protocol/frames";
import { getKernelPtr } from "../shared/utils";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  deferred, runInProcess, ROOT_IDENTITY, initProcess, makeReq, registerInKernel,
} from "./do-test-harness";

// ---------------------------------------------------------------------------
// Tier 1: Mechanical tests (no LLM)
// ---------------------------------------------------------------------------

describe("Process DO — mechanical", () => {
  it("derives inference attribution from its named installation", async () => {
    const installationId = "inst_managed_process";
    const pid = "mech-managed-inference";
    const name = processDurableObjectName(installationId, pid);
    const stub = env.PROCESS.get(env.PROCESS.idFromName(name));
    const identityResponse = await stub.recvFrame(
      makeReq("proc.setidentity", {
        identity: ROOT_IDENTITY,
      }),
    );
    // SAFETY: test fixture is constructed with the asserted domain shape.
    expect((identityResponse as ResponseFrame).ok).toBe(true);

    const result = await runInProcess(stub, async (process) => {
      const first = await process.run.buildInferenceAttribution(
        { provider: "gsv", model: "default" },
        "run",
        "run-managed",
      );
      const repeated = await process.run.buildInferenceAttribution(
        { provider: "gsv", model: "default" },
        "run",
        "run-managed",
      );
      process.store.messages.appendMessage("user", "next model turn");
      const next = await process.run.buildInferenceAttribution(
        { provider: "gsv", model: "default" },
        "run",
        "run-managed",
      );
      return { first, repeated, next };
    });

    expect(result.first).toMatchObject({
      installationId,
      actor: { localUid: 0, processId: pid, runId: "run-managed" },
      workload: "background",
    });
    expect(result.first.logicalRequestId).toMatch(/^inference:[a-f0-9]{64}$/);
    expect(result.repeated.logicalRequestId).toBe(result.first.logicalRequestId);
    expect(result.next.logicalRequestId).not.toBe(result.first.logicalRequestId);
  });

  it("pauses a managed run without advancing it while the installation is suspended", async () => {
    const runId = "run-managed-suspended";
    const name = processDurableObjectName("inst_managed_suspended", "mech-managed-suspended");
    const stub = env.PROCESS.get(env.PROCESS.idFromName(name));

    await runInProcess(stub, async (process) => {
      const scheduleTick = vi.fn(async () => {});
      const runTick = vi.fn(async () => {});
      process.run.managedWorkGate = async () => ({
        allowed: false,
        code: 423,
        message: "Managed installation is suspended",
      });
      process.run.scheduleTick = scheduleTick;
      process.run.runTick = runTick;
      process.store.state.setValue("currentRun", JSON.stringify({ runId }));

      await process.run.tick({ runId, generation: 0 });

      expect(JSON.parse(process.store.state.getValue("currentRun") ?? "null")).toEqual({ runId });
      expect(runTick).not.toHaveBeenCalled();
      expect(scheduleTick).toHaveBeenCalledWith(runId, MANAGED_LIFECYCLE_RECHECK_MS, false);
    });
  });

  it("retains a successor tick after a scheduled tick pauses for managed lifecycle", async () => {
    const runId = "run-managed-scheduled-suspended";
    const name = processDurableObjectName(
      "inst_managed_scheduled_suspended",
      "mech-managed-scheduled-suspended",
    );
    const stub = env.PROCESS.get(env.PROCESS.idFromName(name));

    await runInProcess(stub, async (process, state) => {
      process.run.managedWorkGate = async () => ({
        allowed: false,
        code: 423,
        message: "Managed installation is suspended",
      });
      process.store.state.setValue("currentRun", JSON.stringify({ runId }));
      const executing = await process.run.schedule(
        new Date(Date.now() - 1_000),
        "tick",
        { runId, generation: 0 },
        { idempotent: true },
      );

      await process.tasks.alarm();

      const successors = state.storage.sql
        .exec<{
          id: string;
          callback: string;
          payload: string;
        }>(
          `SELECT id, callback, payload
         FROM cf_agents_schedules
         WHERE callback = 'tick'`,
        )
        .toArray();
      expect(successors).toHaveLength(1);
      expect(successors[0]).toMatchObject({
        callback: "tick",
        payload: JSON.stringify({ runId, generation: 0 }),
      });
      expect(successors[0]?.id).not.toBe(executing.id);
    });
  });

  it("stops a managed gate continuation after the process is killed", async () => {
    const pid = "mech-managed-gate-kill";
    const stub = env.PROCESS.get(
      env.PROCESS.idFromName(processDurableObjectName("inst_managed_gate_kill", pid)),
    );
    await stub.recvFrame(
      makeReq("proc.setidentity", {
        identity: ROOT_IDENTITY,
      }),
    );

    await runInProcess(stub, async (process) => {
      const { promise: gateBlocked, resolve: releaseGate } = deferred();
      const { promise: gateStarted, resolve: markGateStarted } = deferred();
      process.runs.active = { runId: "run-managed-gate-kill" };
      process.run.managedWorkGate = vi.fn(async () => {
        markGateStarted();
        await gateBlocked;
        return { allowed: true };
      });
      process.run.scheduleTick = vi.fn(async () => {});

      const pausing = process.run.pauseManagedRun("run-managed-gate-kill");
      await gateStarted;
      await expect(
        process.recvFrame(makeReq("proc.kill", { archive: false })),
      ).resolves.toMatchObject({ ok: true, data: { ok: true, pid } });
      releaseGate();
      await expect(pausing).resolves.toBe(true);
      expect(process.run.scheduleTick).not.toHaveBeenCalled();
    });
  });

  it("records terminal adapter delivery outcomes in process history", async () => {
    const pid = "mech-delivery-notice";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    // SAFETY: test fixture is constructed with the asserted domain shape.

    const notice = {
      type: "sig",
      signal: "proc.delivery.notice",
      payload: {
        noticeId: "notice:mech-delivery-notice",
        runId: "run-delivery-notice",
        deliveryKind: "final",
        state: "ambiguous",
        message: "The message reached the adapter, but provider delivery is ambiguous.",
      },
      // SAFETY: test fixture is constructed with the asserted domain shape.
    } as const;
    await stub.recvFrame(notice);
    await stub.recvFrame(notice);

    await runInProcess(stub, (process) => {
      expect(process.store.messages.getMessages()).toEqual([
        expect.objectContaining({
          role: "system",
          runId: "run-delivery-notice",
          content: expect.stringContaining("delivery is ambiguous"),
        }),
      ]);
    });
  });

  it("bounds terminal adapter delivery notice tombstones", async () => {
    const stub = await initProcess("mech-delivery-notice-bounds", ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      for (let index = 0; index <= 256; index += 1) {
        await process.controller.handleSig({
          type: "sig",
          signal: "proc.delivery.notice",
          payload: {
            noticeId: `notice:bounded:${index}`,
            runId: `run-${index}`,
            message: `Delivery notice ${index}`,
          },
        });
      }
      expect(process.store.state.getValue("deliveryNotice:notice:bounded:0")).toBeNull();
      expect(process.store.state.getValue("deliveryNotice:notice:bounded:256")).not.toBeNull();
      expect(JSON.parse(process.store.state.getValue("deliveryNoticeIds"))).toHaveLength(256);
    });
  }, 15_000);

  it("projects proc.run signals into kernel process activity", async () => {
    const pid = "mech-kernel-process-activity";
    await registerInKernel(pid, ROOT_IDENTITY);
    const kernel = await getKernelPtr();

    // SAFETY: test fixture is constructed with the asserted domain shape.

    const state = await runInDurableObject(kernel, async (instance: Kernel) => {
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const k = instance as any;
      const project = (frame: any) =>
        k.updateProcessRuntimeFromSignal(pid, frame, frame.payload?.runId ?? null);
      await project({
        type: "sig",
        signal: "proc.run.started",
        payload: {
          pid,
          runId: "run-activity",
          queuedCount: 1,
          timestamp: 1000,
        },
      });
      const running = k.procs.get(pid);

      await project({
        type: "sig",
        signal: "proc.run.retrying",
        payload: {
          pid,
          runId: "run-activity",
          queuedCount: 1,
          timestamp: 1050,
        },
      });
      const retrying = k.procs.get(pid);

      await project({
        type: "sig",
        signal: "proc.run.tool.started",
        payload: {
          pid,
          runId: "run-activity",
          queuedCount: 1,
          timestamp: 1075,
        },
      });
      const waitingTool = k.procs.get(pid);

      await project({
        type: "sig",
        signal: "proc.run.tool.finished",
        payload: {
          pid,
          runId: "run-activity",
          executionId: "execution-1",
          callId: "call-1",
          outcome: "completed",
          timestamp: 1076,
        },
      });
      const stillWaitingTool = k.procs.get(pid);

      await project({
        type: "sig",
        signal: "proc.changed",
        payload: {
          pid,
          runId: "run-activity",
          changes: ["messages"],
          queuedCount: 1,
          timestamp: 1080,
        },
      });
      const resumed = k.procs.get(pid);

      await project({
        type: "sig",
        signal: "proc.run.hil.requested",
        payload: {
          pid,
          runId: "run-activity",
          queuedCount: 1,
          timestamp: 1100,
        },
      });
      const waiting = k.procs.get(pid);

      await project({
        type: "sig",
        signal: "proc.run.finished",
        payload: {
          pid,
          runId: "run-activity",
          queuedCount: 0,
          timestamp: 1200,
        },
      });
      const idle = k.procs.get(pid);

      return { running, retrying, waitingTool, stillWaitingTool, resumed, waiting, idle };
    });

    expect(state.running).toMatchObject({
      state: "running",
      activeRunId: "run-activity",
      queuedCount: 1,
      lastActiveAt: 1000,
    });
    expect(state.retrying).toMatchObject({
      state: "running",
      activeRunId: "run-activity",
      queuedCount: 1,
      lastActiveAt: 1050,
    });
    expect(state.waitingTool).toMatchObject({
      state: "waiting_tool",
      activeRunId: "run-activity",
      lastActiveAt: 1075,
    });
    expect(state.stillWaitingTool).toMatchObject({
      state: "waiting_tool",
      activeRunId: "run-activity",
      lastActiveAt: 1075,
    });
    expect(state.resumed).toMatchObject({
      state: "running",
      activeRunId: "run-activity",
      lastActiveAt: 1080,
    });
    expect(state.waiting).toMatchObject({
      state: "waiting_hil",
      activeRunId: "run-activity",
      queuedCount: 1,
      lastActiveAt: 1100,
    });
    expect(state.idle).toMatchObject({
      state: "idle",
      activeRunId: null,
      queuedCount: 0,
      lastActiveAt: 1200,
    });
  });
});
