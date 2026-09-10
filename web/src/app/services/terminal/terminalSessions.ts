import { z } from "zod";
import type { ShellCancelResult } from "@humansandmachines/gsv/protocol";
import type { TerminalCommandInput, TerminalTranscriptEntry } from "./domain/models";

const sessionSchema = z.object({
  id: z.string(), scope: z.string(), target: z.string(), command: z.string(),
  sessionId: z.string().nullable(), startedAt: z.number(), endedAt: z.number().nullable(),
  status: z.enum(["starting", "running", "unavailable", "completed", "failed", "stopped"]),
  output: z.string(), truncated: z.boolean(), error: z.string(), actionError: z.string(),
  draft: z.string(), inputOpen: z.boolean(), action: z.enum(["input", "stop"]).nullable(),
  stopRequested: z.boolean(),
});
export type TerminalSession = z.infer<typeof sessionSchema>;
export type TerminalOperations = {
  execute: (input: TerminalCommandInput, signal: AbortSignal) => Promise<TerminalTranscriptEntry>;
  cancel: (sessionId: string, signal: AbortSignal) => Promise<ShellCancelResult>;
};
export type TerminalStorage = { read(): string | null; write(value: string): void };
const OUTPUT_LIMIT = 32_000;
const POLL_DELAY = 250;
export const terminalFinished = (session: TerminalSession) => session.endedAt !== null;

