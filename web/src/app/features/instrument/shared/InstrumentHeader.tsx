import type { RefObject } from "preact";
import type { Distance } from "../Instrument";
import { Wordmark } from "./Wordmark";
import { PlatformIdentity } from "../../../services/platform/PlatformIdentity";
import { Feedback } from "./Feedback";

type InstrumentHeaderProps = {
  distance: Distance;
  onNavigate: (distance: Distance) => void;
  peopleWaiting?: boolean;
  onResponsibilities?: () => void;
  responsibilityCount?: number;
  helper: boolean;
  /** Back to the ship's own conversation. */
  onShip: () => void;
  help: boolean;
  onHelp: () => void;
  /** The keys button, so the panel it opens can tell a press on it from one outside. */
  helpButtonRef: RefObject<HTMLButtonElement>;
  navigationOpen: boolean;
  onNavigationToggle: () => void;
  navigationButtonRef: RefObject<HTMLButtonElement>;
  navigationRef: RefObject<HTMLElement>;
};

export function InstrumentHeader({ distance, onNavigate, peopleWaiting, onResponsibilities, responsibilityCount, helper, onShip, help, onHelp, helpButtonRef,
  navigationOpen, onNavigationToggle, navigationButtonRef, navigationRef }: InstrumentHeaderProps) {
  return (
    <header class="instrument-top instrument-header">
      <div class="instrument-identity">
        <button type="button" aria-label="GSV · Open Chat" onClick={() => onNavigate("zen")}>
          <Wordmark />
        </button>
        {distance !== "zen" && <span class="instrument-current-view">{distance}</span>}
        {distance === "zen" && !helper && onResponsibilities && <button type="button" class="instrument-responsibilities" onClick={onResponsibilities} title="Responsibilities and routines">
          <span>plans</span>{responsibilityCount !== undefined && responsibilityCount > 0 && <span class="instrument-responsibility-count">{responsibilityCount}</span>}
        </button>}
        <Feedback view={distance} />
        <PlatformIdentity />
        {helper && <span class="instrument-helper">helper · <button type="button" onClick={onShip}>back to your Ship</button></span>}
      </div>
      <button type="button" class="instrument-menu-toggle" ref={navigationButtonRef}
        aria-expanded={navigationOpen} aria-controls="instrument-navigation" onClick={onNavigationToggle}>
        {navigationOpen ? "close" : "menu"}
        {distance !== "people" && peopleWaiting && <span class="instrument-people-waiting" aria-label="Unread messages or requests">•</span>}
      </button>
      <nav id="instrument-navigation" class="keys" aria-label="Views" ref={navigationRef} data-open={navigationOpen}>
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
