import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { ListRow } from "../../../components/ui/ListRow";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import "./DefaultsSummaryPanel.css";

/* Same row metrics as the settings/overview cards (MODELS etc.). */
const SUMMARY_ROW_STYLE: JSX.CSSProperties = {
  minHeight: "44px",
  padding: "13px 16px",
};

export interface DefaultsSummaryPanelProps {
  /** Display values — already resolved to their effective labels. */
  model: string;
  fallback: string;
  reasoning: string;
  /** Default approval action label, e.g. "ALLOW". */
  permissionsAction: string;
  overridesCount: number;
  /** null while the context listing is loading/unavailable (renders "—"). */
  contextFilesCount: number | null;
  /** Open the in-body editor on its defaults / overrides / context section. */
  onEditDefaults?: () => void;
  onConfigureOverrides?: () => void;
  onManageContext?: () => void;
  /** Narrow-panel mode: header toggles a collapsed-by-default disclosure. */
  compact?: boolean;
}

function SummaryRow({ value, field, onClick }: {
  value: string;
  field: string;
  onClick?: () => void;
}) {
  return (
    <div class="gsv-defaults-summary-row">
      <ListRow
        label={value}
        sub={field}
        status="none"
        chevron={Boolean(onClick)}
        onClick={onClick}
        style={SUMMARY_ROW_STYLE}
      />
    </div>
  );
}

/** DefaultsSummaryPanel — the viewer's default configurations as a standard
 *  settings card (the MODELS-card anatomy: compact SectionHeader + list rows
 *  with edge-to-edge rules, value as the row label, field name as the sub).
 *  Every row clicks through to the in-body editor's matching section.
 *  Reusable on the agent detail page later. */
export function DefaultsSummaryPanel({
  model,
  fallback,
  reasoning,
  permissionsAction,
  overridesCount,
  contextFilesCount,
  onEditDefaults,
  onConfigureOverrides,
  onManageContext,
  compact = false,
}: DefaultsSummaryPanelProps) {
  const [collapsed, setCollapsed] = useState(true);
  const showBody = !compact || !collapsed;
  // In compact (mobile) mode, opening a section auto-collapses the summary so the
  // in-body editor below gets the vertical space — the panel would otherwise
  // stack on top of the editor and leave too little room to see it.
  const openSection = (handler?: () => void) =>
    handler
      ? () => {
          if (compact) setCollapsed(true);
          handler();
        }
      : undefined;
  const overridesLabel = `${overridesCount} override${overridesCount === 1 ? "" : "s"}`;
  const filesLabel = contextFilesCount === null
    ? "—"
    : `${contextFilesCount} file${contextFilesCount === 1 ? "" : "s"}`;

  return (
    <section class="gsv-defaults-summary" aria-label="Defaults">
      <SectionHeader
        title="DEFAULTS"
        headingLevel={3}
        density="compact"
        divider
        meta={compact ? (collapsed ? "SHOW" : "HIDE") : undefined}
        onClick={compact ? () => setCollapsed((current) => !current) : undefined}
      />
      {showBody ? (
        <>
          <div class="gsv-defaults-summary-list">
            <SummaryRow value={model} field="MODEL" onClick={openSection(onEditDefaults)} />
            <SummaryRow value={fallback} field="FALLBACK" onClick={openSection(onEditDefaults)} />
            <SummaryRow value={reasoning} field="REASONING" onClick={openSection(onEditDefaults)} />
            <SummaryRow
              value={`${permissionsAction} (${overridesLabel})`}
              field="PERMISSIONS"
              onClick={openSection(onConfigureOverrides)}
            />
            <SummaryRow
              value={filesLabel}
              field="GLOBAL INSTRUCTIONS"
              onClick={contextFilesCount === null ? undefined : openSection(onManageContext)}
            />
          </div>
        </>
      ) : null}
    </section>
  );
}
