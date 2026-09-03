import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { SignalFrame } from "../protocol/frames";
import type { ProcessMessageStreamSignal } from "../protocol/process-frames";
import { encodeProcessRunStreamFrame } from "../protocol/process-run-stream";
import { attachProcessRunStream, sendFrameToKernel } from "../shared/utils";
import type { Process } from "./do";

export type ProcessRunEventSink = {
  emit(seq: number, event: AssistantMessageEvent): Promise<void>;
  close(): Promise<void>;
};

export type MessageStreamProjection = {
  id: string;
  started: boolean;
  text: string;
  aborted: boolean;
};

/** Owns observational model and committed-message streams. */
export class ProcessMessageStreamService {
  private readonly projections = new Map<string, MessageStreamProjection>();

  constructor(private readonly host: Process) {}

  async openRunEventSink(runId: string): Promise<ProcessRunEventSink | null> {
    if (this.host.killed || !this.host.settings.interactive) return null;

    const transport = new IdentityTransformStream({ highWaterMark: 65_536 });
    const writer = transport.writable.getWriter();
    try {
      const attached = await attachProcessRunStream(
        this.host.installationId,
        this.host.pid,
        transport.readable,
      );
      if (!attached) {
        await writer.abort("Process run stream was rejected").catch(() => {});
        writer.releaseLock();
        return null;
      }
    } catch {
      await writer.abort("Process run stream could not be attached").catch(() => {});
      writer.releaseLock();
      return null;
    }

    let active = true;
    const finish = async (close: boolean): Promise<void> => {
      if (!active) return;
      active = false;
      try {
        if (close) {
          await writer.close();
        } else {
          await writer.abort("Process run stream delivery failed");
        }
      } catch {
        // Live output is observational; history remains authoritative.
      } finally {
        writer.releaseLock();
      }
    };

    return {
      emit: async (seq, event) => {
        if (!active) return;
        try {
          const frame = {
            type: "sig",
            signal: "proc.run.stream",
            payload: {
              pid: this.host.pid,
              runId,
              seq,
              event: structuredClone(event),
              timestamp: Date.now(),
            },
          } satisfies SignalFrame;
          await writer.write(encodeProcessRunStreamFrame(frame));
        } catch {
          await finish(false);
        }
      },
      close: () => finish(true),
    };
  }

  async complete(runId: string, actionId: string, text: string): Promise<void> {
    const projection = this.projection(runId, actionId);
    if (projection.aborted) return;
    if (!projection.started) {
      projection.started = true;
      await this.emitProjection(runId, projection, "started");
    }
    if (text === projection.text) return;
    if (!text.startsWith(projection.text)) {
      await this.abort(runId, projection, "Committed message differs from its stream");
      return;
    }
    const delta = text.slice(projection.text.length);
    projection.text = text;
    if (delta) await this.emitProjection(runId, projection, "delta", delta);
  }

  async silence(runId: string, actionId: string): Promise<void> {
    await this.emitProjection(runId, this.projection(runId, actionId), "silenced");
  }

  async abortAction(runId: string, actionId: string, reason: string): Promise<void> {
    const projection = this.projections.get(`${runId}:${actionId}`);
    if (projection) await this.abort(runId, projection, reason);
  }

  deleteAction(runId: string, actionId: string): void {
    this.projections.delete(`${runId}:${actionId}`);
  }

  async abortRun(runId: string, reason: string): Promise<void> {
    const prefix = `${runId}:`;
    for (const [key, projection] of this.projections) {
      if (key.startsWith(prefix)) await this.abort(runId, projection, reason);
    }
  }

  deleteRun(runId: string): void {
    const prefix = `${runId}:`;
    for (const key of this.projections.keys()) {
      if (key.startsWith(prefix)) this.projections.delete(key);
    }
  }

  private projection(runId: string, actionId: string): MessageStreamProjection {
    const key = `${runId}:${actionId}`;
    let projection = this.projections.get(key);
    if (!projection) {
      projection = {
        id: `draft:${runId}:${actionId}`,
        started: false,
        text: "",
        aborted: false,
      };
      this.projections.set(key, projection);
    }
    return projection;
  }

  private async abort(
    runId: string,
    projection: MessageStreamProjection,
    reason: string,
  ): Promise<void> {
    if (!projection.started || projection.aborted) return;
    projection.aborted = true;
    await this.emitProjection(runId, projection, "aborted", undefined, reason);
  }

  async emitProjection(
    runId: string,
    projection: MessageStreamProjection,
    phase: "started" | "delta" | "aborted" | "silenced",
    delta?: string,
    reason?: string,
  ): Promise<void> {
    const run = this.host.runs.active;
    if (!run || run.runId !== runId || this.host.killed || run.returnToCaller) return;
    const payload: NonNullable<ProcessMessageStreamSignal["payload"]> = {
      pid: this.host.pid,
      runId,
      messageId: projection.id,
      phase,
      timestamp: Date.now(),
    };
    if (run.conversationId) payload.conversationId = run.conversationId;
    if (delta !== undefined) payload.delta = delta;
    if (reason !== undefined) payload.reason = reason;
    const frame: ProcessMessageStreamSignal = {
      type: "sig",
      signal: "proc.message.stream",
      payload,
    };
    try {
      await sendFrameToKernel(this.host.installationId, this.host.pid, frame);
    } catch {
      projection.aborted = true;
    }
  }
}
