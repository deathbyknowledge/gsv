import type { RefObject } from "preact";
import type { Distance } from "../Instrument";
import { useT, type TextKey } from "../../../i18n/locale";
import { Hint } from "../../../components/ui/Tooltip";
import { Wordmark } from "./Wordmark";
import { PlatformIdentity } from "../../../services/platform/PlatformIdentity";
import { Feedback } from "./Feedback";

type InstrumentHeaderProps = {
  distance: Distance;
  onNavigate: (distance: Distance) => void;
  peopleWaiting?: boolean;
  feedbackRequest?: number;
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

/** The current view's name beside the wordmark; Chat is a name and stays as it is. */
const VIEW_LABELS = {
  fleet: "shell.nav.work",
  memory: "shell.nav.memory",
  people: "shell.nav.people",
  settings: "shell.nav.settings",
} satisfies Record<Exclude<Distance, "zen">, TextKey>;

export function InstrumentHeader({ distance, onNavigate, peopleWaiting, feedbackRequest, helper, onShip, help, onHelp, helpButtonRef,
  navigationOpen, onNavigationToggle, navigationButtonRef, navigationRef }: InstrumentHeaderProps) {
  const t = useT();
  return (
    <header class="instrument-top instrument-header">
      <div class="instrument-identity">
        <button type="button" aria-label={t("shell.header.home")} onClick={() => onNavigate("zen")}>
          <Wordmark />
        </button>
        {distance !== "zen" && <span class="instrument-current-view">{t(VIEW_LABELS[distance])}</span>}
        <Feedback view={distance} openRequest={feedbackRequest} />
        <PlatformIdentity />
        {helper && <span class="instrument-helper">{t("shell.header.helper")} · <button type="button" onClick={onShip}>{t("shell.header.backToShip")}</button></span>}
      </div>
      <button type="button" class="instrument-menu-toggle" ref={navigationButtonRef}
        aria-expanded={navigationOpen} aria-controls="instrument-navigation" onClick={onNavigationToggle}>
        {navigationOpen ? t("shell.close") : t("shell.header.menu")}
        {distance !== "people" && peopleWaiting && <span class="instrument-people-waiting" aria-label={t("shell.header.unread")}>•</span>}
      </button>
      <nav id="instrument-navigation" class="keys" aria-label={t("shell.header.views")} ref={navigationRef} data-open={navigationOpen}>
        <Hint text={t("shell.nav.zenHint")} position="bottom">
          <button type="button" aria-current={distance === "zen" ? "page" : undefined} aria-keyshortcuts="c" onClick={() => onNavigate("zen")}>
            <kbd>c</kbd><span class="view-label">chat</span>
          </button>
        </Hint>
        <Hint text={t("shell.nav.fleetHint")} position="bottom">
          <button type="button" aria-current={distance === "fleet" ? "page" : undefined} aria-keyshortcuts="w" onClick={() => onNavigate("fleet")}>
            <kbd>w</kbd><span class="view-label">{t("shell.nav.work")}</span>
          </button>
        </Hint>
        <Hint text={t("shell.nav.memoryHint")} position="bottom">
          <button type="button" aria-current={distance === "memory" ? "page" : undefined} aria-keyshortcuts="m" onClick={() => onNavigate("memory")}>
            <kbd>m</kbd><span class="view-label">{t("shell.nav.memory")}</span>
          </button>
        </Hint>
        <Hint text={t("shell.nav.peopleHint")} position="bottom">
          <button type="button" aria-current={distance === "people" ? "page" : undefined} aria-keyshortcuts="p" onClick={() => onNavigate("people")}>
            <kbd>p</kbd><span class="view-label">{t("shell.nav.people")}</span>
            {distance !== "people" && peopleWaiting && <span class="instrument-people-waiting" aria-label={t("shell.header.unread")}>•</span>}
          </button>
        </Hint>
        <Hint text={t("shell.nav.settingsHint")} position="bottom">
          <button type="button" aria-current={distance === "settings" ? "page" : undefined} aria-keyshortcuts="s" onClick={() => onNavigate("settings")}>
            <kbd>s</kbd><span class="view-label">{t("shell.nav.settings")}</span>
          </button>
        </Hint>
        <Hint text={t("shell.nav.helpHint")} position="bottom">
          <button type="button" ref={helpButtonRef} aria-expanded={help} aria-controls="instrument-help" aria-keyshortcuts="?" onClick={onHelp}><kbd>?</kbd>{t("shell.nav.help")}</button>
        </Hint>
      </nav>
    </header>
  );
}
