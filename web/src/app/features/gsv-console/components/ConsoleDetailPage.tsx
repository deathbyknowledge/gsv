import type { ComponentChildren } from "preact";
import { Button } from "../../../components/ui/Button";
import { Icon } from "../../../components/ui/Icon";
import { ListRow, type ListRowStatus } from "../../../components/ui/ListRow";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { StatusMeta, type StatusTone } from "../../../components/ui/StatusDot";
import "./ConsoleDetailPage.css";

export type ConsoleDetailRow = {
  id: string;
  icon?: string;
  label: string;
  /** Optional "?" help tooltip explaining the row's value. */
  labelInfo?: string;
  status?: ListRowStatus;
  statusLabel?: string;
  sub: string;
};

export type ConsoleDetailSection = {
  title: string;
  meta?: string;
  /** When set, `meta` is a status word: render it tone-colored with a dot
   *  (like the page header) instead of the dim default. */
  metaTone?: StatusTone;
  rows: readonly ConsoleDetailRow[];
};

type ConsoleDetailPageProps = {
  actions?: ComponentChildren;
  blurb: string;
  children?: ComponentChildren;
  icon: string;
  /** Back navigation. For surfaces whose detail is reflected in the shell
   *  breadcrumb this is handled there (so `showBack` stays off); non-route-backed
   *  callers (e.g. the model/runtime config details) set `showBack` to render a
   *  local back control wired to this. */
  onBack: () => void;
  onPrimary?: () => void;
  parentLabel: string;
  /** Render a "← {parentLabel}" back control. Use when the shell breadcrumb does
   *  not already provide a path back to the parent list. */
  showBack?: boolean;
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
  showBack = false,
  statusLabel,
  title,
  tone,
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
      {showBack ? (
        <button type="button" class="gsv-console-detail-back gsv-sublabel" onClick={onBack}>
          <span aria-hidden="true">←</span> {parentLabel}
        </button>
      ) : null}
      {/* Row 2 — full-width page header (title + status), like the list pages.
          Status carries its tone color + dot, matching the list rows. */}
      <SectionHeader
        className="gsv-console-detail-header"
        title={title}
        divider
        headingLevel={2}
        actions={statusLabel ? <StatusMeta tone={tone} label={statusLabel} /> : undefined}
      />

      {/* Row 3 — action bar: icon tile + description, with the action below.
          Back navigation lives in the breadcrumb, so there is no BACK button. */}
      <div class="gsv-console-detail-bar">
        <div class="gsv-console-detail-bar-lead">
          <span class="gsv-console-detail-icon">
            <Icon name={icon} size={30} />
          </span>
          <p class="gsv-console-detail-desc gsv-prose">
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
                  <SectionHeader
                    title={section.title}
                    meta={section.metaTone ? undefined : section.meta}
                    actions={section.metaTone && section.meta ? (
                      <StatusMeta tone={section.metaTone} label={section.meta} />
                    ) : undefined}
                    divider
                  />
                  <div>
                    {section.rows.map((row) => (
                      <ListRow
                        icon={row.icon}
                        key={row.id}
                        label={row.label}
                        labelInfo={row.labelInfo}
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
          <div class="gsv-console-detail-pending-panel gsv-label">
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
