import { afterEach, describe, expect, it, vi } from "vitest";
import { evictDurableObject } from "cloudflare:test";
import type { ProcHilResult } from "@humansandmachines/gsv/protocol";
import type { Process } from "./do";
import type { ToolApprovalPolicy } from "./approval";
import { approvedRun, initProcess, offeredTools, ROOT_IDENTITY, runInProcess, terminalTestConfig } from "./do-test-harness";
import * as sharedUtils from "../shared/utils";

const RUN = "run";
const DISPATCH = "dispatch-mail";
const MINUTE = 60_000;
const MAIL = { to: "person@example.invalid", subject: "Hello", text: "Hi" };
const ASKS: ToolApprovalPolicy = { default: "ask", rules: [] };

/** A run whose Shell or CodeMode call is already executing, which is where nested approvals are raised. */
function startedTool(process: Process, tool: "Shell" | "CodeMode") {
  const syscall = tool === "Shell" ? "shell.exec" : "codemode.exec";
  // SAFETY: the run fixture holds only the fields these approval paths read.
  process.runs.active = approvedRun(RUN, {
    config: { ...terminalTestConfig(process.pid), capabilities: ["*"] }, tools: offeredTools(tool), offeredToolNames: [tool], approvalPolicy: ASKS,
  }) as Process["runs"]["active"];
  process.store.tools.register(DISPATCH, "call-mail", RUN, syscall, {});
  process.store.tools.markDispatched(DISPATCH);
  vi.spyOn(process.kernel, "readApprovalPolicy").mockResolvedValue(JSON.stringify(ASKS));
  vi.spyOn(process, "sendSignal").mockResolvedValue(undefined);
  // SAFETY: these tests never read the schedule record.
  vi.spyOn(process.run, "schedule").mockResolvedValue(undefined as never);
}

async function tap(process: Process, decision: "approve" | "deny" = "approve"): Promise<ProcHilResult> {
  const pending = process.store.tools.getPendingHil();
  return await process.controller.handleProcHil({ requestId: pending?.requestId ?? "gone", decision });
}

async function settled<T>(promise: Promise<T>) {
  return await promise.then(
    (value) => ({ value }),
    (error: Error) => ({ error: error.message }),
  );
}

