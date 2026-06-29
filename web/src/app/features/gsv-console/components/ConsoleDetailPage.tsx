import type { ComponentChildren } from "preact";
import { Button } from "../../../components/ui/Button";
import { Icon } from "../../../components/ui/Icon";
import { ListRow, type ListRowStatus } from "../../../components/ui/ListRow";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import type { StatusTone } from "../../../components/ui/StatusDot";
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
  /** Retained for callers; back navigation is now handled by the breadcrumb. */
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
  onPrimary,
  pendingLabel = "PENDING SURFACE",
  primaryLabel,
  sections = [],
  statusLabel,
  title,
}: ConsoleDetailPageProps) {
  const hasSections = sections.some((section) => section.rows.length > 0);
  const hasActions = Boolean(primaryLabel) || (actions != null && actions !== false);
  // Break the description into two lines: the trailing " · " segment (e.g.
  // "last seen 2m ago", "connected over sse") drops to a second line.
  const descSep = blurb.lastIndexOf(" · ");
  const descPrimary = descSep > 0 ? blurb.slice(0, descSep) : blurb;
  const descSecondary = descSep > 0 ? blurb.slice(descSep + 3) : "";

  return (
    <section class="gsv-console-detail-page">
      {/* Row 2 — full-width page header (title + status), like the list pages. */}
      <SectionHeader
        className="gsv-console-detail-header"
        title={title}
        meta={statusLabel}
        divider
        headingLevel={2}
      />

      {/* Row 3 — action bar: icon tile + description, with the action below.
          Back navigation lives in the breadcrumb, so there is no BACK button. */}
      <div class="gsv-console-detail-bar">
        <div class="gsv-console-detail-bar-lead">
          <span class="gsv-console-detail-icon">
            <Icon name={icon} size={30} />
          </span>
          <p class="gsv-console-detail-desc">
            {descPrimary}
            {descSecondary ? (
              <>
                <br />
                {descSecondary}
              </>
            ) : null}
          </p>
        </div>
        {hasActions ? (
          <div class="gsv-console-detail-bar-actions">
            {actions}
            {primaryLabel ? (
              <Button
                variant="primary"
                label={primaryLabel}
                disabled={!onPrimary}
                onClick={onPrimary}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      <div class="gsv-console-detail-shell">
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
        ) : null}

        {children ? (
          <div class="gsv-console-detail-custom">{children}</div>
        ) : !hasSections ? (
          <div class="gsv-console-detail-pending-panel">
            <span class="gsv-detail-corner is-top-left" aria-hidden="true" />
            <span class="gsv-detail-corner is-top-right" aria-hidden="true" />
            <span class="gsv-detail-corner is-bottom-left" aria-hidden="true" />
            <span class="gsv-detail-corner is-bottom-right" aria-hidden="true" />
            <span>[ {title} · {pendingLabel} ]</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
