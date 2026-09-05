import type { FleetRow } from "../Instrument";

export type FleetProps = {
  /** The row to land on, when Zen sent us here from a reference. */
  initialRow: FleetRow | null;
  onZen: () => void;
};

/** Placeholder until the Fleet distance lands. */
export function Fleet({ initialRow, onZen }: FleetProps) {
  return (
    <main class="fleet" aria-label="Fleet">
      <div class="instrument-top">
        <span class="wordmark">GSV</span>
        <span>fleet{initialRow ? ` · ${initialRow}` : ""}</span>
        <span class="keys">
          <button type="button" onClick={onZen}>
            <kbd>z</kbd>zen
          </button>
        </span>
      </div>
    </main>
  );
}