/** One owner for direct commands, independent of the currently mounted view. */
export class TerminalSessions {
  private rows: TerminalSession[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly jobs = new Map<string, { controller: AbortController; done: Promise<boolean> }>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private connected = false;
  private connectionVersion = 0;
  private disposed = false;

  constructor(private readonly operations: TerminalOperations, private readonly storage?: TerminalStorage) {
    try {
      const stored = storage?.read();
      if (stored) this.rows = z.array(sessionSchema).parse(JSON.parse(stored)).map((row) => terminalFinished(row) ? row : {
        ...row, status: "unavailable", action: null, error: row.sessionId ? "Checking the command after reconnect…" : "The command’s status could not be confirmed.",
      });
    } catch { /* A missing or unreadable local journal does not block a new command. */ }
  }

  snapshot = (): readonly TerminalSession[] => this.rows;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private find(id: string) { return this.rows.find((row) => row.id === id); }
  private publish() {
    const completed = this.rows.filter(terminalFinished).slice(-20);
    this.rows = this.rows.filter((row) => !terminalFinished(row) || completed.includes(row));
    try { this.storage?.write(JSON.stringify(this.rows)); } catch { /* View changes still retain the in-memory sessions. */ }
    if (!this.disposed) for (const listener of this.listeners) listener();
  }
  private patch(id: string, values: Partial<TerminalSession>) {
    if (this.disposed) return;
    this.rows = this.rows.map((row) => row.id === id ? { ...row, ...values } : row);
    this.publish();
  }

  setConnected(connected: boolean) {
    if (this.connected === connected) return;
    this.connected = connected;
    this.connectionVersion += 1;
    if (connected) {
      for (const row of this.rows) if (!terminalFinished(row) && row.sessionId) this.schedule(row.id, 0);
    } else {
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();
      this.rows = this.rows.map((row) => terminalFinished(row) ? row : { ...row, status: "unavailable", error: "Connection lost. The command may still be running." });
      this.publish();
    }
  }

  start(command: string, target: string, scope: string): string {
    if (!this.connected || this.disposed) throw new Error("Connect before running a command.");
    const id = `you:${crypto.randomUUID()}`;
    this.rows = [...this.rows, { id, scope, target, command, sessionId: null, startedAt: Date.now(), endedAt: null,
      status: "starting", output: "", truncated: false, error: "", actionError: "", draft: "", inputOpen: false, action: null, stopRequested: false }];
    this.publish();
    void this.execute(id, { input: command, target, background: target !== "gsv", yieldMs: 1_000 });
    return id;
  }

  private schedule(id: string, delay = POLL_DELAY) {
    if (this.disposed || !this.connected || this.timers.has(id)) return;
    this.timers.set(id, setTimeout(() => {
      this.timers.delete(id);
      const row = this.find(id);
      if (row?.sessionId && !terminalFinished(row) && !row.action && !this.jobs.has(id)) {
        void this.execute(id, { sessionId: row.sessionId, input: "", yieldMs: 1_000 });
      }
    }, delay));
  }

  private execute(id: string, input: TerminalCommandInput): Promise<boolean> {
    const controller = new AbortController();
    const connectionVersion = this.connectionVersion;
    const done = Promise.resolve().then(async () => {
      try {
        if (this.disposed || !this.connected) throw new Error("Connection lost. The command’s status is unknown.");
        const result = await this.operations.execute(input, controller.signal);
        const row = this.find(id);
        if (!row) return false;
        if (result.status === "running" && !result.sessionId) throw new Error("The command returned no session handle.");
        const output = row.output + result.output;
        this.patch(id, { sessionId: result.sessionId ?? row.sessionId,
          output: output.slice(-OUTPUT_LIMIT), truncated: row.truncated || result.truncated || output.length > OUTPUT_LIMIT,
          status: result.status === "running" ? "running" : row.stopRequested ? "stopped" : result.status,
          endedAt: result.status === "running" ? null : Date.now(),
          error: result.status === "failed" && !row.stopRequested ? result.stderr : "",
        });
        return true;
      } catch (error) {
        const row = this.find(id);
        if (row) this.patch(id, row.stopRequested && !row.sessionId && controller.signal.aborted && !this.disposed
          ? { status: "stopped", endedAt: Date.now(), error: "" }
          : { status: "unavailable", error: error instanceof Error ? error.message : "Could not check the command." });
        return false;
      } finally {
        this.jobs.delete(id);
        const row = this.find(id);
        if (row && !terminalFinished(row) && !row.action && (row.status === "running" || connectionVersion !== this.connectionVersion)) this.schedule(id);
      }
    });
    this.jobs.set(id, { controller, done });
    return done;
  }

  retry(id: string) {
    const row = this.find(id);
    if (row?.sessionId && !terminalFinished(row) && !row.action && !this.jobs.has(id)) this.schedule(id, 0);
  }
  targetConnected(target: string) {
    for (const row of this.rows) {
      if (row.target !== target || terminalFinished(row)) continue;
      const job = this.jobs.get(row.id);
      if (job) void job.done.then(() => this.retry(row.id));
      else this.retry(row.id);
    }
  }
  setDraft(id: string, draft: string) { this.patch(id, { draft }); }
  toggleInput(id: string) { const row = this.find(id); if (row) this.patch(id, { inputOpen: !row.inputOpen }); }

  async sendInput(id: string): Promise<boolean> {
    const row = this.find(id);
    if (!row?.sessionId || terminalFinished(row) || row.action || !this.connected) return false;
    const draft = row.draft;
    const connectionVersion = this.connectionVersion;
    this.patch(id, { action: "input", actionError: "" });
    await this.jobs.get(id)?.done;
    if (this.find(id)?.action !== "input") return false;
    if (this.disposed || !this.connected || connectionVersion !== this.connectionVersion || terminalFinished(this.find(id)!)) {
      this.patch(id, { action: null });
      if (!this.disposed && this.connected) this.schedule(id);
      return false;
    }
    const accepted = await this.execute(id, { sessionId: row.sessionId, input: `${draft}\n`, yieldMs: 1_000 });
    const update: Partial<TerminalSession> = { action: this.find(id)?.action === "stop" ? "stop" : null,
      actionError: accepted ? "" : "Input delivery could not be confirmed. Check the output before sending it again." };
    if (accepted && this.find(id)?.draft === draft) update.draft = "";
    this.patch(id, update);
    if (accepted && !terminalFinished(this.find(id)!) && !this.find(id)?.action) this.schedule(id);
    return accepted;
  }

  async stop(id: string): Promise<void> {
    let row = this.find(id);
    if (!row || terminalFinished(row) || row.action === "stop" || !this.connected) return;
    this.patch(id, { action: "stop", actionError: "" });
    if (row.action === "input") this.jobs.get(id)?.controller.abort(new Error("Stopping the command"));
    if (!row.sessionId && row.target === "gsv") {
      this.patch(id, { stopRequested: true });
      this.jobs.get(id)?.controller.abort(new Error("Command stopped"));
    }
    await this.jobs.get(id)?.done;
    row = this.find(id);
    if (!row || terminalFinished(row) || this.disposed || !this.connected) { this.patch(id, { action: null }); return; }
    const controller = new AbortController();
    try {
      if (!row.sessionId) throw new Error("The command’s session could not be recovered.");
      const result = await this.operations.cancel(row.sessionId, controller.signal);
      if (result.cancelled) this.patch(id, { stopRequested: true });
      if (!this.disposed) await this.execute(id, { sessionId: row.sessionId, input: "", yieldMs: 1_000 });
    } catch (error) {
      this.patch(id, { actionError: error instanceof Error ? error.message : "Could not stop the command." });
    } finally {
      this.patch(id, { action: null });
      if (this.find(id)?.status === "running") this.schedule(id);
    }
  }

  dispose() {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const job of this.jobs.values()) job.controller.abort(new Error("Connection closed"));
    this.listeners.clear();
  }
}
