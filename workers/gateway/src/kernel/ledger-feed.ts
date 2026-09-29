import type { SysLedgerChangedSignal, SysLedgerLine } from "@humansandmachines/gsv/protocol";

export const LEDGER_FEED_ROWS = 32;
export const LEDGER_FEED_BYTES = 128 * 1024;
export const LEDGER_FEED_DELAY_MS = 500;

type Pending = {
  timer: ReturnType<typeof setTimeout>;
  rows: Map<number, { line: SysLedgerLine; bytes: number }>;
  bytes: number;
};

/** Short, bounded batches; a completion replaces its pending open row before delivery. */
export class LedgerFeed {
  private readonly pending = new Map<number, Pending>();
  private readonly encoder = new TextEncoder();

  constructor(private readonly publish: (ownerUid: number, payload: SysLedgerChangedSignal) => void) {}

  changed(ownerUid: number, line: SysLedgerLine): void {
    const bytes = this.encoder.encode(JSON.stringify(line)).byteLength + 1;
    let batch = this.pending.get(ownerUid);
    const previous = batch?.rows.get(line.seq);
    if (batch && (batch.bytes - (previous?.bytes ?? 0) + bytes > LEDGER_FEED_BYTES
      || (!previous && batch.rows.size === LEDGER_FEED_ROWS))) {
      this.flush(ownerUid);
      batch = undefined;
    }
    if (!batch) {
      batch = { timer: setTimeout(() => this.flush(ownerUid), LEDGER_FEED_DELAY_MS), rows: new Map(), bytes: 128 };
      this.pending.set(ownerUid, batch);
    }
    batch.bytes += bytes - (batch.rows.get(line.seq)?.bytes ?? 0);
    batch.rows.set(line.seq, { line, bytes });
  }

  private flush(ownerUid: number): void {
    const batch = this.pending.get(ownerUid);
    if (!batch) return;
    this.pending.delete(ownerUid);
    clearTimeout(batch.timer);
    this.publish(ownerUid, { lines: [...batch.rows.values()].map(({ line }) => line).sort((a, b) => b.seq - a.seq) });
  }
}
