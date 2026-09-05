import type { FleetRow } from "../Instrument";

export type ZenProps = {
  /** Step back to Fleet, optionally landing on a row (a target mentioned in a response, for instance). */
  onFleet: (row?: FleetRow) => void;
  /** Open the first day: the places manifest with empty rows. */
  onFirstDay: () => void;
};

/** Placeholder until the Zen distance lands. */
export function Zen({ onFleet, onFirstDay }: ZenProps) {
  return (
    <main class="zen" aria-label="Zen">
      <div class="instrument-top">
        <span class="wordmark">GSV</span>
        <span>zen</span>
        <span class="keys">
          <button type="button" onClick={() => onFleet()}>
            <kbd>z</kbd>fleet
          </button>
          <button type="button" onClick={onFirstDay}>
            <kbd>n</kbd>first day
          </button>
        </span>
      </div>
    </main>
  );
}
