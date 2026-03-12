/**
 * Process DO — the "smart process" that runs an agent loop.
 *
 * All mutable state (messages, tool calls, metadata) is managed by
 * ProcessStore (SQLite-backed). Communicates with the kernel
 * exclusively via recvFrame RPC in both directions.
 *
 * Agent loop: user message → LLM call → tool dispatch → collect results →
 * LLM call → ... → final text → chat.complete signal.
 * Each "turn" is scheduled via this.schedule() to avoid subrequest limits.
 */

import { Agent as Host } from "agents";
import type {
  Frame,
  RequestFrame,
  ResponseFrame,
  SignalFrame,
} from "../protocol/frames";
import type { ResultOf,
SyscallName } from "../syscalls";
import type { ProcessIdentity } from "../syscalls/system";
import type {
  ProcSendResult,
  ProcHistoryResult,
  ProcHistoryMessage,
  ProcResetResult,
  ProcKillResult,
} from "../syscalls/proc";
import { ProcessStore } from "./store";
import { sendFrameToKernel } from "../shared/utils";

type RunState = {
  runId: string;
  queued: boolean;
};

export class Process extends Host<Env> {
  private readonly store: ProcessStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new ProcessStore(ctx.storage.sql);
    this.store.init();
  }

  private get currentRun(): RunState | null {
    const raw = this.store.getValue("currentRun");
    if (!raw) return null;
    return JSON.parse(raw);
  }

  private set currentRun(state: RunState | null) {
    if (state) this.store.setValue("currentRun", JSON.stringify(state));
    else this.store.deleteValue("currentRun");
  }

  get pid(): string {
    const pid = this.store.getValue("pid");
    if (!pid) throw new Error("Process not initialized — pid missing");
    return pid;
  }

  get identity(): ProcessIdentity {
    const raw = this.store.getValue("identity");
    if (!raw) throw new Error("Process not initialized — identity missing");
    return JSON.parse(raw);
  }

  get initialized(): boolean {
    return this.store.getValue("pid") !== null;
  }

  /**
   * Single entry point — called by the Kernel to deliver frames.
   */
  async recvFrame(frame: Frame) {
    switch (frame.type) {
      case "req":
        return this.handleReq(frame);
      case "res":
        await this.handleRes(frame);
        return null;
      case "sig":
        await this.handleSig(frame);
        return null;
      default:
        return null;
    }
  }

  private async handleRes(frame: ResponseFrame): Promise<void> {
    const pending = this.store.getPending(frame.id);
    if (!pending) {
      console.warn(
        `[Process] Unknown or already resolved tool call: ${frame.id}`,
      );
      return;
    }

    if (frame.ok) {
      this.store.resolve(frame.id, frame.data ?? null);
    } else {
      this.store.fail(frame.id, frame.error.message);
    }

    if (this.store.isRunResolved(pending.runId)) {
      await this.continueAgentLoop(pending.runId);
    }
  }

  /**
   * Handle a request frame from the kernel.
   * proc.send, proc.history, proc.reset, proc.kill are delivered here.
   */
  private async handleReq(frame: RequestFrame): Promise<ResponseFrame | null> {
    try {
      let data: ResultOf<SyscallName>;

      switch (frame.call) {
        case "proc.setidentity": {
          const idArgs = frame.args as unknown as {
            pid: string;
            identity: ProcessIdentity;
          };
          this.store.setValue("pid", idArgs.pid);
          this.store.setValue("identity", JSON.stringify(idArgs.identity));
          data = { ok: true };
          break;
        }
        case "proc.send":
          data = await this.handleProcSend(
            frame.args as { pid?: string; message: string },
          );
          break;
        case "proc.history":
          data = this.handleProcHistory(
            frame.args as { pid?: string; limit?: number; offset?: number },
          );
          break;
        case "proc.reset":
          data = await this.handleProcReset();
          break;
        case "proc.kill":
          data = await this.handleProcKill(
            frame.args as { pid?: string; archive?: boolean },
          );
          break;
        default:
          return {
            type: "res",
            id: frame.id,
            ok: false,
            error: {
              code: 400,
              message: `Unknown process command: ${(frame as { call: string }).call}`,
            },
          };
      }

      return { type: "res", id: frame.id, ok: true, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        type: "res",
        id: frame.id,
        ok: false,
        error: { code: 500, message },
      };
    }
  }

  private async handleProcSend(args: {
    pid?: string;
    message: string;
  }): Promise<ProcSendResult> {
    const runId = crypto.randomUUID();

    this.store.appendMessage("user", args.message);

    const queued = this.currentRun !== null;

    if (queued) {
      this.store.setValue("pendingRunId", runId);
      return { ok: true, status: "started", runId, queued: true };
    }

    this.currentRun = { runId, queued: false };
    this.scheduleTick(runId);

    return { ok: true, status: "started", runId };
  }

  private handleProcHistory(args: {
    pid?: string;
    limit?: number;
    offset?: number;
  }): ProcHistoryResult {
    const pid = this.pid;
    const total = this.store.messageCount();
    const records = this.store.getMessages({
      limit: args.limit,
      offset: args.offset,
    });

    const messages: ProcHistoryMessage[] = records.map((r) => ({
      role: r.role,
      content: r.toolCalls ? JSON.parse(r.toolCalls) : r.content,
      timestamp: r.createdAt,
    }));

    return {
      ok: true,
      pid,
      messages,
      messageCount: total,
      truncated: (args.offset ?? 0) + messages.length < total,
    };
  }

  private async handleProcReset(): Promise<ProcResetResult> {
    const pid = this.pid;
    const count = this.store.messageCount();

    if (count > 0) {
      const archiveId = crypto.randomUUID();
      await this.archiveMessages(pid, archiveId);
      this.store.clearMessages();

      return {
        ok: true,
        pid,
        archivedMessages: count,
        archivedTo: `/var/sessions/${this.identity.username}/${pid}/${archiveId}.jsonl.gz`,
      };
    }

    return { ok: true, pid, archivedMessages: 0 };
  }

  private async handleProcKill(args: {
    pid?: string;
    archive?: boolean;
  }): Promise<ProcKillResult> {
    const pid = this.pid;

    if (args.archive !== false) {
      const archiveId = crypto.randomUUID();
      const archivedTo = await this.archiveMessages(pid, archiveId);
      return {
        ok: true,
        pid,
        archivedTo: archivedTo ?? undefined,
      };
    }

    return { ok: true, pid };
  }

  private async handleSig(frame: SignalFrame): Promise<void> {
    switch (frame.signal) {
      case "identity.changed": {
        const identity = (frame.payload as { identity: ProcessIdentity })
          ?.identity;
        if (identity) {
          this.store.setValue("identity", JSON.stringify(identity));
        }
        break;
      }
      default:
        console.log(`[Process] Unknown signal: ${frame.signal}`);
        break;
    }
  }

  /**
   * Schedule the next agent loop tick using the DO scheduler.
   * Each tick resets the subrequest counter.
   */
  private scheduleTick(runId: string): void {
    const next = new Date(Date.now() + 10); // 10ms from now
    this.schedule(next, "tick", runId);
  }

  async tick(runId: string): Promise<void> {
    await this.continueAgentLoop(runId);
  }

  private async continueAgentLoop(runId: string): Promise<void> {
    // Stub — Phase 4 will port the full LLM call + tool dispatch cycle.
    console.log(`[Process] Agent loop tick for run ${runId} (stub)`);

    const pendingRunId = this.store.getValue("pendingRunId");
    if (pendingRunId) {
      this.store.deleteValue("pendingRunId");
      this.currentRun = { runId: pendingRunId, queued: false };
      this.scheduleTick(pendingRunId);
    } else {
      this.currentRun = null;
    }
  }

  private async archiveMessages(
    pid: string,
    archiveId: string,
  ): Promise<string | null> {
    const messages = this.store.allMessagesForArchive();
    if (messages.length === 0) return null;

    const jsonl = messages
      .map((m) =>
        JSON.stringify({
          role: m.role,
          content: m.content,
          tool_calls: m.toolCalls ? JSON.parse(m.toolCalls) : undefined,
          tool_call_id: m.toolCallId ?? undefined,
          ts: m.createdAt,
        }),
      )
      .join("\n");

    const key = `var/sessions/${this.identity.username}/${pid}/${archiveId}.jsonl.gz`;

    const compressed = await gzip(jsonl);
    const bucket = this.env.STORAGE;
    await bucket.put(key, compressed, {
      httpMetadata: { contentType: "application/gzip" },
    });
    return key;
  }

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

    const response = await sendFrameToKernel(this.pid, reqFrame);

    if (response && response.type === "res") {
      const res = response;
      if (res.ok) {
        this.store.resolve(id, (res as { data?: unknown }).data);
      } else {
        this.store.fail(
          id,
          (res as { error: { message: string } }).error.message,
        );
      }
    }
  }
}

async function gzip(input: string): Promise<ArrayBuffer> {
  const stream = new Blob([input])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}
