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
        <button type="button" aria-label="GSV · Open Chat" onClick={() => onNavigate("zen")}>
          <Wordmark />
        </button>
        <Feedback view={distance} />
        <PlatformIdentity />
        {helper && <span class="instrument-helper">helper · <button type="button" onClick={onShip}>back to your Ship</button></span>}
      </div>
      <nav class="keys" aria-label="Views">
        <button type="button" aria-current={distance === "zen" ? "page" : undefined} aria-keyshortcuts="c" onClick={() => onNavigate("zen")}>
          <kbd>c</kbd><span class="view-label">chat</span>
        </button>
        <button type="button" aria-current={distance === "fleet" ? "page" : undefined} aria-keyshortcuts="f" onClick={() => onNavigate("fleet")}>
          <kbd>f</kbd><span class="view-label">fleet</span>
        </button>
        <button type="button" aria-current={distance === "memory" ? "page" : undefined} aria-keyshortcuts="m" onClick={() => onNavigate("memory")}>
          <kbd>m</kbd><span class="view-label">memory</span>
        </button>
        <button type="button" aria-current={distance === "people" ? "page" : undefined} aria-keyshortcuts="p" onClick={() => onNavigate("people")}>
          <kbd>p</kbd><span class="view-label">people</span>
          {distance !== "people" && peopleWaiting && <span class="instrument-people-waiting" aria-label="Unread messages or requests">•</span>}
        </button>
        <button type="button" aria-current={distance === "settings" ? "page" : undefined} aria-keyshortcuts="s" onClick={() => onNavigate("settings")}>
          <kbd>s</kbd><span class="view-label">settings</span>
        </button>
        <button type="button" ref={helpButtonRef} aria-expanded={help} aria-controls="instrument-help" onClick={onHelp}><kbd>?</kbd>help</button>
      </nav>
    </header>
  );
}
