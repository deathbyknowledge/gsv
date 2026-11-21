import type { RefObject } from "preact";
import type { Distance } from "../Instrument";
import { useT, type TextKey } from "../../../i18n/locale";
import { Hint } from "../../../components/ui/Tooltip";
import { Wordmark } from "./Wordmark";
import { PlatformIdentity } from "../../../services/platform/PlatformIdentity";
import { shortcutLabel } from "../../../services/platform/shortcutKeys";
import { Feedback } from "./Feedback";
import { LINE_ICONS, LineIcon } from "./lineIcons";
import { shellShortcutKeys } from "./shellKeys";

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
  /** The Help button, so the panel it opens can tell a press on it from one outside. */
  helpButtonRef: RefObject<HTMLButtonElement>;
};

/** The views in header order. Chat is a name and stays as it is in every language. */
const VIEWS = [
  { distance: "zen", label: null, hint: "shell.nav.zenHint", icon: LINE_ICONS.chat },
  { distance: "fleet", label: "shell.nav.work", hint: "shell.nav.fleetHint", icon: LINE_ICONS.work },
  { distance: "memory", label: "shell.nav.memory", hint: "shell.nav.memoryHint", icon: LINE_ICONS.memory },
  { distance: "people", label: "shell.nav.people", hint: "shell.nav.peopleHint", icon: LINE_ICONS.contacts },
  { distance: "settings", label: "shell.nav.settings", hint: "shell.nav.settingsHint", icon: LINE_ICONS.settings },
] as const satisfies ReadonlyArray<{ distance: Distance; label: TextKey | null; hint: TextKey; icon: string }>;

export function InstrumentHeader({ distance, onNavigate, peopleWaiting, feedbackRequest, helper, onShip, help, onHelp, helpButtonRef }: InstrumentHeaderProps) {
  const t = useT();
  const hint = (text: string, keys: string) => `${text} · ${shortcutLabel(keys)}`;
  return (
    <header class="instrument-top instrument-header">
      <div class="instrument-identity">
        <button type="button" aria-label={t("shell.header.home")} onClick={() => onNavigate("zen")}>
          <Wordmark />
        </button>
        <Feedback view={distance} openRequest={feedbackRequest} />
        <PlatformIdentity />
        {helper && <span class="instrument-helper">{t("shell.header.helper")} · <button type="button" onClick={onShip}>{t("shell.header.backToShip")}</button></span>}
      </div>
      <nav class="instrument-tabs" aria-label={t("shell.header.views")}>
        {VIEWS.map((view) => {
          const label = view.label ? t(view.label) : "chat";
          const keys = shellShortcutKeys(view.distance);
          const waiting = view.distance === "people" && distance !== "people" && peopleWaiting;
          return (
            <Hint key={view.distance} text={hint(t(view.hint), keys)} position="bottom">
              <button type="button" aria-current={distance === view.distance ? "page" : undefined} aria-keyshortcuts={keys}
                onClick={() => onNavigate(view.distance)}>
                <LineIcon path={view.icon} size={16} />
                <span class="view-label">{label}</span>
                {waiting && <span class="instrument-people-waiting" aria-label={t("shell.header.unread")}>•</span>}
              </button>
            </Hint>
          );
        })}
        <Hint text={hint(t("shell.nav.helpHint"), shellShortcutKeys("help"))} position="bottom">
          <button type="button" ref={helpButtonRef} aria-expanded={help} aria-controls="instrument-help"
            aria-keyshortcuts={shellShortcutKeys("help")} onClick={onHelp}>
            <LineIcon path={LINE_ICONS.help} size={16} />
            <span class="view-label">{t("shell.nav.help")}</span>
          </button>
        </Hint>
      </nav>
    </header>
  );
}