const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("nested approval window", () => {
  it("still dispatches a Shell approval tapped eight minutes later", async () => {
    const stub = await initProcess("nested-window-shell", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      startedTool(process, "Shell");
      fakeClock();
      const authorized = process.tools.authorizeNestedTool(
        { runId: RUN, requestId: DISPATCH, syscall: "mail.send", args: MAIL }, new AbortController().signal,
      );
      await vi.advanceTimersByTimeAsync(8 * MINUTE);
      expect(process.store.tools.getPendingHil()).toMatchObject({ syscall: "mail.send" });
      await expect(tap(process)).resolves.toMatchObject({ ok: true });
      await expect(authorized).resolves.toBe(true);
      process.runs.active = null;
    });
  });

  it("still dispatches a CodeMode approval tapped eight minutes later", async () => {
    const stub = await initProcess("nested-window-codemode", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      startedTool(process, "CodeMode");
      // SAFETY: only ok and data of this fixture frame are read.
      const dispatched = vi.spyOn(process.tools, "dispatchCodeModeSyscall")
        .mockResolvedValue({ type: "res", id: "fetch", ok: true, data: { status: 200 } } as never);
      fakeClock();
      const running = settled(process.tools.executeCodeModeSyscall(
        { runId: RUN, dispatchId: DISPATCH, approvalPolicy: ASKS, capabilities: ["*"] },
        "net.fetch", { url: "https://example.invalid", method: "POST", headers: {} },
      ));
      await vi.advanceTimersByTimeAsync(8 * MINUTE);
      await expect(tap(process)).resolves.toMatchObject({ ok: true });
      await running;
      expect(dispatched).toHaveBeenCalledOnce();
      process.runs.active = null;
    });
  });

  it("keeps a Kernel-authorized CodeMode syscall alive while a person is asked", async () => {
    const stub = await initProcess("nested-window-kernel-authorized", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      startedTool(process, "CodeMode");
      let answer!: (frame: never) => void;
      // SAFETY: only ok and data of this fixture frame are read.
      vi.spyOn(sharedUtils, "sendFrameToKernel").mockReturnValue(new Promise((resolve) => {
        // SAFETY: only ok and data of this fixture frame are read.
        answer = resolve as never;
      }));
      const cancel = vi.spyOn(sharedUtils, "cancelProcessRequests").mockResolvedValue(0);
      fakeClock();
      const syscall = process.tools.dispatchCodeModeSyscall(RUN, "nested-mail", "mail.send", MAIL, undefined, DISPATCH);
      const authorized = process.tools.authorizeNestedTool(
        { runId: RUN, requestId: "nested-mail", syscall: "mail.send", args: MAIL }, new AbortController().signal,
      );
      await vi.advanceTimersByTimeAsync(8 * MINUTE);
      expect(cancel).not.toHaveBeenCalled();
      await expect(tap(process)).resolves.toMatchObject({ ok: true });
      await expect(authorized).resolves.toBe(true);
      // SAFETY: only ok and data of this fixture frame are read.
      answer({ type: "res", id: "nested-mail", ok: true, data: {} } as never);
      await expect(syscall).resolves.toMatchObject({ ok: true });
      process.runs.active = null;
    });
  });

  it("expires before the tool deadline with its own error, not a refusal", async () => {
    const stub = await initProcess("nested-window-expiry", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      startedTool(process, "Shell");
      fakeClock();
      const authorized = settled(process.tools.authorizeNestedTool(
        { runId: RUN, requestId: DISPATCH, syscall: "mail.send", args: MAIL }, new AbortController().signal,
      ));
      await vi.advanceTimersByTimeAsync(9.5 * MINUTE);
      await expect(authorized).resolves.toEqual({
        error: "Approval request timed out before anyone answered: mail.send",
      });
      expect(process.store.tools.getPendingHil()).toBeNull();
      await expect(tap(process)).resolves.toMatchObject({ ok: false });
      process.runs.active = null;
    });
  });

  it("keeps a person's denial as a refusal", async () => {
    const stub = await initProcess("nested-window-denial", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      startedTool(process, "Shell");
      const authorized = process.tools.authorizeNestedTool(
        { runId: RUN, requestId: DISPATCH, syscall: "mail.send", args: MAIL }, new AbortController().signal,
      );
      await vi.waitFor(() => expect(process.store.tools.getPendingHil()).not.toBeNull());
      await tap(process, "deny");
      await expect(authorized).resolves.toBe(false);
      process.runs.active = null;
    });
  });

  it("reports an approval whose waiter was lost to a restart as interrupted", async () => {
    const stub = await initProcess("nested-window-eviction", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      startedTool(process, "Shell");
      process.store.tools.setPendingHil({
        requestId: "lost", runId: RUN, ownerDispatchId: DISPATCH, toolCallId: "nested", toolName: "Shell",
        syscall: "mail.send", args: MAIL, createdAt: Date.now(),
      });
    });
    await evictDurableObject(stub);
    await runInProcess(stub, async (process: Process) => {
      expect(process.codeModeApprovals.size).toBe(0);
      expect(process.store.tools.getPendingHil()).toMatchObject({ syscall: "mail.send" });
      // SAFETY: the run fixture holds only the fields these approval paths read.
      process.runs.active ??= approvedRun(RUN, {
        config: { ...terminalTestConfig(process.pid), capabilities: ["*"] }, tools: offeredTools("Shell"), offeredToolNames: ["Shell"], approvalPolicy: ASKS,
      }) as Process["runs"]["active"];
      vi.spyOn(process, "sendSignal").mockResolvedValue(undefined);
      // SAFETY: these tests never read the schedule record.
      vi.spyOn(process.run, "schedule").mockResolvedValue(undefined as never);
      await expect(tap(process)).resolves.toEqual({
        ok: false, error: "Tool execution was interrupted while waiting for approval",
      });
      expect(process.store.tools.getPendingHil()).toBeNull();
      process.runs.active = null;
    });
  });
});
