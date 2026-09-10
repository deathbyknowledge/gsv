import type { GSVClient } from "@humansandmachines/gsv/client";
import type { QueryClient } from "@tanstack/preact-query";
import type { ProcHistoryArgs, ProcHistoryResult } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import type { ChatHistory } from "../domain/processes";
import {
  addOptimisticUserMessage, applyChatSignal, chatRuntimeStateFromHistory, emptyChatRuntimeState,
  newerContextSnapshot, type ChatRuntimeState,
} from "../domain/transcript";
import { mergeTranscriptRows } from "../domain/transcriptMerge";
import { mergeHistoryRecords } from "../domain/typedHistory";
import { getChatHistory } from "./chatService";

export const processHistoryKey = (pid: string) => ["process", pid, "history"] as const;
export type SyncedChatHistory = ChatHistory & { runtime: ChatRuntimeState };
type HistoryClient = {
  proc: Pick<GSVClient["proc"], "observe" | "unobserve"> & { history(args?: ProcHistoryArgs): Promise<ProcHistoryResult> };
  onSignal: GSVClient["onSignal"];
  onStatus?: GSVClient["onStatus"];
};
type Signal = Parameters<Parameters<GSVClient["onSignal"]>[0]>;
type Entry = {
  pid: string;
  limit: number;
  users: number;
  observers: number;
  observed: boolean;
  dirty: boolean;
  snapshot: boolean;
  epoch: number;
  signals: Signal[];
  supersededRunIds: Set<string>;
  inFlight?: Promise<SyncedChatHistory>;
};
const signalIdentitySchema = z.object({
  pid: z.string(),
  changes: z.array(z.string()).optional(),
  runId: z.string().optional(),
  historyRevision: z.number().optional(),
  historyGeneration: z.number().optional(),
  historyResetRevision: z.number().optional(),
});

/** One process cache owns durable deltas and transient wire activity for every web surface. */
export class ProcessHistorySync {
  private readonly entries = new Map<string, Entry>();
  private dropped = false;

  constructor(private readonly client: HistoryClient, private readonly queries: QueryClient) {
    client.onSignal((signal, payload) => this.receive(signal, payload));
    client.onStatus?.((status) => {
      if (status.state !== "connected") {
        this.dropped = true;
        return;
      }
      if (!this.dropped) return;
      this.dropped = false;
      for (const entry of this.entries.values()) {
        if (entry.users === 0) continue;
        entry.epoch += 1;
        entry.snapshot = true;
        entry.observed = false;
        if (entry.observers > 0) void this.observe(entry);
        void this.read(entry.pid, entry.limit).catch(() => undefined);
      }
    });
  }

  private entry(pid: string, limit: number): Entry {
    let entry = this.entries.get(pid);
    if (!entry) {
      entry = { pid, limit, users: 0, observers: 0, observed: false, dirty: false, snapshot: false, epoch: 0, signals: [], supersededRunIds: new Set() };
      this.entries.set(pid, entry);
    }
    if (limit > entry.limit) entry.snapshot = true;
    entry.limit = Math.max(entry.limit, limit);
    return entry;
  }

  retain(pid: string, limit: number, observe: boolean): () => void {
    const entry = this.entry(pid, limit);
    entry.users += 1;
    if (observe) {
      entry.observers += 1;
      void this.observe(entry);
    }
    if (this.queries.getQueryData(processHistoryKey(pid))) {
      void this.read(pid, limit).catch(() => undefined);
    }
    return () => {
      entry.users -= 1;
      if (observe) entry.observers -= 1;
      if (entry.observers === 0 && entry.observed) {
        entry.observed = false;
        void this.client.proc.unobserve({ pid }).catch(() => undefined);
      }
    };
  }

  private async observe(entry: Entry): Promise<void> {
    if (entry.observed) return;
    entry.observed = true;
    try {
      await this.client.proc.observe({ pid: entry.pid });
      if (entry.observers === 0) {
        entry.observed = false;
        await this.client.proc.unobserve({ pid: entry.pid });
      }
    } catch {
      entry.observed = false;
    }
  }

  read(pid: string, limit = 50): Promise<SyncedChatHistory> {
    const entry = this.entry(pid, limit);
    entry.dirty = true;
    if (!entry.inFlight) {
      entry.inFlight = Promise.resolve().then(() => this.drain(entry)).finally(() => {
        entry.inFlight = undefined;
        if (entry.dirty && entry.users > 0) void this.read(entry.pid, entry.limit).catch(() => undefined);
      });
    }
    return entry.inFlight;
  }

