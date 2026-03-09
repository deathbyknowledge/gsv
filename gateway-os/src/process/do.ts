/**
 * Process DO — the "smart process" that runs an agent loop.
 *
 * Extends the agents SDK Agent base class. All mutable state is managed
 * by ProcessStore (SQLite-backed). Communicates with the kernel
 * exclusively via recvFrame in both directions.
 *
 * For now this is a skeleton. The full agent loop (LLM calls, message
 * history, compaction) will be ported from the old Session DO later.
 */

import { Agent as Host } from "agents";
import type { Frame, RequestFrame, ResponseFrame, SignalFrame } from "../protocol/frames";
import type { SyscallName } from "../syscalls";
import { ProcessStore } from "./store";

export class Process extends Host<Env> {
  private readonly store: ProcessStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new ProcessStore(ctx.storage.sql);
    this.store.init();
  }

  /**
   * RPC method — called by the Kernel to deliver frames.
   *
   * Returns a Frame if the process has a synchronous response
   * (e.g., responding to a kernel-initiated req), or null.
   */
  async recvFrame(frame: Frame): Promise<Frame | null> {
    switch (frame.type) {
      case "res":
        return this.handleRes(frame as ResponseFrame);
      case "req":
        return this.handleReq(frame as RequestFrame);
      case "sig":
        return this.handleSig(frame as SignalFrame);
      default:
        return null;
    }
  }

  /**
   * Handle a response frame from the kernel — a deferred syscall
   * result that was forwarded to a device.
   */
  private async handleRes(frame: ResponseFrame): Promise<Frame | null> {
    const pending = this.store.getPending(frame.id);
    if (!pending) {
      console.warn(`[Process] Unknown or already resolved tool call: ${frame.id}`);
      return null;
    }

    if (frame.ok) {
      this.store.resolve(frame.id, frame.data ?? null);
    } else {
      this.store.fail(frame.id, frame.error.message);
    }

    if (this.store.isRunResolved(pending.runId)) {
      await this.continueAgentLoop(pending.runId);
    }

    return null;
  }

  /**
   * Handle a request frame from the kernel (kernel-initiated commands).
   * Stubs for now — will implement inject message, pause, kill.
   */
  private async handleReq(frame: RequestFrame): Promise<Frame | null> {
    return {
      type: "res",
      id: frame.id,
      ok: false,
      error: { code: 501, message: "Process commands not yet implemented" },
    };
  }

  /**
   * Handle a signal from the kernel. Stubs for now.
   */
  private async handleSig(_frame: SignalFrame): Promise<Frame | null> {
    return null;
  }

  /**
   * Stub — will be replaced with the full agent loop port from Session DO.
   */
  private async continueAgentLoop(_runId: string): Promise<void> {
    console.log(`[Process] All tool calls resolved for run ${_runId}, continuing agent loop (stub)`);
  }

  /**
   * Dispatches a syscall to the kernel and handles the receipt.
   * Called by the agent loop when the LLM requests a tool call.
   */
  async dispatchSyscall(
    runId: string,
    id: string,
    call: SyscallName,
    args: unknown,
  ): Promise<void> {
    this.store.register(id, runId, call, args);

    const reqFrame: RequestFrame = {
      type: "req",
      id,
      call,
      args,
    } as RequestFrame;

    const kernel = this.env.KERNEL.get(
      this.env.KERNEL.idFromName("singleton"),
    );

    const processId = this.store.getMeta("processId") ?? this.ctx.id.toString();

    const response = await (kernel as unknown as { recvFrame(processId: string, frame: Frame): Promise<Frame | null> })
      .recvFrame(processId, reqFrame);

    if (response && response.type === "res") {
      const res = response as ResponseFrame;
      if (res.ok) {
        this.store.resolve(id, (res as { data?: unknown }).data);
      } else {
        this.store.fail(id, (res as { error: { message: string } }).error.message);
      }
    }
  }
}
