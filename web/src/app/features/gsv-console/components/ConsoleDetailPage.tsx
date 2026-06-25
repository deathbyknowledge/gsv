import type { ComponentChildren } from "preact";
import { Button } from "../../../components/ui/Button";
import { Icon } from "../../../components/ui/Icon";
import { ListRow, type ListRowStatus } from "../../../components/ui/ListRow";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { StatusDot, type StatusTone } from "../../../components/ui/StatusDot";
import "./ConsoleDetailPage.css";

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

type ConsoleDetailPageProps = {
  actions?: ComponentChildren;
  blurb: string;
  children?: ComponentChildren;
  icon: string;
  onBack: () => void;
  onPrimary?: () => void;
  parentLabel: string;
  pendingLabel?: string;
  primaryLabel?: string;
  sections?: readonly ConsoleDetailSection[];
  statusLabel: string;
  title: string;
  tone: StatusTone;
  typeLabel: string;
};

export function ConsoleDetailPage({
  actions,
  blurb,
  children,
  icon,
  onBack,
  onPrimary,
  parentLabel,
  pendingLabel = "PENDING SURFACE",
  primaryLabel,
  sections = [],
  statusLabel,
  title,
  tone,
  typeLabel,
}: ConsoleDetailPageProps) {
  const hasSections = sections.some((section) => section.rows.length > 0);

  return (
    <section class="gsv-console-detail-page">
      <div class="gsv-console-detail-shell">
        <header class="gsv-console-detail-head">
          <span class="gsv-console-detail-icon">
            <Icon name={icon} size={30} />
          </span>
          <div class="gsv-console-detail-title">
            <h2>{title}</h2>
            <div>
              <span>{typeLabel}</span>
              <StatusDot tone={tone} size={7} />
              <span>{statusLabel}</span>
            </div>
          </div>
        </header>

        <p class="gsv-console-detail-blurb">{blurb}</p>

        {children ? (
          <div class="gsv-console-detail-custom">{children}</div>
        ) : hasSections ? (
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
          <div class="gsv-console-detail-pending-panel">
            <span class="gsv-detail-corner is-top-left" aria-hidden="true" />
            <span class="gsv-detail-corner is-top-right" aria-hidden="true" />
            <span class="gsv-detail-corner is-bottom-left" aria-hidden="true" />
            <span class="gsv-detail-corner is-bottom-right" aria-hidden="true" />
            <span>[ {title} · {pendingLabel} ]</span>
          </div>
        )}

        <div class="gsv-console-detail-actions">
          {actions}
          {primaryLabel ? (
            <Button
              variant="primary"
              label={primaryLabel}
              disabled={!onPrimary}
              onClick={onPrimary}
            />
          ) : null}
          <Button variant="secondary" label={`BACK TO ${parentLabel}`} onClick={onBack} />
        </div>
      </div>
    </section>
  );
}
