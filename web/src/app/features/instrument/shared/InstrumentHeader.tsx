import type { RefObject } from "preact";
import type { Distance } from "../Instrument";
import { useT, type TextKey } from "../../../i18n/locale";
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
  navigationOpen: boolean;
  onNavigationToggle: () => void;
  navigationButtonRef: RefObject<HTMLButtonElement>;
  navigationRef: RefObject<HTMLElement>;
};

/** The current view's name beside the wordmark; Chat and Fleet are names and stay as they are. */
const VIEW_LABELS = {
  memory: "shell.nav.memory",
  people: "shell.nav.people",
  settings: "shell.nav.settings",
} satisfies Record<Exclude<Distance, "zen" | "fleet">, TextKey>;

export function InstrumentHeader({ distance, onNavigate, peopleWaiting, helper, onShip, help, onHelp, helpButtonRef,
  navigationOpen, onNavigationToggle, navigationButtonRef, navigationRef }: InstrumentHeaderProps) {
  const t = useT();
  return (
    <header class="instrument-top instrument-header">
      <div class="instrument-identity">
        <button type="button" aria-label={t("shell.header.home")} onClick={() => onNavigate("zen")}>
          <Wordmark />
        </button>
        {distance !== "zen" && <span class="instrument-current-view">{distance === "fleet" ? "fleet" : t(VIEW_LABELS[distance])}</span>}
        <Feedback view={distance} />
        <PlatformIdentity />
        {helper && <span class="instrument-helper">{t("shell.header.helper")} · <button type="button" onClick={onShip}>{t("shell.header.backToShip")}</button></span>}
      </div>
      <button type="button" class="instrument-menu-toggle" ref={navigationButtonRef}
        aria-expanded={navigationOpen} aria-controls="instrument-navigation" onClick={onNavigationToggle}>
        {navigationOpen ? t("shell.close") : t("shell.header.menu")}
        {distance !== "people" && peopleWaiting && <span class="instrument-people-waiting" aria-label={t("shell.header.unread")}>•</span>}
      </button>
      <nav id="instrument-navigation" class="keys" aria-label={t("shell.header.views")} ref={navigationRef} data-open={navigationOpen}>
        <button type="button" aria-current={distance === "zen" ? "page" : undefined} aria-keyshortcuts="c" onClick={() => onNavigate("zen")}>
          <kbd>c</kbd><span class="view-label">chat</span>
        </button>
        <button type="button" aria-current={distance === "fleet" ? "page" : undefined} aria-keyshortcuts="f" onClick={() => onNavigate("fleet")}>
          <kbd>f</kbd><span class="view-label">fleet</span>
        </button>
        <button type="button" aria-current={distance === "memory" ? "page" : undefined} aria-keyshortcuts="m" onClick={() => onNavigate("memory")}>
          <kbd>m</kbd><span class="view-label">{t("shell.nav.memory")}</span>
        </button>
        <button type="button" aria-current={distance === "people" ? "page" : undefined} aria-keyshortcuts="p" onClick={() => onNavigate("people")}>
          <kbd>p</kbd><span class="view-label">{t("shell.nav.people")}</span>
          {distance !== "people" && peopleWaiting && <span class="instrument-people-waiting" aria-label={t("shell.header.unread")}>•</span>}
        </button>
        <button type="button" aria-current={distance === "settings" ? "page" : undefined} aria-keyshortcuts="s" onClick={() => onNavigate("settings")}>
          <kbd>s</kbd><span class="view-label">{t("shell.nav.settings")}</span>
        </button>
        <button type="button" ref={helpButtonRef} aria-expanded={help} aria-controls="instrument-help" onClick={onHelp}><kbd>?</kbd>{t("shell.nav.help")}</button>
      </nav>
    </header>
  );
}
