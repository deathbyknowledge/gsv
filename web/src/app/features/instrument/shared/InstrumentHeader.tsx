import type { RefObject } from "preact";
import type { Distance } from "../Instrument";
import { Wordmark } from "./Wordmark";
import { PlatformIdentity } from "../../../services/platform/PlatformIdentity";
import { Feedback } from "./Feedback";

type InstrumentHeaderProps = {
  distance: Distance;
  onNavigate: (distance: Distance) => void;
  peopleWaiting?: boolean;
  helper: boolean;
  /** Back to the ship's own conversation. */
  onShip: () => void;
  help: boolean;
  onHelp: () => void;
  /** The keys button, so the panel it opens can tell a press on it from one outside. */
  helpButtonRef: RefObject<HTMLButtonElement>;
};

export function InstrumentHeader({ distance, onNavigate, peopleWaiting, helper, onShip, help, onHelp, helpButtonRef }: InstrumentHeaderProps) {
  return (
    <header class="instrument-top instrument-header">
      <div class="instrument-identity">
        <button type="button" aria-label="GSV · Open Zen" onClick={() => onNavigate("zen")}>
          <Wordmark />
        </button>
        <Feedback view={distance} />
        <PlatformIdentity />
        {helper && <span class="instrument-helper">helper · <button type="button" onClick={onShip}>back to your Ship</button></span>}
      </div>
      <nav class="keys" aria-label="Views">
        <button type="button" onClick={() => onNavigate(distance === "fleet" ? "zen" : "fleet")}>
          <kbd>z</kbd>{distance === "fleet" ? "zen" : "fleet"}
        </button>
        <button type="button" onClick={() => onNavigate(distance === "memory" ? "zen" : "memory")}>
          <kbd>m</kbd>{distance === "memory" ? "zen" : "memory"}
        </button>
        <button type="button" onClick={() => onNavigate(distance === "people" ? "zen" : "people")}>
          <kbd>p</kbd>{distance === "people" ? "zen" : "people"}
          {distance !== "people" && peopleWaiting && <span class="instrument-people-waiting" aria-label="Unread messages or requests">•</span>}
        </button>
        <button type="button" onClick={() => onNavigate(distance === "settings" ? "zen" : "settings")}>
          <kbd>,</kbd>{distance === "settings" ? "zen" : "settings"}
        </button>
        <button type="button" ref={helpButtonRef} aria-expanded={help} aria-controls="instrument-help" onClick={onHelp}><kbd>?</kbd>keys</button>
      </nav>
    </header>
  );
}
