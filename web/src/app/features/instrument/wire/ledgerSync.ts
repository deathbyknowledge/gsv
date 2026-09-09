import type { QueryClient } from "@tanstack/preact-query";
import type { GSVClient } from "@humansandmachines/gsv/client";
import { ledgerFromSysLines, sysLedgerListResultSchema, type LedgerLine } from "../fleet/fleetModel";
import { INSTRUMENT_LEDGER_KEY, INSTRUMENT_LEDGER_PAGE } from "./queryKeys";
import { prependLedger, type LedgerPages } from "./wireModel";

const KEY = [...INSTRUMENT_LEDGER_KEY, "sys"] as const;
type Client = Pick<GSVClient, "request">;

function latestSequence(data: LedgerPages): number {
  return Number(data.pages[0]?.lines[0]?.id.slice("sys:".length) ?? 0);
}

/** Walk the cursor to the cached head; signal counts exclude ledger reads and cannot delimit the gap. */
async function readNewLines(client: Client, after: number, signal: AbortSignal): Promise<LedgerLine[]> {
  const lines: LedgerLine[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    signal.throwIfAborted();
    const { data, body } = await client.request("sys.ledger.list", {
      limit: INSTRUMENT_LEDGER_PAGE, ...(cursor ? { cursor } : {}),
    }, { signal });
    if (body) await body.stream.cancel();
    signal.throwIfAborted();
    const page = sysLedgerListResultSchema.parse(data);
    lines.push(...ledgerFromSysLines(page.lines.filter((line) => line.seq > after)));
    if (after === 0 || page.lines.some((line) => line.seq <= after)) break;
    cursor = page.nextCursor;
    if (cursor) {
      if (cursors.has(cursor)) throw new Error("The ledger returned a repeated page cursor");
      cursors.add(cursor);
    }
  } while (cursor);
  return lines;
}

/** One catch-up at a time for an observed ledger, after any ordinary page fetch settles. */
export function createLedgerSync(client: Client, cache: QueryClient): { appended: (seq: number) => void; stop: () => void } {
  const currentQuery = () => cache.getQueryCache().find<LedgerPages>({ queryKey: KEY, exact: true });
  let pending = 0;
  let running: AbortController | null = null;
  let scheduled = false;
  let stopped = false;

  const schedule = () => {
    if (stopped || scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; void flush(); });
  };
  const flush = async () => {
    if (stopped || (!pending && !running)) return;
    const query = currentQuery();
    if (!query || !query.isActive()) {
      running?.abort();
      pending = 0;
      if (query && !query.state.isInvalidated) {
        void cache.invalidateQueries({ queryKey: KEY, exact: true, refetchType: "none" });
      }
      return;
    }
    if (running) {
      if (query.state.fetchStatus !== "idle") running.abort();
      return;
    }
    if (query.state.fetchStatus !== "idle" || !query.state.data) return;
    const after = latestSequence(query.state.data);
    if (after >= pending) { pending = 0; return; }
    const requested = pending;
    pending = 0;
    const controller = new AbortController();
    running = controller;
    try {
      const fresh = await readNewLines(client, after, controller.signal);
      if (!stopped && !controller.signal.aborted && currentQuery() === query && query.isActive()) {
        cache.setQueryData<LedgerPages>(KEY, (data) => data ? prependLedger(data, fresh) : data);
      }
    } catch {
      if (!stopped && currentQuery() === query && query.isActive()) {
        if (controller.signal.aborted) pending = Math.max(pending, requested);
        else {
          // An ordinary refresh owns visible query errors if catch-up fails.
          void cache.invalidateQueries({ queryKey: KEY, exact: true });
        }
      }
    } finally {
      running = null;
      schedule();
    }
  };
  const unsubscribe = cache.getQueryCache().subscribe((event) => {
    if (event.query.queryHash === cache.getQueryCache().find({ queryKey: KEY, exact: true })?.queryHash || event.type === "removed") {
      if (pending || running) schedule();
    }
  });
  return {
    appended: (seq) => { pending = Math.max(pending, seq); schedule(); },
    stop: () => { stopped = true; unsubscribe(); running?.abort(); },
  };
}
