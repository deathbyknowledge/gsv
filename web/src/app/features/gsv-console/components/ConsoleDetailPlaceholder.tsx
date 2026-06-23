import { Button } from "../../../components/ui/Button";
import { Icon } from "../../../components/ui/Icon";
import { ListRow, type ListRowStatus } from "../../../components/ui/ListRow";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { StatusDot, type StatusTone } from "../../../components/ui/StatusDot";
import "./ConsoleDetailPlaceholder.css";

export type ConsoleDetailRow = {
  id: string;
  icon?: string;
  label: string;
  status?: ListRowStatus;
  statusLabel?: string;
  sub: string;
};

export type ConsoleDetailSection = {
  title: string;
  meta?: string;
  rows: readonly ConsoleDetailRow[];
};

type ConsoleDetailPlaceholderProps = {
  blurb: string;
  icon: string;
  onBack: () => void;
  onPrimary?: () => void;
  parentLabel: string;
  placeholderLabel: string;
  primaryLabel?: string;
  sections?: readonly ConsoleDetailSection[];
  statusLabel: string;
  title: string;
  tone: StatusTone;
  typeLabel: string;
};

export function ConsoleDetailPlaceholder({
  blurb,
  icon,
  onBack,
  onPrimary,
  parentLabel,
  placeholderLabel,
  primaryLabel,
  sections = [],
  statusLabel,
  title,
  tone,
  typeLabel,
}: ConsoleDetailPlaceholderProps) {
  const hasSections = sections.some((section) => section.rows.length > 0);

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

        {hasSections ? (
          <div class="gsv-console-detail-sections">
            {sections.map((section) => (
              section.rows.length > 0 ? (
                <section class="gsv-console-detail-section" key={section.title}>
                  <SectionHeader title={section.title} meta={section.meta} divider />
                  <div>
                    {section.rows.map((row) => (
                      <ListRow
                        icon={row.icon}
                        key={row.id}
                        label={row.label}
                        status={row.status ?? "none"}
                        statusDotPlacement="trailing"
                        statusLabel={row.statusLabel}
                        sub={row.sub}
                      />
                    ))}
                  </div>
                </section>
              ) : null
            ))}
          </div>
        ) : (
          <div class="gsv-console-detail-placeholder-panel">
            <span class="gsv-detail-corner is-top-left" aria-hidden="true" />
            <span class="gsv-detail-corner is-top-right" aria-hidden="true" />
            <span class="gsv-detail-corner is-bottom-left" aria-hidden="true" />
            <span class="gsv-detail-corner is-bottom-right" aria-hidden="true" />
            <span>[ {title} · {placeholderLabel} ]</span>
          </div>
        )}

        <div class="gsv-console-detail-placeholder-actions">
          {primaryLabel && onPrimary ? <Button variant="primary" label={primaryLabel} onClick={onPrimary} /> : null}
          <Button variant="secondary" label={`BACK TO ${parentLabel}`} onClick={onBack} />
        </div>
      </div>
    </section>
  );
}
