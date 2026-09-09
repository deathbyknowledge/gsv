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
        <button type="button" aria-current={distance === "zen" ? "page" : undefined} onClick={() => onNavigate("zen")}>zen</button>
        <button type="button" aria-current={distance === "fleet" ? "page" : undefined} onClick={() => onNavigate("fleet")} title="z switches between Zen and Fleet"><kbd>z</kbd>fleet</button>
        <button type="button" aria-current={distance === "memory" ? "page" : undefined} onClick={() => onNavigate("memory")}><kbd>m</kbd>memory</button>
        <button type="button" aria-current={distance === "settings" ? "page" : undefined} onClick={() => onNavigate("settings")}><kbd>,</kbd>settings</button>
        <button type="button" aria-expanded={help} aria-controls="instrument-help" onClick={onHelp}><kbd>?</kbd>keys</button>
      </nav>
    </header>
  );
}
