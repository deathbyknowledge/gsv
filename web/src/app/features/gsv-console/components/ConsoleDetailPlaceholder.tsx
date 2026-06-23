import { Button } from "../../../components/ui/Button";
import { Icon } from "../../../components/ui/Icon";
import { StatusDot, type StatusTone } from "../../../components/ui/StatusDot";
import "./ConsoleDetailPlaceholder.css";

type ConsoleDetailPlaceholderProps = {
  blurb: string;
  icon: string;
  onBack: () => void;
  parentLabel: string;
  placeholderLabel: string;
  primaryLabel: string;
  statusLabel: string;
  title: string;
  tone: StatusTone;
  typeLabel: string;
};

export function ConsoleDetailPlaceholder({
  blurb,
  icon,
  onBack,
  parentLabel,
  placeholderLabel,
  primaryLabel,
  statusLabel,
  title,
  tone,
  typeLabel,
}: ConsoleDetailPlaceholderProps) {
  return (
    <section class="gsv-console-detail-placeholder-page">
      <div class="gsv-console-detail-placeholder-shell">
        <header class="gsv-console-detail-placeholder-head">
          <span class="gsv-console-detail-placeholder-icon">
            <Icon name={icon} size={30} />
          </span>
          <div class="gsv-console-detail-placeholder-title">
            <h2>{title}</h2>
            <div>
              <span>{typeLabel}</span>
              <StatusDot tone={tone} size={7} />
              <span>{statusLabel}</span>
            </div>
          </div>
        </header>

        <p class="gsv-console-detail-placeholder-blurb">{blurb}</p>

        <div class="gsv-console-detail-placeholder-panel">
          <span class="gsv-detail-corner is-top-left" aria-hidden="true" />
          <span class="gsv-detail-corner is-top-right" aria-hidden="true" />
          <span class="gsv-detail-corner is-bottom-left" aria-hidden="true" />
          <span class="gsv-detail-corner is-bottom-right" aria-hidden="true" />
          <span>[ {title} · {placeholderLabel} ]</span>
        </div>

        <div class="gsv-console-detail-placeholder-actions">
          <Button variant="primary" label={primaryLabel} onClick={onBack} />
          <Button variant="secondary" label={`BACK TO ${parentLabel}`} onClick={onBack} />
        </div>
      </div>
    </section>
  );
}
