import type {
  JsonObject, ProcRunToolFinishedSignal, ProcRunToolStartedSignal, ProcToolResultOutcome,
} from "@humansandmachines/gsv/protocol";
import type { Process } from "./do";

/** Owns observational Process signals. Durable delivery lives elsewhere. */
export class ProcessSignalService {
  constructor(private readonly host: Process) {}

  async changed(changes: string[], payload: JsonObject = {}): Promise<void> {
    if (this.host.killed) return;
    try {
      await this.host.sendSignal("proc.changed", {
        pid: this.host.pid,
        changes,
        queuedCount: this.host.store.queue.queueSize(),
        timestamp: Date.now(),
        ...payload,
      });
    } catch (error) {
      console.warn(`[Process] Failed to emit state change for ${this.host.pid}:`, error);
    }
  }

  async announceRun(runId: string, reason: string): Promise<void> {
    if (this.host.killed || this.host.runs.active?.runId !== runId) return;
    try {
      await this.host.sendSignal("proc.run.started", {
        pid: this.host.pid,
        runId,
        reason,
        queuedCount: this.host.store.queue.queueSize(),
        timestamp: Date.now(),
      });
    } catch (error) {
      console.warn(`[Process] Failed to emit start for ${runId}:`, error);
    }
  }

  async toolStarted(payload: ProcRunToolStartedSignal): Promise<void> {
    if (this.host.killed) return;
    try {
      await this.host.sendSignal("proc.run.tool.started", payload);
    } catch (error) {
      console.warn(`[Process] Failed to emit tool start for ${this.host.pid}:`, error);
    }
  }

  async toolFinished(
    runId: string,
    executionId: string,
    callId: string,
    outcome: ProcToolResultOutcome,
  ): Promise<void> {
    const payload: ProcRunToolFinishedSignal = {
      pid: this.host.pid,
      runId,
      executionId,
      callId,
      outcome,
      timestamp: Date.now(),
    };
    try {
      await this.host.sendSignal("proc.run.tool.finished", payload);
    } catch (error) {
      console.warn(`[Process] Failed to emit tool finish for ${executionId}:`, error);
    }
  }
}
