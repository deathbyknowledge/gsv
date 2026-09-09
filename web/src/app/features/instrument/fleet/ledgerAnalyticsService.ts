import type { GSVClient } from "@humansandmachines/gsv/client";
import type { ProcHistoryArgs, ProcHistoryRecordsResult } from "@humansandmachines/gsv/protocol";
import { ledgerFromSysLines, sysLedgerListResultSchema } from "./fleetModel";
import { generationUsage, type AnalysisLine, type GenerationUsage, type LedgerWindow, type ProcessTrace } from "./ledgerAnalytics";

type Client = Pick<GSVClient, "request">;
export type LedgerBatch = { lines: AnalysisLine[]; nextCursor: string | null };

/** Freeze the upper time bound so reading a window cannot chase its own ledger entries. */
export async function loadLedgerBatch(client: Client, window: LedgerWindow, cursor: string | null, signal: AbortSignal): Promise<LedgerBatch> {
  const lines: AnalysisLine[] = [];
  let nextCursor = cursor;
  const seen = new Set<string>();
  for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
    signal.throwIfAborted();
    if (nextCursor) seen.add(nextCursor);
    const { data, body } = await client.request("sys.ledger.list", {
      ...window, limit: 200, ...(nextCursor ? { cursor: nextCursor } : {}),
    }, { signal });
    if (body) await body.stream.cancel();
    const page = sysLedgerListResultSchema.parse(data);
    const normalized = ledgerFromSysLines(page.lines);
    lines.push(...normalized.map((line, index) => ({ ...line, durationMs: page.lines[index].durationMs })));
    nextCursor = page.nextCursor;
    if (!nextCursor) break;
    if (seen.has(nextCursor)) throw new Error("The ledger returned a repeated page cursor");
  }
  return { lines, nextCursor };
}

export type ProcessRead<T> = { pid: string; value: T } | { pid: string; error: string };

/** Limit simultaneous Process reads; one inaccessible process does not hide the rest. */
async function readProcesses<T>(pids: readonly string[], signal: AbortSignal, read: (pid: string) => Promise<T>): Promise<ProcessRead<T>[]> {
  const results: ProcessRead<T>[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, pids.length) }, async () => {
    while (next < pids.length) {
      signal.throwIfAborted();
      const pid = pids[next++];
      try {
        results.push({ pid, value: await read(pid) });
      } catch (error) {
        signal.throwIfAborted();
        results.push({ pid, error: error instanceof Error ? error.message : "Could not read this process" });
      }
    }
  }));
  return results;
}

export function loadTimeline(client: Client, pids: readonly string[], signal: AbortSignal): Promise<ProcessRead<ProcessTrace>[]> {
  return readProcesses(pids, signal, async (pid) => {
    const { data, body } = await client.request("proc.trace", { pid, limit: 1_000 }, { signal });
    if (body) await body.stream.cancel();
    if (!data.ok) throw new Error(data.error);
    return { pid, spans: data.spans, truncated: data.truncated };
  });
}

export async function loadAnalysisHistory(client: Client, args: ProcHistoryArgs, signal: AbortSignal): Promise<ProcHistoryRecordsResult> {
  const { data, body } = await client.request("proc.history", { ...args, format: 2 }, { signal });
  if (body) await body.stream.cancel();
  if (!data.ok) throw new Error(data.error);
  if (data.format !== 2) throw new Error("Typed history is unavailable on this gateway");
  return data;
}

export function loadUsage(client: Client, pids: readonly string[], window: LedgerWindow, signal: AbortSignal): Promise<ProcessRead<{ generations: GenerationUsage[]; partial: boolean }>[]> {
  return readProcesses(pids, signal, async (pid) => {
    const history = await loadAnalysisHistory(client, { pid, limit: 200, tail: true }, signal);
    return {
      generations: generationUsage(pid, history.records, window),
      partial: history.hasMoreBefore === true || history.truncated === true,
    };
  });
}