  private async drain(entry: Entry): Promise<SyncedChatHistory> {
    let current = this.queries.getQueryData<SyncedChatHistory>(processHistoryKey(entry.pid));
    do {
      entry.dirty = false;
      const snapshot = entry.snapshot || !current?.cursor;
      entry.snapshot = false;
      const epoch = entry.epoch;
      const baseRuntime = current?.runtime;
      entry.signals = [];
      const args: ProcHistoryArgs = {
        pid: entry.pid, limit: entry.limit,
        ...(snapshot ? { tail: true } : { since: current!.cursor }),
      };
      const page = await getChatHistory(this.client, args);
      if (epoch !== entry.epoch) {
        entry.dirty = true;
        continue;
      }
      if (!page.cursor) throw new Error("The gateway returned typed history without a synchronization cursor.");
      const latest = this.queries.getQueryData<SyncedChatHistory>(processHistoryKey(entry.pid));
      const epochChanged = latest !== undefined && (page.historyGeneration !== latest.historyGeneration
        || page.historyResetRevision !== latest.historyResetRevision);
      const reset = snapshot || page.reset || !latest || epochChanged;
      if (latest && epochChanged) {
        this.retireRuns(entry, latest);
      }
      const history: ChatHistory = {
        ...page,
        records: reset ? page.records : mergeHistoryRecords(latest.records, page.records),
        hasMoreBefore: reset ? page.hasMoreBefore : latest.hasMoreBefore,
      };
      let runtime = chatRuntimeStateFromHistory(history);
      const preservesActiveRun = !epochChanged && baseRuntime?.activeRunId !== null
        && baseRuntime?.activeRunId === history.activeRunId;
      if (baseRuntime && (!reset || preservesActiveRun)) {
        const transient = baseRuntime.rows.filter((row) => (!reset || row.runId === history.activeRunId)
          && (!row.historyRecordKey || (row.role === "tool" && row.status === "running")));
        runtime = {
          ...runtime, ...newerContextSnapshot(baseRuntime, runtime),
          rows: mergeTranscriptRows(transient, runtime.rows),
        };
      }
      for (const [signal, payload] of entry.signals) {
        runtime = applyChatSignal(runtime, signal, payload, { pid: entry.pid }).state;
      }
      current = { ...history, runtime };
      this.queries.setQueryData(processHistoryKey(entry.pid), current);
      if (page.hasMore) entry.dirty = true;
    } while (entry.dirty);
    if (!current) throw new Error("Process history was not returned.");
    return current;
  }

  private retireRuns(entry: Entry, history: SyncedChatHistory): void {
    if (history.runtime.activeRunId) entry.supersededRunIds.add(history.runtime.activeRunId);
    for (const record of history.records) if (record.runId) entry.supersededRunIds.add(record.runId);
  }

  private receive(signal: Signal[0], payload: Signal[1]): void {
    const identity = signalIdentitySchema.safeParse(payload);
    if (!identity.success) return;
    if (signal === "proc.changed"
      && identity.data.historyRevision === undefined
      && identity.data.historyGeneration === undefined
      && identity.data.historyResetRevision === undefined
      && identity.data.changes?.length
      && identity.data.changes.every((change) => change === "state" || change === "created")) return;
    const entry = this.entries.get(identity.data.pid);
    if (!entry || (entry.users === 0 && !entry.inFlight)) return;
    if (identity.data.runId && entry.supersededRunIds.has(identity.data.runId)) return;
    const key = processHistoryKey(entry.pid);
    const current = this.queries.getQueryData<SyncedChatHistory>(key);
    if (current && identity.data.historyGeneration !== undefined
      && identity.data.historyGeneration < current.historyGeneration) return;
    const reset = current && (
      (identity.data.historyGeneration !== undefined && identity.data.historyGeneration > current.historyGeneration)
      || (identity.data.historyResetRevision !== undefined && identity.data.historyResetRevision > current.historyResetRevision)
    );
    if (reset) {
      this.retireRuns(entry, current);
      entry.epoch += 1;
      entry.snapshot = true;
      entry.signals = [];
      this.queries.setQueryData<SyncedChatHistory>(key, {
        ...current, records: [], cursor: undefined,
        historyGeneration: identity.data.historyGeneration ?? current.historyGeneration,
        historyResetRevision: identity.data.historyResetRevision ?? current.historyResetRevision,
        runtime: emptyChatRuntimeState(entry.pid),
      });
    }
    if (entry.inFlight) entry.signals.push([signal, payload]);
    const state = this.queries.getQueryData<SyncedChatHistory>(key);
    const reduced = applyChatSignal(state?.runtime ?? emptyChatRuntimeState(entry.pid), signal, payload, { pid: entry.pid });
    if (!reduced.matched) return;
    if (state) this.queries.setQueryData<SyncedChatHistory>(key, { ...state, runtime: reduced.state });
    if (reset || reduced.refreshHistory || signal === "proc.changed" || signal === "proc.run.tool.started" || signal === "proc.run.started") {
      void this.read(entry.pid, entry.limit).catch(() => undefined);
    }
  }

  appendOptimistic(pid: string, text: string, media: unknown[] = []): void {
    this.queries.setQueryData<SyncedChatHistory>(processHistoryKey(pid), (current) => current
      ? { ...current, runtime: addOptimisticUserMessage(current.runtime, text, media) }
      : current);
  }

  async loadOlder(pid: string, beforeMessageId: number, limit: number): Promise<ChatHistory> {
    const page = await getChatHistory(this.client, { pid, beforeMessageId, limit });
    const key = processHistoryKey(pid);
    const current = this.queries.getQueryData<SyncedChatHistory>(key);
    if (!current) return page;
    if (page.historyGeneration !== current.historyGeneration || page.historyResetRevision !== current.historyResetRevision) {
      this.entry(pid, limit).snapshot = true;
      await this.read(pid, limit);
      return this.queries.getQueryData<SyncedChatHistory>(key)!;
    }
    const records = mergeHistoryRecords(page.records, current.records);
    const history = { ...current, records, hasMoreBefore: page.hasMoreBefore };
    this.queries.setQueryData<SyncedChatHistory>(key, {
      ...history,
      runtime: { ...current.runtime, rows: mergeTranscriptRows(current.runtime.rows.filter((row) => !row.historyRecordKey || (row.role === "tool" && row.status === "running")), chatRuntimeStateFromHistory(history).rows) },
    });
    return page;
  }
}

const synchronizers = new WeakMap<QueryClient, WeakMap<HistoryClient, ProcessHistorySync>>();

export function getProcessHistorySync(client: HistoryClient, queries: QueryClient): ProcessHistorySync {
  let clients = synchronizers.get(queries);
  if (!clients) {
    clients = new WeakMap();
    synchronizers.set(queries, clients);
  }
  let sync = clients.get(client);
  if (!sync) {
    sync = new ProcessHistorySync(client, queries);
    clients.set(client, sync);
  }
  return sync;
}
