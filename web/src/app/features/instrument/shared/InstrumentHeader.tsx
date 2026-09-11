import type { Distance } from "../Instrument";
import { Wordmark } from "./Wordmark";

type InstrumentHeaderProps = {
  distance: Distance;
  onNavigate: (distance: Distance) => void;
  helper: boolean;
  /** Back to the ship's own conversation. */
  onShip: () => void;
  help: boolean;
  onHelp: () => void;
};

export function InstrumentHeader({ distance, onNavigate, helper, onShip, help, onHelp }: InstrumentHeaderProps) {
  return (
    <header class="instrument-top instrument-header">
      <div class="instrument-identity">
        <Wordmark />
        {helper && <span class="instrument-helper">helper · <button type="button" onClick={onShip}>back to your Ship</button></span>}
      </div>
      <nav class="keys" aria-label="Views">
        <button type="button" onClick={() => onNavigate(distance === "fleet" ? "zen" : "fleet")}>
          <kbd>z</kbd>{distance === "fleet" ? "zen" : "fleet"}
        </button>
        <button type="button" onClick={() => onNavigate(distance === "memory" ? "zen" : "memory")}>
          <kbd>m</kbd>{distance === "memory" ? "zen" : "memory"}
        </button>
        <button type="button" onClick={() => onNavigate(distance === "settings" ? "zen" : "settings")}>
          <kbd>,</kbd>{distance === "settings" ? "zen" : "settings"}
        </button>
        <button type="button" aria-expanded={help} aria-controls="instrument-help" onClick={onHelp}><kbd>?</kbd>keys</button>
      </nav>
    </header>
  );
}
