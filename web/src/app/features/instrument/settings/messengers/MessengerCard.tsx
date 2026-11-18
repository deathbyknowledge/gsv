import type { ComponentChildren } from "preact";
import { Surface } from "../../../../components/ui/Surface";
import { useT } from "../../../../i18n/locale";
import "./messenger-card.css";

type Props = {
  id: string;
  name: string;
  sub: string;
  icon?: ComponentChildren;
  /** The header's button label while closed; none leaves only the status. */
  action?: string;
  /** The header's button is the filled one. */
  primary?: boolean;
  /** Where the messenger stands, shown before the action. */
  status?: ComponentChildren;
  expanded: boolean;
  disabled: boolean;
  onToggle: () => void;
  /** Always shown under the header, such as the accounts already connected. */
  details?: ComponentChildren;
  /** The panel the header opens. */
  children?: ComponentChildren;
};

/**
 * One messenger as the signup screen and Settings › Messengers show it: a Surface card whose whole
 * header opens the panel attached beneath it. Only the header toggles; the panels hold their own controls.
 */
export function MessengerCard({ id, name, sub, icon, action, primary = false, status, expanded, disabled, onToggle, details, children }: Props) {
  const t = useT();
  return <section class="messenger-card" aria-label={name}>
    <Surface as="button" level={expanded ? 2 : 1} interactive={!disabled} disabled={disabled} aria-expanded={expanded}
      aria-controls={expanded ? `messenger-${id}` : undefined} onClick={onToggle}>
      <span class="messenger-card-head">
        {icon}
        <span class="messenger-card-name">{name}</span>
        <span class="messenger-card-sub gsv-prose-lead">{sub}</span>
        {expanded
          ? <span class="gsv-btn gsv-btn-link messenger-card-close">{t("settings.messengers.closeSetup")}</span>
          : <span class="messenger-card-trailing">
            {status}
            {action && <span class={`gsv-btn ${primary ? "gsv-btn-primary" : "gsv-btn-secondary"}${disabled ? " is-disabled" : ""}`}>{action}</span>}
          </span>}
      </span>
    </Surface>
    {details && <Surface>{details}</Surface>}
    {expanded && <Surface id={`messenger-${id}`} level={2}>{children}</Surface>}
  </section>;
}
