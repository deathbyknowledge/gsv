import type { QueryClient } from "@tanstack/preact-query";
import type { SysLedgerLine } from "@humansandmachines/gsv/protocol";
import { ledgerFromSysLines, type LedgerLine } from "../fleet/fleetModel";
import { INSTRUMENT_LEDGER_KEY } from "./queryKeys";
import { ledgerSequence, mergeLedgerChanges, type LedgerPages } from "./wireModel";

const KEY = [...INSTRUMENT_LEDGER_KEY, "sys"] as const;
export const LEDGER_PENDING_LIMIT = 256;

type LedgerSync = { changed: (lines: SysLedgerLine[]) => void; stop: () => void };

/** Keep patches received during a page fetch until its snapshot is committed. */
export function createLedgerSync(cache: QueryClient): LedgerSync {
  const currentQuery = () => cache.getQueryCache().find<LedgerPages>({ queryKey: KEY, exact: true });
  let query = currentQuery();
  let snapshotHead = ledgerSequence(query?.state.data?.pages[0]?.lines[0]);
  const pending = new Map<string, LedgerLine>();
  let overflowed = false;
  let scheduled = false;
  let stopped = false;

  const selectQuery = () => {
    const current = currentQuery();
    if (current !== query) {
      query = current;
      snapshotHead = ledgerSequence(query?.state.data?.pages[0]?.lines[0]);
      pending.clear();
      overflowed = false;
    }
    return current;
  };
  const schedule = () => {
    if (stopped || scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; flush(); });
  };
  const flush = () => {
    if (stopped) return;
    const current = selectQuery();
    if (!current || (!pending.size && !overflowed)) return;
    if (!current.isActive()) {
      pending.clear(); overflowed = false;
      void cache.invalidateQueries({ queryKey: KEY, exact: true, refetchType: "none" });
      return;
    }
    if (current.state.fetchStatus !== "idle") return;
    if (overflowed) {
      pending.clear(); overflowed = false;
      // more arrived at once than one page holds: walk the loaded pages again rather than leave a gap
      // Only an overflowing in-flight buffer needs recovery; ordinary row patches never request a list.
      void cache.invalidateQueries({ queryKey: KEY, exact: true });
      return;
    }
    if (!current.state.data) { pending.clear(); return; }
    const changes = [...pending.values()];
    pending.clear();
    const next = mergeLedgerChanges(current.state.data, changes, snapshotHead);
    if (next !== current.state.data) cache.setQueryData(KEY, next);
  };
  const unsubscribe = cache.getQueryCache().subscribe((event) => {
    const current = selectQuery();
    if (event.query !== current) return;
    if (event.type === "updated" && event.action.type === "success" && !event.action.manual && !current.state.fetchMeta?.fetchMore) {
      snapshotHead = ledgerSequence(current?.state.data?.pages[0]?.lines[0]);
    }
    if (pending.size || overflowed) schedule();
  });
  return {
    changed: (lines) => {
      if (stopped) return;
      const current = selectQuery();
      if (!current) return;
      if (!current.isActive()) {
        pending.clear(); overflowed = false;
        if (!current.state.isInvalidated) void cache.invalidateQueries({ queryKey: KEY, exact: true, refetchType: "none" });
        return;
      }
      if (!overflowed) {
        for (const line of ledgerFromSysLines(lines)) {
          const previous = pending.get(line.id);
          if (!previous || previous.outcome === "running" || line.outcome !== "running") pending.set(line.id, line);
          if (pending.size > LEDGER_PENDING_LIMIT) {
            pending.clear(); overflowed = true;
            break;
          }
        }
      }
      schedule();
    },
    stop: () => { stopped = true; unsubscribe(); pending.clear(); },
  };
}
